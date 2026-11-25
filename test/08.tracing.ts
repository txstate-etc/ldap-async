import { AsyncLocalStorage } from 'node:async_hooks'
import { subscribe, tracingChannel, unsubscribe } from 'node:diagnostics_channel'
import { describe, it, before, after, beforeEach } from 'node:test'
import { expect } from 'chai'
import { EqualityFilter } from 'ldapts'
import ldap from '../src/client'
import Ldap, { type ConnectionWaitMessage, type LdapTraceContext } from '../src'
import { parseServerUrl } from '../src/tracing'

type EventName = 'start' | 'end' | 'asyncStart' | 'asyncEnd' | 'error'
interface TraceEvent { name: EventName, ctx: LdapTraceContext, store?: string }

const channel = tracingChannel<LdapTraceContext, LdapTraceContext>('ldap-async:operation')
const als = new AsyncLocalStorage<string>()
let events: TraceEvent[] = []
const record = (name: EventName) => (ctx: LdapTraceContext) => { events.push({ name, ctx, store: als.getStore() }) }
const handlers = {
  start: record('start'),
  end: record('end'),
  asyncStart: record('asyncStart'),
  asyncEnd: record('asyncEnd'),
  error: record('error')
}

const people = 'ou=people,dc=planetexpress,dc=com'
const fryDN = 'cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com'
const tracingOU = 'ou=tracing,dc=planetexpress,dc=com'

function nameOf (e: TraceEvent) {
  return e.name
}

/** stream close (and so asyncStart/asyncEnd) lands a tick after the consumer finishes */
async function tick () {
  await new Promise(resolve => setImmediate(resolve))
}

describe('tracing channel with no subscribers', () => {
  it('runs operations normally and publishes nothing', async () => {
    expect(channel.hasSubscribers).to.equal(false)
    const users = await ldap.search(people, { scope: 'sub', filter: 'objectClass=person' })
    expect(users.length).to.be.greaterThan(1)
    await ldap.setAttribute(fryDN, 'employeeType', 'Delivery boy')
    expect(events).to.have.lengthOf(0)
  })
})

describe('tracing channel with a subscriber', () => {
  before(() => { channel.subscribe(handlers) })
  after(() => { channel.unsubscribe(handlers) })
  beforeEach(() => { events = [] })

  it('publishes a search from start to close, with its entry count', async () => {
    const users = await als.run('searcher', async () => await ldap.search(people, { scope: 'sub', filter: '(objectClass=person)' }))
    expect(users.length).to.be.greaterThan(1)
    await tick()
    expect(events.map(nameOf)).to.deep.equal(['start', 'end', 'asyncStart', 'asyncEnd'])
    const ctx = events[0].ctx
    for (const e of events) expect(e.ctx).to.equal(ctx)
    expect(events[0].store).to.equal('searcher')
    expect(ctx).to.deep.include({ operation: 'search', dn: people, filter: '(objectClass=person)', scope: 'sub', entries: users.length })
    expect(ctx.error).to.equal(undefined)
  })

  it('fills in the server from the url', async () => {
    await ldap.get(fryDN)
    await tick()
    // docker-compose sets LDAP_HOST and LDAP_PORT
    expect(events[0].ctx.serverAddress).to.equal('openldap')
    expect(events[0].ctx.serverPort).to.equal(10389)
  })

  it('publishes ldapts\'s defaults when no scope or filter is given', async () => {
    await ldap.search(people)
    await tick()
    expect(events[0].ctx).to.deep.include({ filter: '(objectclass=*)', scope: 'sub' })
  })

  it('publishes a Filter object as its string form', async () => {
    await ldap.search(people, { scope: 'sub', filter: new EqualityFilter({ attribute: 'givenName', value: 'Hubert' }) })
    await tick()
    expect(events[0].ctx.filter).to.equal('(givenName=Hubert)')
    expect(events[0].ctx.entries).to.equal(1)
  })

  it('publishes a search that the consumer abandons early, without an error', async () => {
    const iterator = ldap.stream(people, { scope: 'sub', filter: 'objectClass=person' })[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value?.dn).to.be.a('string')
    await iterator.return()
    await tick()
    expect(events.map(nameOf)).to.deep.equal(['start', 'end', 'asyncStart', 'asyncEnd'])
    expect(events[0].ctx.error).to.equal(undefined)
  })

  it('publishes a search error, the same object the caller sees', async () => {
    let caught: any
    try {
      await ldap.get('ou=nowhere,dc=planetexpress,dc=com')
      expect.fail('should have thrown')
    } catch (e: any) {
      caught = e
    }
    await tick()
    expect(events.map(nameOf)).to.deep.equal(['start', 'end', 'error', 'asyncStart', 'asyncEnd'])
    expect(events[0].ctx.error).to.equal(caught)
    expect(caught.code).to.equal(32) // noSuchObject
    // the stack rewriting still happened before publishing
    expect(caught.stack).to.include('08.tracing')
  })

  it('publishes a modify', async () => {
    await als.run('modifier', async () => { await ldap.setAttribute(fryDN, 'employeeType', 'Delivery boy') })
    expect(events.map(nameOf)).to.deep.equal(['start', 'end', 'asyncStart', 'asyncEnd'])
    expect(events[0].store).to.equal('modifier')
    expect(events[0].ctx).to.deep.include({ operation: 'modify', dn: fryDN, serverAddress: 'openldap', serverPort: 10389 })
  })

  it('publishes each round trip of a helper that makes several', async () => {
    await ldap.pushAttribute(fryDN, 'employeeType', 'Cryogenic sleeper')
    await ldap.pullAttribute(fryDN, 'employeeType', 'Cryogenic sleeper')
    await tick()
    const operations = events.filter(e => e.name === 'start').map(e => e.ctx.operation)
    expect(operations).to.deep.equal(['search', 'modify', 'search', 'modify'])
  })

  it('publishes add, modifyDN and delete', async () => {
    const renamed = 'ou=tracing2,dc=planetexpress,dc=com'
    await ldap.add(tracingOU, { objectClass: ['organizationalUnit'], ou: 'tracing' })
    await ldap.modifyDN(tracingOU, 'ou=tracing2')
    await ldap.remove(renamed)
    const starts = events.filter(e => e.name === 'start').map(e => e.ctx)
    expect(starts).to.have.lengthOf(3)
    expect(starts[0]).to.deep.include({ operation: 'add', dn: tracingOU })
    expect(starts[1]).to.deep.include({ operation: 'modifyDN', dn: tracingOU, newDn: 'ou=tracing2' })
    expect(starts[2]).to.deep.include({ operation: 'delete', dn: renamed })
  })

  it('publishes a write error, the same object the caller sees', async () => {
    let caught: any
    try {
      await ldap.setAttribute('cn=Nobody,ou=people,dc=planetexpress,dc=com', 'employeeType', 'Ghost')
      expect.fail('should have thrown')
    } catch (e: any) {
      caught = e
    }
    expect(events.map(nameOf)).to.deep.equal(['start', 'end', 'error', 'asyncStart', 'asyncEnd'])
    expect(events[0].ctx.error).to.equal(caught)
    expect(caught.code).to.equal(32)
  })

  it('publishes a failure to connect as the operation\'s error', async () => {
    const unreachable = new Ldap({ host: 'localhost', port: 1 })
    try {
      await unreachable.search(people)
      expect.fail('should have thrown')
    } catch (e: any) {
      expect(e.code).to.equal('ECONNREFUSED')
    } finally {
      await unreachable.close()
    }
    await tick()
    expect(events.map(nameOf)).to.deep.equal(['start', 'end', 'error', 'asyncStart', 'asyncEnd'])
    expect(events[0].ctx).to.deep.include({ serverAddress: 'localhost', serverPort: 1 })
    expect(events[0].ctx.error?.code).to.equal('ECONNREFUSED')
  })
})

