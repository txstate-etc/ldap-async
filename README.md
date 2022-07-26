# Overview
This library is a wrapper around [ldapjs](http://ldapjs.org/) providing convenience with a few core principles:
* Focus on promises and async iterators, do away with callbacks and event-emitting streams
* Always use a connection pool
* Hide everything having to do with acquiring/releasing connections
* Provide an easy way to configure with environment variables

# Getting Started
## Standard connection
An Ldap instance represents a connection pool. You will want to make a single pool and export it so that it can
be imported in any other code file in your project.
```javascript
import Ldap from 'ldap-async'
export const ldap = new Ldap({
  // either
  url: 'ldap://yourhost:10389',
  // or
  host: 'yourhost',
  port: 10389,
  secure: false,

  // optional pool size (default is 5 simultaneous connections)
  poolSize: 5,

  // then your login and password
  bindDN: 'cn=root',
  bindCredentials: 'secret',

  // and any other options supported by ldapjs
  timeout: 30000
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
const Ldap = require('ldap-async').default
// or the instance created with environment variables (see above)
const ldap = require('ldap-async/client').default
```
# Basic Usage
Convenience methods are provided that allow you to specify the kind of operation you are about
to do and the type of return data you expect.
## Querying
```javascript
const person = await ldap.get('cn=you,ou=people,dc=yourdomain,dc=com')
console.log(person) // { givenName: 'John', ... }

const people = await ldap.search('ou=people,dc=yourdomain,dc=com', { scope: 'sub', filter: 'objectclass=person' })
console.log(people) // [{ givenName: 'John', ... }, { givenName: 'Mary', ... }]
```
## Writing
```javascript
// change the value of a single attribute on a record
await ldap.setAttribute('cn=you,ou=people,dc=yourdomain,dc=com', 'email', 'newemail@company.com')

// change the value of multiple attributes in one round trip
await ldap.setAttributes('cn=you,ou=people,dc=yourdomain,dc=com', { email: 'newemail@company.com', sn: 'Smith' })

// pushes value onto an array attribute unless it's already there
await ldap.pushAttribute('cn=you,ou=people,dc=yourdomain,dc=com', 'email', 'newemail@company.com')

// remove a value from an array attribute (returns true without doing anything if value wasn't there)
await ldap.pullAttribute('cn=you,ou=people,dc=yourdomain,dc=com', 'email', ['newemail@company.com'])

// remove an attribute entirely
await ldap.removeAttribute('cn=you,ou=people,dc=yourdomain,dc=com', 'customAttr')

// add a full record
await ldap.add('cn=you,ou=people,dc=yourdomain,dc=com', { /* a person record */ })

// remove a full record
await ldap.remove('cn=you,ou=people,dc=yourdomain,dc=com')

// rename a record (in this example only the cn changes, the ou,dc entries are preserved)
await ldap.modifyDN('cn=you,ou=people,dc=yourdomain,dc=com', 'cn=yourself')

// special group membership functions
await ldap.addMember('cn=you,ou=people,dc=yourdomain,dc=com', 'cn=yourgroup,ou=groups,dc=yourdomain,dc=com')
await ldap.removeMember('cn=you,ou=people,dc=yourdomain,dc=com', 'cn=yourgroup,ou=groups,dc=yourdomain,dc=com')
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
  filter: ldap.in(myNames, 'givenName')
})
for await (const person of stream) {
  // do some work on the person
}
```
`for await` is very safe, as `break`ing the loop or throwing an error inside the loop will clean up the stream appropriately.

Since `.stream()` returns a `Readable` in object mode, you can easily do other things with
it like `.pipe()` it to another stream processor. When using the stream without `for await`, you must call `stream.destroy()` if you do not want to finish processing it and carefully use `try {} finally {}` to destroy it in case your code throws an error. Failure to do so will leak a connection from the pool.

## Binary data
Some LDAP services store binary data as properties of records (e.g. user profile photos), but the ldapjs library assumes that all properties are UTF8 strings and will mangle the binary data. To work around this
issue, we provide the raw data inside the property `_raw`. For example, to convert profile photos to data URLs, you could do something like this:

```typescript
const user = await ldap.get(userDn)
const convertedUser = {
  ...user,
  jpegPhoto: `data:image/jpeg;base64,${Buffer.from(user._raw.jpegPhoto).toString('base64')}`,
}
```

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
