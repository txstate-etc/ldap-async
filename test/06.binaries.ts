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
    const user = await ldap.get<{ jpegPhoto: string }>('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com')
    const photo = user.attrs.get('jpegphoto')!.values[0]
    const dim = sizeOf(user.binary('jpegPhoto')!)
    expect(dim.width).to.equal(429)
    expect(user.isBinary('jpegPhoto')).to.be.true
  })

  it('should get base64 encoded binary data using the `.one()` method and in `.toJSON()`', async () => {
    const user = await ldap.get<{ jpegphoto: string }>('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com')
    const photoB64 = user.one('jpegPhoto')!
    const dim = sizeOf(Buffer.from(photoB64, 'base64'))
    expect(dim.width).to.equal(429)
    const json = user.toJSON()
    const dim2 = sizeOf(Buffer.from(json.jpegphoto, 'base64'))
    expect(dim2.width).to.equal(429)
  })

  it('should be able to set binary data with setAttribute', async () => {
    const fry = await ldap.get('cn=Philip J. Fry,ou=people,dc=planetexpress,dc=com')
    await ldap.setAttribute('cn=Hermes Conrad,ou=people,dc=planetexpress,dc=com', 'jpegPhoto', fry.binary('jpegPhoto'))
    const hermes = await ldap.get('cn=Hermes Conrad,ou=people,dc=planetexpress,dc=com')
    const dim = sizeOf(hermes.binary('jpegPhoto')!)
    expect(hermes.isBinary('jpegPhoto')).to.be.true
    expect(dim.width).to.equal(429)
  })
})