describe('connection wait channel', () => {
  let waits: ConnectionWaitMessage[] = []
  const onWait = (msg: unknown) => { waits.push(msg as ConnectionWaitMessage) }
  before(() => { subscribe('ldap-async:connection:wait', onWait) })
  after(() => { unsubscribe('ldap-async:connection:wait', onWait) })
  beforeEach(() => { waits = [] })

  it('publishes a wait for every operation, named after the server', async () => {
    await ldap.get(fryDN)
    await ldap.setAttribute(fryDN, 'employeeType', 'Delivery boy')
    expect(waits).to.have.lengthOf(2)
    expect(waits[0]).to.deep.include({ poolName: 'openldap:10389', serverAddress: 'openldap', serverPort: 10389 })
    expect(waits[0].duration).to.be.a('number').and.at.least(0)
  })

  it('includes time spent in line for a busy pool, and opening a new connection', async () => {
    const tiny = new Ldap({ poolSize: 1 })
    try {
      const [, second] = await Promise.all([
        tiny.search(people, { scope: 'sub', filter: 'objectClass=person' }),
        tiny.get(fryDN)
      ])
      expect(second.dn).to.equal(fryDN)
    } finally {
      await tiny.close()
    }
    expect(waits).to.have.lengthOf(2)
    // the first had to connect and bind, the second waited for the first to finish its search
    expect(waits[0].duration).to.be.greaterThan(0)
    expect(waits[1].duration).to.be.greaterThan(waits[0].duration)
  })

  it('publishes nothing for an operation that never gets a connection', async () => {
    const unreachable = new Ldap({ host: 'localhost', port: 1 })
    try {
      await unreachable.get(fryDN)
    } catch {
      // expected
    } finally {
      await unreachable.close()
    }
    expect(waits).to.have.lengthOf(0)
  })
})

describe('parseServerUrl', () => {
  it('fills in the default port for each protocol', () => {
    expect(parseServerUrl('ldap://example.edu')).to.deep.equal({ serverAddress: 'example.edu', serverPort: 389 })
    expect(parseServerUrl('ldaps://example.edu')).to.deep.equal({ serverAddress: 'example.edu', serverPort: 636 })
    expect(parseServerUrl('ldaps://example.edu:3269')).to.deep.equal({ serverAddress: 'example.edu', serverPort: 3269 })
  })
  it('strips the brackets from an IPv6 address', () => {
    expect(parseServerUrl('ldap://[::1]:10389')).to.deep.equal({ serverAddress: '::1', serverPort: 10389 })
  })
  it('gives up quietly on something it can\'t parse', () => {
    expect(parseServerUrl('not a url')).to.deep.equal({})
    expect(parseServerUrl(undefined)).to.deep.equal({})
  })
})
