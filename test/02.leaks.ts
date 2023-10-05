/* eslint-disable @typescript-eslint/no-unused-expressions */
/* global describe, it */
import { expect } from 'chai'
import ldap from '../src/client'

const reps = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

describe('connection leak tests', () => {
  it('should not leak connections for basic queries', async () => {
    await Promise.all(reps.map(async () => {
      await ldap.get('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com')
    }))
    expect((ldap as any).clients).to.have.lengthOf(5)
    for (const c of (ldap as any).clients) {
      expect(c.busy).to.not.be.true
    }
  })
  it('should not leak connections for setAttribute actions', async () => {
    await Promise.all(reps.map(async () => {
      await ldap.setAttribute('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com', 'description', 'Human')
    }))
    expect((ldap as any).clients).to.have.lengthOf(5)
    for (const c of (ldap as any).clients) {
      expect(c.busy).to.not.be.true
    }
  })
  it('should not leak connections for add actions', async () => {
    await Promise.all(reps.map(async (i) => {
      await ldap.add(`cn=test_group${i},ou=people,dc=planetexpress,dc=com`, {
        objectclass: ['Group', 'top'],
        groupType: '2147483650',
        cn: 'test_group' + String(i)
      })
    }))
    expect((ldap as any).clients).to.have.lengthOf(5)
    for (const c of (ldap as any).clients) {
      expect(c.busy).to.not.be.true
    }
  })
  it('should not leak a connection when a query has a syntax error', async () => {
    try {
      const user = await ldap.get<{ givenName: string }>('ou=people,dc=planetexpress,dc=com', {
        scope: 'sub',
        filter: '(&(objectClass=person)(=Hubert)'
      })
      expect(true, 'should not have gotten this far').to.be.false
    } catch (e: any) {
      expect(e.message).to.contain('invalid attribute')
    }
    for (const c of (ldap as any).clients) {
      expect(c.busy).to.not.be.true
    }
  })
  it('should not leak connections when multiple pages are being used', async () => {
    await Promise.all(reps.map(async (i) => {
      await ldap.search('ou=people,dc=planetexpress,dc=com', {
        scope: 'sub',
        filter: 'objectclass=person',
        paged: { pageSize: 2 }
      })
    }))
    for (const c of (ldap as any).clients) {
      expect(c.busy).to.not.be.true
    }
  })
  it('should not leak connections when multiple pages are being used and we cancel the stream', async () => {
    await Promise.all(reps.map(async (i) => {
      const stream = ldap.stream('ou=people,dc=planetexpress,dc=com', {
        scope: 'sub',
        filter: 'objectclass=person',
        paged: { pageSize: 2 }
      })
      let count = 0
      for await (const user of stream) {
        if (count++ > 3) {
          stream.destroy()
          break
        }
      }
      expect(count).to.be.greaterThan(3)
    }))
    await new Promise(resolve => setTimeout(resolve, 250))
    for (const c of (ldap as any).clients) {
      expect(c.busy).to.not.be.true
    }
  })
  it('should not leak connections when multiple pages are being used and we throw an error', async () => {
    try {
      await Promise.all(reps.map(async (i) => {
        const stream = ldap.stream('ou=people,dc=planetexpress,dc=com', {
          scope: 'sub',
          filter: 'objectclass=person',
          paged: { pageSize: 2 }
        })
        let count = 0
        for await (const user of stream) {
          count++
          if (count > 3) throw new Error('fail!')
        }
        expect(count).to.be.greaterThan(3)
      }))
    } catch (e: any) {
      expect(e.message).to.equal('fail!')
    }
    // allow some time for all the promises to finish
    await new Promise(resolve => setTimeout(resolve, 400))
    for (const c of (ldap as any).clients) {
      expect(c.busy).to.not.be.true
    }
  })
})
