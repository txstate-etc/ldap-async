import { describe, it } from 'node:test'
import { expect } from 'chai'
import ldap from '../src/client'
import { AndFilter, EqualityFilter } from 'ldapts'
import Ldap from '../src'

describe('basic tests', () => {
  it('should be able to search for all users', async () => {
    const users = await ldap.search('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: 'objectClass=person'
    })
    expect(users).to.have.lengthOf(7)
  })
  it('should be able to search for a single user', async () => {
    const user = await ldap.get<{ dn: string, givenName: string }>('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: '(&(objectClass=person)(givenName=Hubert))'
    })
    expect(user.one('givenName')).to.equal('Hubert')
    expect(user.one('dn')).to.equal('cn=Hubert J. Farnsworth,ou=people,dc=planetexpress,dc=com')
    expect(user.all('dn')).to.deep.equal(['cn=Hubert J. Farnsworth,ou=people,dc=planetexpress,dc=com'])
    expect(user.pojo().dn).to.equal('cn=Hubert J. Farnsworth,ou=people,dc=planetexpress,dc=com')
  })
  it('should be able to search for a single user with the Filters API', async () => {
    const user = await ldap.get<{ givenName: string }>('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: new AndFilter({
        filters: [
          new EqualityFilter({ attribute: 'objectClass', value: 'person' }),
          new EqualityFilter({ attribute: 'givenName', value: 'Hubert' })
        ]
      })
    })
    expect(user.one('givenName')).to.equal('Hubert')
  })
  it('should be able to retrieve a single person by DN', async () => {
    const user = await ldap.get<{ givenName: string }>('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com')
    expect(user.one('givenName')).to.equal('Philip')
  })
  it('should be able to search for all groups', async () => {
    const groups = await ldap.search('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: 'objectClass=group'
    })
    expect(groups).to.have.lengthOf(2)
  })
  it('should be able to get all members of multiple groups', async () => {
    const groups = await ldap.search('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: 'objectClass=group'
    })
    const members = await Promise.all(groups.map(async g => await g.fullRange('member')))
    for (const m of members) expect(m.length).to.be.greaterThan(0)
  })
  it('should be able to stream the response', async () => {
    const stream = ldap.stream('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: 'objectClass=person'
    })
    const users = []
    for await (const user of stream) users.push(user)
    expect(users).to.have.lengthOf(7)
  })
  it('should be able to stream the response with a small page size', async () => {
    const stream = ldap.stream('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: 'objectClass=person',
      paged: { pageSize: 2 }
    })
    const users = []
    for await (const user of stream) users.push(user)
    expect(users).to.have.lengthOf(7)
  })
  it('simultaneous queries should expand the client pool', async () => {
    expect((ldap as any).clients).to.have.lengthOf(1)
    const promises = []
    for (let i = 0; i < 5; i++) {
      promises.push(ldap.search('ou=people,dc=planetexpress,dc=com', {
        scope: 'sub',
        filter: 'objectClass=person'
      }))
    }
    await Promise.all(promises)
    expect((ldap as any).clients).to.have.lengthOf(5)
  })
  it('should be able to JSON.stringify an entry and preserve the server-side casing', async () => {
    const user = await ldap.get<{ givenname: string, jpegphoto: string }>('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com', { attributes: ['givenName', 'jpegphoto'] })
    const jsonObj = user.toJSON()
    expect(jsonObj.givenname).to.equal('Philip')
    expect(jsonObj.jpegphoto.length).to.be.greaterThan(0)
    expect(Buffer.isBuffer(jsonObj.jpegphoto)).to.be.false
    expect(Buffer.from(jsonObj.jpegphoto, 'base64').length).to.be.greaterThan(0)
  })
  it('should JSON.stringify with lower case attributes if configured', async () => {
    const lcClient = new Ldap({ preserveAttributeCase: true })
    const user = await lcClient.get<{ givenName: string, jpegPhoto: string }>('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com', { attributes: ['givenName', 'jpegPhoto'] })
    const jsonObj = user.toJSON()
    expect(jsonObj.givenName).to.equal('Philip')
    expect(jsonObj.jpegPhoto.length).to.be.greaterThan(0)
    expect(Buffer.isBuffer(jsonObj.jpegPhoto)).to.be.false
    expect(Buffer.from(jsonObj.jpegPhoto, 'base64').length).to.be.greaterThan(0)
    await lcClient.close()
  })
  it('should close idle connections after the idle timeout', async () => {
    const timeoutClient = new Ldap({ idleTimeoutSeconds: 0.25 })
    await Promise.all([
      timeoutClient.get('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com'),
      timeoutClient.get('cn=Hermes Conrad,ou=people,dc=planetexpress,dc=com'),
      timeoutClient.get('cn=Turanga Leela,ou=people,dc=planetexpress,dc=com')
    ])
    expect((timeoutClient as any).clients).to.have.lengthOf(3)
    await new Promise(resolve => setTimeout(resolve, 400))
    expect((timeoutClient as any).clients).to.have.lengthOf(0)
  })
  it('should not crash when trying to set keepalive on connections', async () => {
    const keepaliveClient = new Ldap({ keepaliveSeconds: 5 })
    await keepaliveClient.get('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com')
    expect((keepaliveClient as any).clients).to.have.lengthOf(1)
    await keepaliveClient.close()
  })
  it('should reject every queued request instead of hanging when connections fail', async () => {
    const badClient = new Ldap({ poolSize: 1, bindCredentials: 'wrongpassword' } as any)
    const results = await Promise.race([
      Promise.allSettled([
        badClient.get('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com'),
        badClient.get('cn=Hermes Conrad,ou=people,dc=planetexpress,dc=com'),
        badClient.get('cn=Turanga Leela,ou=people,dc=planetexpress,dc=com')
      ]),
      new Promise<'timeout'>(resolve => setTimeout(() => { resolve('timeout') }, 2000))
    ])
    expect(results).not.to.equal('timeout')
    expect((results as PromiseSettledResult<any>[]).every(r => r.status === 'rejected')).to.be.true
    expect((badClient as any).clients).to.have.lengthOf(0)
    await badClient.close()
  })
  it('should rebind a pooled connection that reconnected without authenticating', async () => {
    const rebindClient = new Ldap({ poolSize: 1 })
    await rebindClient.get('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com')
    const client = (rebindClient as any).clients[0]
    // drop the connection, then let ldapts transparently reconnect it anonymously
    await client.unbind()
    await client.search('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com', { scope: 'base' }).catch(() => {})
    expect(client.isConnected).to.be.true
    expect(client.isBound).to.be.false
    await rebindClient.get('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com')
    expect(client.isBound).to.be.true
    await rebindClient.close()
  })
  it('should be able to manipulate entries as they are retrieved', async () => {
    const transformClient = new Ldap({
      transformEntries: entry => {
        if (entry.get('cn') === 'Bender Bending Rodriguez') {
          entry.set('customAttribute', 'Custom Value')
        }
      },
      preserveAttributeCase: true
    })
    try {
      const bender = await transformClient.get('cn=Bender Bending Rodriguez,ou=people,dc=planetexpress,dc=com')
      expect(bender.one('customAttribute')).to.equal('Custom Value')
      expect(bender.toJSON().customAttribute).to.equal('Custom Value')
      const fry = await transformClient.get('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com')
      expect(fry.one('customAttribute')).to.be.undefined
      expect(fry.toJSON().customAttribute).to.be.undefined
    } finally {
      await transformClient.close()
    }
  })
})
