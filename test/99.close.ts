import ldap from '../src/client'

describe('close', () => {
  it('should close all the connections so that mocha can exit', async () => {
    await ldap.close()
  })
})
