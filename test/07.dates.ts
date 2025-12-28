/* eslint-disable @typescript-eslint/no-unused-expressions */
/* global describe, it */
import { expect } from 'chai'
import ldap from '../src/client'

function pad(n: number, len = 2) { return String(n).padStart(len, '0') }
function toGeneralizedTime(d: Date) {
  return '' + d.getUTCFullYear()
    + pad(d.getUTCMonth() + 1)
    + pad(d.getUTCDate())
    + pad(d.getUTCHours())
    + pad(d.getUTCMinutes())
    + pad(d.getUTCSeconds())
    + '.' + String(d.getUTCMilliseconds()).padStart(3, '0') + 'Z'
}

describe('date parsing tests', () => {
  it('parses ISO8601, GeneralizedTime, unix seconds, unix millis, and Windows FILETIME', async function () {
    this.timeout(10000)

    const now = new Date()
    const nowSeconds = Math.floor(now.getTime() / 1000)
    const nowMillis = now.getTime()

    // Prepare and add all entries in parallel
    const cnIso = `date-iso-${Date.now()}`
    const isoVal = now.toISOString()

    const cnGen = `date-gen-${Date.now()}`
    const genVal = toGeneralizedTime(now)

    const cnGenOffset = `date-gen-offset-${Date.now()}`
    const offsetHours = 2
    const tzSign = offsetHours >= 0 ? '+' : '-'
    const tz = tzSign + String(Math.abs(offsetHours)).padStart(2, '0') + '00'
    const genOffsetVal = '' + now.getUTCFullYear()
      + pad(now.getUTCMonth() + 1)
      + pad(now.getUTCDate())
      + pad(now.getUTCHours())
      + pad(now.getUTCMinutes())
      + pad(now.getUTCSeconds())
      + '.' + String(now.getUTCMilliseconds()).padStart(3, '0') + tz

    const cnGenNoTz = `date-gen-notz-${Date.now()}`
    const genNoTzVal = '' + now.getUTCFullYear()
      + pad(now.getUTCMonth() + 1)
      + pad(now.getUTCDate())
      + pad(now.getUTCHours())
      + pad(now.getUTCMinutes())
      + pad(now.getUTCSeconds())
      + '.' + String(now.getUTCMilliseconds()).padStart(3, '0')

    const cnGenNoMs = `date-gen-noms-${Date.now()}`
    const genNoMsVal = '' + now.getUTCFullYear()
      + pad(now.getUTCMonth() + 1)
      + pad(now.getUTCDate())
      + pad(now.getUTCHours())
      + pad(now.getUTCMinutes())
      + pad(now.getUTCSeconds()) + 'Z'

    const cnSec = `date-sec-${Date.now()}`
    const secVal = String(nowSeconds)

    const cnMs = `date-ms-${Date.now()}`
    const msVal = String(nowMillis)

    const cnFile = `date-file-${Date.now()}`
    const epochDiff = BigInt('116444736000000000')
    const filetime = (BigInt(nowMillis) * BigInt(10000)) + epochDiff
    const fileVal = String(filetime)

    await Promise.all([
      ldap.add(`cn=${cnIso},ou=people,dc=planetexpress,dc=com`, {
        objectClass: ['inetOrgPerson', 'organizationalPerson', 'person', 'top'],
        cn: cnIso,
        sn: 'Dates',
        description: isoVal
      }),
      ldap.add(`cn=${cnGen},ou=people,dc=planetexpress,dc=com`, {
        objectClass: ['inetOrgPerson', 'organizationalPerson', 'person', 'top'],
        cn: cnGen,
        sn: 'Dates',
        description: genVal
      }),
      ldap.add(`cn=${cnGenOffset},ou=people,dc=planetexpress,dc=com`, {
        objectClass: ['inetOrgPerson', 'organizationalPerson', 'person', 'top'],
        cn: cnGenOffset,
        sn: 'Dates',
        description: genOffsetVal
      }),
      ldap.add(`cn=${cnGenNoTz},ou=people,dc=planetexpress,dc=com`, {
        objectClass: ['inetOrgPerson', 'organizationalPerson', 'person', 'top'],
        cn: cnGenNoTz,
        sn: 'Dates',
        description: genNoTzVal
      }),
      ldap.add(`cn=${cnGenNoMs},ou=people,dc=planetexpress,dc=com`, {
        objectClass: ['inetOrgPerson', 'organizationalPerson', 'person', 'top'],
        cn: cnGenNoMs,
        sn: 'Dates',
        description: genNoMsVal
      }),
      ldap.add(`cn=${cnSec},ou=people,dc=planetexpress,dc=com`, {
        objectClass: ['inetOrgPerson', 'organizationalPerson', 'person', 'top'],
        cn: cnSec,
        sn: 'Dates',
        description: secVal
      }),
      ldap.add(`cn=${cnMs},ou=people,dc=planetexpress,dc=com`, {
        objectClass: ['inetOrgPerson', 'organizationalPerson', 'person', 'top'],
        cn: cnMs,
        sn: 'Dates',
        description: msVal
      }),
      ldap.add(`cn=${cnFile},ou=people,dc=planetexpress,dc=com`, {
        objectClass: ['inetOrgPerson', 'organizationalPerson', 'person', 'top'],
        cn: cnFile,
        sn: 'Dates',
        description: fileVal
      })
    ])

    try {
      const iso = await ldap.get(`cn=${cnIso},ou=people,dc=planetexpress,dc=com`)
      expect(iso.date('description')?.toISOString()).to.equal(new Date(isoVal).toISOString(), 'ISO8601 date did not match')
      expect(iso.date('description', 'iso')?.toISOString()).to.equal(new Date(isoVal).toISOString(), 'ISO8601 date with hint did not match')

      const gen = await ldap.get(`cn=${cnGen},ou=people,dc=planetexpress,dc=com`)
      expect(gen.date('description')?.toISOString()).to.equal(new Date(now.getTime()).toISOString(), 'GeneralizedTime date did not match')
      expect(gen.date('description', 'ldap')?.toISOString()).to.equal(new Date(now.getTime()).toISOString(), 'GeneralizedTime date with hint did not match')

      const genOffset = await ldap.get(`cn=${cnGenOffset},ou=people,dc=planetexpress,dc=com`)
      // genOffsetVal represented the same UTC fields but with +0200; when parsed it should yield a different instant
      const parsedOffset = genOffset.date('description')
      expect(parsedOffset).to.not.be.undefined
      // since genOffset had a +0200 zone but used UTC fields, adjust expected by -2 hours
      expect(parsedOffset?.getTime()).to.equal(new Date(now.getTime() - (offsetHours * 3600 * 1000)).getTime(), 'GeneralizedTime with offset did not match')

      const genNoTz = await ldap.get(`cn=${cnGenNoTz},ou=people,dc=planetexpress,dc=com`)
      // missing timezone: behavior should be parsed as invalid for ldap format -> undefined
      expect(genNoTz.date('description')).to.be.undefined

      const genNoMs = await ldap.get(`cn=${cnGenNoMs},ou=people,dc=planetexpress,dc=com`)
      expect(genNoMs.date('description')?.toISOString()).to.equal(new Date(now.getTime()).toISOString().slice(0, -4) + '000Z', 'GeneralizedTime without ms did not match')

      const sec = await ldap.get(`cn=${cnSec},ou=people,dc=planetexpress,dc=com`)
      expect(sec.date('description')?.getTime()).to.equal(nowSeconds * 1000, 'Unix seconds date did not match')
      expect(sec.date('description', 'unix')?.getTime()).to.equal(nowSeconds * 1000, 'Unix seconds date with hint did not match')

      const ms = await ldap.get(`cn=${cnMs},ou=people,dc=planetexpress,dc=com`)
      expect(ms.date('description')?.getTime()).to.equal(nowMillis, 'Unix milliseconds date did not match')
      expect(ms.date('description', 'millis')?.getTime()).to.equal(nowMillis, 'Unix milliseconds date with hint did not match')

      const file = await ldap.get(`cn=${cnFile},ou=people,dc=planetexpress,dc=com`)
      expect(file.date('description')?.getTime()).to.equal(nowMillis, 'Windows FILETIME date did not match')
      expect(file.date('description', 'windows')?.getTime()).to.equal(nowMillis, 'Windows FILETIME date with hint did not match')
    } finally {
      // cleanup
      await Promise.all([
        ldap.remove(`cn=${cnIso},ou=people,dc=planetexpress,dc=com`),
        ldap.remove(`cn=${cnGen},ou=people,dc=planetexpress,dc=com`),
        ldap.remove(`cn=${cnSec},ou=people,dc=planetexpress,dc=com`),
        ldap.remove(`cn=${cnMs},ou=people,dc=planetexpress,dc=com`),
        ldap.remove(`cn=${cnFile},ou=people,dc=planetexpress,dc=com`)
      ]).catch(() => {})
    }
  })
})
