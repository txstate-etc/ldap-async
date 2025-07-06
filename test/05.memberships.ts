/* eslint-disable @typescript-eslint/no-unused-expressions */
/* global describe, it */
import { expect } from 'chai'
import ldap from '../src/client'
import { type LdapEntry } from '../src'

const fryDN = 'cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com'
const amyDN = 'cn=Amy Wong+sn=Kroker,ou=people,dc=planetexpress,dc=com'
const crewDN = 'cn=ship_crew,ou=people,dc=planetexpress,dc=com'
const testGrpDN = 'cn=test_group,ou=people,dc=planetexpress,dc=com'

describe('group membership tests', () => {
  it('should be able to add a member to a group', async () => {
    const before = await ldap.get(crewDN)
    expect(before.all('member')).not.to.include(amyDN)
    await ldap.addMember(amyDN, crewDN)
    const after = await ldap.get(crewDN)
    expect(after.all('member')).to.include(amyDN)
  })
  it('should bnot throw an error if we add a member to a group when they are already a member', async () => {
    await ldap.addMember(amyDN, crewDN)
    const after = await ldap.get(crewDN)
    expect(after.all('member')).to.include(amyDN)
  })
  it('should be able to remove a member from a group', async () => {
    await ldap.removeMember(amyDN, crewDN)
    const after = await ldap.get(crewDN)
    expect(after.all('member')?.length).to.be.greaterThan(0)
    expect(after.all('member')).not.to.include(amyDN)
  })
  it('should not throw an error if we remove a member from a group when they are not a member', async () => {
    await ldap.removeMember(amyDN, crewDN)
    const after = await ldap.get(crewDN)
    expect(after.all('member')).not.to.include(amyDN)
  })
  it('should be able to add a new group to the system', async () => {
    await ldap.add(testGrpDN, {
      objectclass: ['Group', 'top'],
      groupType: '2147483650',
      cn: 'test_group'
    })
    const after = await ldap.get(testGrpDN)
    expect(after.one('cn')).to.equal('test_group')
  })
  it('should be able to add a new member to the new test group', async () => {
    await ldap.addMember(fryDN, testGrpDN)
    const after = await ldap.get(testGrpDN)
    expect(after.all('member')).to.include(fryDN)
  })
  it('should be able to add and remove a second member to/from the group', async () => {
    await ldap.addMember(amyDN, testGrpDN)
    const afterAdd = await ldap.get(testGrpDN)
    expect(afterAdd.all('member')).to.include(amyDN)
    await ldap.removeMember(amyDN, testGrpDN)
    const afterRemove = await ldap.get(testGrpDN)
    expect(afterRemove.all('member')).not.to.include(amyDN)
  })
  it('should be able to remove the last member from a group', async () => {
    await ldap.removeMember(fryDN, testGrpDN)
    const after = await ldap.get(testGrpDN)
    expect(after.all('member')).to.have.lengthOf(0)
  })
  it('should be able to add a group to a group', async () => {
    await ldap.pushAttribute('cn=ship_crew,ou=people,dc=planetexpress,dc=com', 'member', 'cn=service_staff,ou=people,dc=planetexpress,dc=com')
    const group = await ldap.get('cn=ship_crew,ou=people,dc=planetexpress,dc=com')
    expect(group.all('member')).to.include('cn=service_staff,ou=people,dc=planetexpress,dc=com')
  })
  it('should be able to stream members of a group', async () => {
    const strm = ldap.getMemberStream('cn=ship_crew,ou=people,dc=planetexpress,dc=com')
    const members: LdapEntry[] = []
    for await (const m of strm) {
      members.push(m)
    }
    expect(members.map(m => m.one('givenname'))).to.include('Scruffy')
    expect(members.map(m => m.one('givenname'))).to.include('Leela')
    expect(members.map(m => m.one('givenname'))).to.include('Philip')
    expect(members.map(m => m.one('givenname'))).to.include('Bender')
    expect(members).to.have.lengthOf(4)
  })
  it('should be able to stream members of a group with attributes', async () => {
    const strm = ldap.getMemberStream('cn=ship_crew,ou=people,dc=planetexpress,dc=com', ['givenName', 'sn'])
    const members: LdapEntry[] = []
    for await (const m of strm) {
      members.push(m)
    }
    expect(members.map(m => m.one('givenname'))).to.include('Scruffy')
    expect(members.map(m => m.one('sn'))).to.include('Scruffington')
    expect(members.map(m => m.one('givenname'))).to.include('Leela')
    expect(members.map(m => m.one('sn'))).to.include('Turanga')
    expect(members.map(m => m.one('givenname'))).to.include('Philip')
    expect(members.map(m => m.one('sn'))).to.include('Fry')
    expect(members.map(m => m.one('givenname'))).to.include('Bender')
    expect(members.map(m => m.one('sn'))).to.include('Rodriguez')
    expect(members).to.have.lengthOf(4)
    expect(members.map(m => m.one('employeeType'))).to.deep.equal([undefined, undefined, undefined, undefined])
  })
})
