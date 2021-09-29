/* eslint-disable @typescript-eslint/no-unused-expressions */
/* global describe, it */
import { expect } from 'chai'
import { UndefinedAttributeTypeError } from 'ldapjs'
import ldap from '../src/client'

const fryDN = 'cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com'
const amyDN = 'cn=Amy Wong+sn=Kroker,ou=people,dc=planetexpress,dc=com'
const crewDN = 'cn=ship_crew,ou=people,dc=planetexpress,dc=com'
const testGrpDN = 'cn=test_group,ou=people,dc=planetexpress,dc=com'

describe('group membership tests', () => {
  it('should be able to add a member to a group', async () => {
    const before = await ldap.get(crewDN)
    console.log(before)
    expect(before.member).not.to.include(amyDN)
    await ldap.addMember(amyDN, crewDN)
    const after = await ldap.get(crewDN)
    expect(after.member).to.include(amyDN)
  })
  it('should bnot throw an error if we add a member to a group when they are already a member', async () => {
    await ldap.addMember(amyDN, crewDN)
    const after = await ldap.get(crewDN)
    expect(after.member).to.include(amyDN)
  })
  it('should be able to remove a member from a group', async () => {
    await ldap.removeMember(amyDN, crewDN)
    const after = await ldap.get(crewDN)
    expect(after.member).not.to.include(amyDN)
  })
  it('should not throw an error if we remove a member from a group when they are not a member', async () => {
    await ldap.removeMember(amyDN, crewDN)
    const after = await ldap.get(crewDN)
    expect(after.member).not.to.include(amyDN)
  })
  it('should be able to add a new group to the system', async () => {
    await ldap.add(testGrpDN, {
      objectclass: ['Group', 'top'],
      groupType: '2147483650',
      cn: 'test_group'
    })
    const after = await ldap.get(testGrpDN)
    expect(after.cn).to.equal('test_group')
  })
  it('should be able to add a new member to the new test group', async () => {
    await ldap.addMember(fryDN, testGrpDN)
    const after = await ldap.get(testGrpDN)
    expect(after.member).to.include(fryDN)
  })
})
