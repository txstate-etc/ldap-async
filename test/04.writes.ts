/* eslint-disable @typescript-eslint/no-unused-expressions */
/* global describe, it */
import { expect } from 'chai'
import ldap from '../src/client'

const fryDN = 'cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com'
const amyDN = 'cn=Amy Wong+sn=Kroker,ou=people,dc=planetexpress,dc=com'

describe('write tests', () => {
  it('should be able to replace an attribute that already exists on the target', async () => {
    const before = await ldap.get(fryDN)
    expect(before.employeeType).to.equal('Delivery boy')
    await ldap.setAttribute(fryDN, 'employeeType', 'Cursed delivery boy')
    const after = await ldap.get(fryDN)
    expect(after.employeeType).to.equal('Cursed delivery boy')
  })
  it('should be able to set an attribute that does not exist yet on the target', async () => {
    const before = await ldap.get(amyDN)
    expect(before.employeeType).to.be.undefined
    await ldap.setAttribute(amyDN, 'employeeType', 'Hangin around')
    const after = await ldap.get(amyDN)
    expect(after.employeeType).to.equal('Hangin around')
  })
  it('should be able to delete an attribute', async () => {
    await ldap.setAttribute(fryDN, 'employeeType', undefined)
    const after = await ldap.get(fryDN)
    expect(Object.keys(after)).to.not.include('employeeType')
  })
})
