/* global describe, it */
import { expect } from 'chai'
import ldap from '../src/client'

describe('basic tests', () => {
  it('should be able to search for all users', async () => {
    const users = await ldap.search('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: 'objectClass=person'
    })
    expect(users).to.have.lengthOf(7)
  })
  it('should be able to search for a single user', async () => {
    const user = await ldap.get<{ givenName: string }>('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: '(&(objectClass=person)(givenName=Hubert))'
    })
    expect(user.givenName).to.equal('Hubert')
  })
  it('should be able to retrieve a single person by DN', async () => {
    const user = await ldap.get<{ givenName: string }>('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com')
    expect(user.givenName).to.equal('Philip')
  })
  it('should be able to search for all groups', async () => {
    const users = await ldap.search('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: 'objectClass=group'
    })
    expect(users).to.have.lengthOf(2)
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
})
