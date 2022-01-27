/* global describe, it */
import { expect } from 'chai'
import ldap from '../src/client'
import sizeOf from 'image-size'

describe('binary tests', () => {
  it('should get mangled binary data without using _raw', async () => {
    const user = await ldap.get<{ jpegPhoto: string }>('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com')
    try {
      sizeOf(Buffer.from(user.jpegPhoto))
      expect.fail('Should have errored on photo data.')
    } catch (e: any) {
      expect(e.message).to.contain('unsupported')
    }
  })

  it('should get good binary data when using _raw', async () => {
    const user = await ldap.get<{ _raw: { jpegPhoto: string } }>('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com')
    const dim = sizeOf(Buffer.from(user._raw.jpegPhoto))
    expect(dim.width).to.equal(429)
  })
})
