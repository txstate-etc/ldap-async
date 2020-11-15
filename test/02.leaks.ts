/* eslint-disable @typescript-eslint/no-unused-expressions */
/* global describe, it */
import { expect } from 'chai'
import ldap from '../src/client'

const reps = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

describe('basic tests', () => {
  it('should not leak connections for basic queries', async () => {
    await Promise.all(reps.map(async () => {
      await ldap.get('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com')
    }))
    expect((ldap as any).clients).to.have.lengthOf(5)
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
        if (count++ > 3) stream.destroy()
      }
      expect(count).to.be.greaterThan(3)
    }))
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
    } catch (e) {
      expect(e.message).to.equal('fail!')
    }
    // allow some time for all the promises to finish
    await new Promise(resolve => setTimeout(resolve, 400))
    for (const c of (ldap as any).clients) {
      expect(c.busy).to.not.be.true
    }
  })
})
