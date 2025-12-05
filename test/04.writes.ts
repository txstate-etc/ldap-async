/* eslint-disable @typescript-eslint/no-unused-expressions */
/* global describe, it */
import { expect } from 'chai'
import { UndefinedAttributeTypeError } from 'ldapjs'
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
    expect(Object.keys(after)).not.to.include('employeeType')
  })
  it('should be able to delete an attribute with removeAttribute', async () => {
    await ldap.removeAttribute(amyDN, 'employeeType')
    const after = await ldap.get(amyDN)
    expect(Object.keys(after)).not.to.include('employeeType')
  })
  it('should throw an error when trying to set an attribute that is not in the schema', async () => {
    try {
      await ldap.setAttribute(fryDN, 'randomAttrThatDoesntExist', 'Not sure if...')
      expect.fail('should have thrown')
    } catch (e: any) {
      expect(e).to.be.an.instanceOf(UndefinedAttributeTypeError)
      expect(e.message).not.to.be.undefined
    }
  })
  it('should be able to modify multiple attributes at once', async () => {
    await ldap.modify(fryDN, [
      { operation: 'replace', modification: { description: 'Human-ish' } },
      { operation: 'replace', modification: { givenName: 'Filip' } }
    ])
    const after = await ldap.get(fryDN)
    expect(after.description).to.equal('Human-ish')
    expect(after.givenName).to.equal('Filip')
    await ldap.setAttributes(fryDN, {
      description: 'Human',
      givenName: 'Philip'
    })
    const final = await ldap.get(fryDN)
    expect(final.description).to.equal('Human')
    expect(final.givenName).to.equal('Philip')
  })
  it('should be able to rename an object', async () => {
    await ldap.modifyDN('cn=Bender Bending Rodriguez,ou=people,dc=planetexpress,dc=com', 'cn=Bender Bending Rodrígo')
    const after = await ldap.get('cn=Bender Bending Rodrígo,ou=people,dc=planetexpress,dc=com')
    expect(after.cn).to.equal('Bender Bending Rodrígo')
  })
})
