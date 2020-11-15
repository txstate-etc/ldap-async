# Overview
This library has a few core principles:
* Focus on promises and async iterators, do away with callbacks and event-emitting streams
* Always use a connection pool
* Hide everything having to do with acquiring/releasing connections
* Provide an easy way to configure with environment variables

# Getting Started
## Standard connection
An Ldap instance represents a connection pool. You will want to make a single pool and export it so that it can
be imported all over your code.
```javascript
import Ldap from 'ldap-async'
export const ldap = new Ldap({
  host: 'yourhost',
  ...
})

async function main() {
  const person = await ldap.get('cn=you,ou=people,dc=yourdomain,dc=com')
}
main().catch(e => console.error(e))
```
## Connect with environment variables
When working in docker, it's common to keep configuration in environment variables. In order to
make that easy, this library provides a convenient way to import a singleton pool created with the following
environment variables:
```
  LDAP_HOST
  LDAP_PORT // default is 389 or 636 if you set LDAP_SECURE
  LDAP_SECURE // set truthy to use ldaps protocol
  LDAP_DN // the DN with which to bind
  LDAP_PASS // the password for the bind DN
  LDAP_POOLSIZE (default: 5)
```
This way, connecting is very simple, and you don't have to worry about creating a singleton pool for the
rest of your codebase to import, because it's done for you:
```javascript
import ldap from 'ldap-async/client'

async function main() {
  const person = await ldap.get('cn=you,ou=people,dc=yourdomain,dc=com')
}
main().catch(e => console.error(e))
```

## CommonJS imports
You must refer to `.default` when importing with `require`:
```javascript
const ldap = require('ldap-async/client').default // or
const { default: ldap } = require('ldap-async/db') // or
const Ldap = require('ldap-async').default // or
const { default: Ldap } = require('ldap-async')
```
# Basic Usage
Convenience methods are provided that allow you to specify the kind of operation you are about
to do and the kind of return data you expect. For now only searching is implemented.
## Querying
```javascript
const person = await ldap.get('cn=you,ou=people,dc=yourdomain,dc=com')
console.log(person) // { givenName: 'John', ... }
const people = await ldap.search('ou=people,dc=yourdomain,dc=com', { scope: 'sub', filter: 'objectclass=person' })
console.log(people) // [{ givenName: 'John', ... }, { givenName: 'Mary', ... }]
```
## Escaping
When you construct LDAP search query strings, it's important to escape any input strings to prevent injection attacks. LDAP has two kinds of strings with different escaping requirements, so we provide a template literal helper for each.

For DN strings, use `ldap.dn`:
```javascript
const person = await ldap.get(ldap.dn`cn=${myCN},ou=people,dc=yourdomain,dc=com`)
```
For filter strings, use `ldap.filter`:
```javascript
const people = await ldap.search('ou=people,dc=yourdomain,dc=com', {
  scope: 'sub',
  filter: ldap.filter`givenName=${n}`
})
```
More complex queries may also use `ldap.filter` inside a map function, such as this one that finds many users by their names:
```javascript
const people = await ldap.search('ou=people,dc=yourdomain,dc=com', {
  scope: 'sub',
  filter: `(|${myNames.map(n => ldap.filter`(givenName=${n})`).join('')})`
})
```
## Filter helpers
For convenience, a few helper functions are provided to help you construct LDAP filters: `in`, `any`, `all`, and `anyall`. These functions take care of escaping for you.
* Everyone named John or Mary:
  ```javascript
  ldap.in(['John', 'Mary'], 'givenName')
  // => '(|(givenName=John)(givenName=Mary))
  ```
* Everyone named John or with the surname Smith
  ```javascript
  ldap.any({ givenName: 'John', sn: 'Smith' })
  // => '(|(givenName=John)(sn=Smith))
  ```
* Everyone named John Smith
  ```javascript
  ldap.all({ givenName: 'John', sn: 'Smith' })
  // => '(&(givenName=John)(sn=Smith))
  ```
* Everyone named John Smith or Mary Scott
  ```javascript
  ldap.anyall([{ givenName: 'John', sn: 'Smith' }, { givenName: 'Mary', sn: 'Scott' }])
  // => '(|(&(givenName=John)(sn=Smith))(&(givenName=Mary)(sn=Scott)))'
  ```
Note that `any`, `all` and `anyall` can accept an optional `wildcard` parameter if you want users to be able to provide wildcards. Other special characters like parentheses will be properly escaped.
* Everyone named John whose surname starts with S
  ```javascript
  ldap.all({ givenName: 'John', sn: 'S*' }, true)
  // => '(&(givenName=John)(sn=S*))
  ```
# Advanced Usage
## Streaming
To avoid using too much memory on huge datasets, we provide a `stream` method that performs the same as `search` but returns a node `Readable`. It is recommended to use the async iterator pattern:
```javascript
const stream = ldap.stream('ou=people,dc=yourdomain,dc=com', {
  scope: 'sub',
  filter: `(|${myNames.map(n => ldap.filter`(givenName=${n})`).join('')})`
})
for await (const person of stream) {
  // do some work on the person
}
```
`for await` is very safe, as `break`ing the loop or throwing an error inside the loop will clean up the stream appropriately.

Since `.stream()` returns a `Readable` in object mode, you can easily do other things with
it like `.pipe()` it to another stream processor. When using the stream without `for await`, you must call `stream.destroy()` if you do not want to finish processing it and carefully use `try {} finally {}` to destroy it in case your code throws an error. Failure to do so will leak a connection from the pool.

## Typescript
This library is written in typescript and provides its own types. For added convenience, methods that return
objects will accept a generic so that you can specify the return type you expect:
```typescript
interface LDAPPerson {
  cn: string
  givenName: string
}
const person = ldap.get<LDAPPerson>(ldap.dn`cn=${myCN},ou=people,dc=yourdomain,dc=com`)
// person will be an LDAPPerson
```
