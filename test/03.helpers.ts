/* global describe, it */
import { expect } from 'chai'
import ldap from '../src/client'

describe('helper tests', () => {
  it('should properly escape strings in queries with use of ldap.filter function', async () => {
    const injection = await ldap.search('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: `givenName=${'H*'}`
    })
    expect(injection).to.have.lengthOf(2)
    const safe = await ldap.search('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: ldap.filter`givenName=${'H*'}`
    })
    expect(safe).to.have.lengthOf(0)
  })
  it('should be able to search for multiple entries using the "in" helper', async () => {
    const users = await ldap.search('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: ldap.in(['Hubert', 'Philip'], 'givenName')
    })
    expect(users).to.have.lengthOf(2)
  })
  it('should be able to search for multiple entries using the "any" helper', async () => {
    const users = await ldap.search('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: ldap.any({ givenName: 'Hubert', description: 'Mutant' })
    })
    expect(users).to.have.lengthOf(2)
  })
  it('should be able to search for multiple entries using the "all" helper', async () => {
    const users = await ldap.search('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: ldap.all({ givenName: 'Hubert', employeeType: 'Owner' })
    })
    expect(users).to.have.lengthOf(1)
    const nousers = await ldap.search('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: ldap.all({ givenName: 'Hubert', description: 'Mutant' })
    })
    expect(nousers).to.have.lengthOf(0)
  })
  it('should be able to search for multiple entries using the "anyall" helper', async () => {
    const users = await ldap.search('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: ldap.anyall([{ givenName: 'Hubert', description: 'Human' }, { description: 'Mutant' }])
    })
    expect(users).to.have.lengthOf(2)
  })
  it('should allow wildcards in "all", only when requested', async () => {
    const users = await ldap.search('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: ldap.all({ givenName: 'H*', description: 'Human' }, true)
    })
    expect(users).to.have.lengthOf(2)
    const nousers = await ldap.search('ou=people,dc=planetexpress,dc=com', {
      scope: 'sub',
      filter: ldap.all({ givenName: 'H*', description: 'Human' })
    })
    expect(nousers).to.have.lengthOf(0)
  })
})
