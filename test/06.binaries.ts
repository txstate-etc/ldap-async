/* eslint-disable @typescript-eslint/no-unused-expressions */
/* global describe, it */
import { expect } from 'chai'
import ldap from '../src/client'
import sizeOf from 'image-size'

describe('binary tests', () => {
  it('should get mangled binary data without using _raw', async () => {
    const user = await ldap.get<{ jpegPhoto: string }>('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com')
    try {
      sizeOf(Buffer.from(user.one('jpegPhoto')!, 'binary'))
      expect.fail('Should have errored on photo data.')
    } catch (e: any) {
      expect(e.message).to.contain('unsupported')
    }
  })

  it('should get good binary data', async () => {
    const user = await ldap.get<{ jpegPhoto: string }>('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com', { attributes: ['jpegPhoto;range=0-10'] })
    const dim = sizeOf(user.binary('jpegPhoto')!)
    expect(dim.width).to.equal(429)
    expect(user.options('jpegPhoto')).to.deep.equal(['binary'])
    expect(user.isBinary('jpegPhoto')).to.be.true
  })
})
