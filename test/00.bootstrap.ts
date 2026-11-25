import { before, after } from 'node:test'
import ldap from '../src/client'

before(async () => {
  // the openldap container takes a few seconds to start accepting connections
  for (let i = 0; i < 30; i++) {
    try {
      await ldap.setAttribute('cn=Bender Bending Rodriguez,ou=people,dc=planetexpress,dc=com', 'cn', 'Bender Bending Rodriguez')
      break
    } catch (e: any) {
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
}, { timeout: 35000 })

after(async () => {
  // close the pool so the test runner can exit cleanly
  await ldap.close()
})
