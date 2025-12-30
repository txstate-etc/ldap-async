import { Attribute, Client, type ClientOptions, type SearchOptions, Change, type AttributeOptions, type Control, type Entry, type Filter, EqualityFilter, OrFilter } from 'ldapts'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'

type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>
interface StreamIterator <T> {
  [Symbol.asyncIterator]: () => StreamIterator<T>
  next: () => Promise<{ done?: false, value: T }>
  return: () => Promise<{ done: true, value: T }>
}
interface GenericReadable<T> extends Readable {
  [Symbol.asyncIterator]: () => StreamIterator<T>
}

export interface LdapConfig extends Optional<ClientOptions, 'url'> {
  host?: string
  port?: string | number
  secure?: boolean
  poolSize?: number
  keepaliveSeconds?: number
  idleTimeoutSeconds?: number
  startTLSCert?: string | Buffer | boolean
  logger?: {
    debug: (...args: string[]) => void
    info: (...args: string[]) => void
    warn: (...args: string[]) => void
    error: (...args: string[]) => void
  }
  preserveAttributeCase?: boolean
  transformEntries?: (entry: LdapEntry) => void
}
const localConfig = new Set(['host', 'port', 'secure', 'poolSize', 'keepaliveSeconds', 'idleTimeoutSeconds', 'startTLSCert', 'logger', 'preserveAttributeCase', 'transformEntries'])

export interface LdapChange {
  operation: string
  modification: AttributeOptions | Attribute
}

const filterReplacements = {
  '\0': '\\00',
  '(': '\\28',
  ')': '\\29',
  '*': '\\2a',
  '\\': '\\5c'
}

const dnReplacements = {
  '"': '\\"',
  '#': '\\#',
  '+': '\\+',
  ',': '\\,',
  ';': '\\;',
  '<': '\\<',
  '=': '\\=',
  '>': '\\>',
  '\\': '\\\\',
  ' ': '\\ '
}

type ValidAttributeInput = boolean | number | string | Buffer

function valToString (val: Exclude<ValidAttributeInput, Buffer>) {
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE'
  if (typeof val === 'number') return String(val)
  return val
}

function valToBuffer (val: ValidAttributeInput) {
  return Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'utf-8')
}

function valsToStringOrBuffer (vals: null | undefined | ValidAttributeInput | ValidAttributeInput[]): Buffer[] | string[] {
  const values = Array.isArray(vals) ? vals : (vals != null ? [vals] : [])
  if (values.some(v => Buffer.isBuffer(v))) {
    return values.map(valToBuffer)
  }
  return (values as Exclude<ValidAttributeInput, Buffer>[]).map(valToString)
}

function searchForDN (dn: string) {
  const [first, ...restComponents] = dn.split(/(?<!\\),/)
  const basedn = restComponents.join(',')
  const [attr, ...restVal] = first.split(/=/)
  const val = restVal.join('=').replace(/(?<!\\)\\/, '').replace(/\\\\/, '\\')
  return { basedn, attr, val }
}

export function batch<T = any> (input: T[], batchLimit = 100) {
  const ret: T[][] = []
  if (!input?.length) return [[]]
  for (let i = 0; i < input.length; i += batchLimit) {
    ret.push(input.slice(i, i + batchLimit))
  }
  return ret
}

function batchOnBase (searches: { basedn: string, attr: string, val: string }[], batchLimit = 100) {
  const store: Record<string, Filter[]> = {}
  for (const s of searches) {
    store[s.basedn] ??= []
    store[s.basedn].push(new EqualityFilter({ attribute: s.attr, value: s.val }))
  }
  const ret: Record<string, Filter[]> = {}
  for (const basedn of Object.keys(store)) {
    const batches = batch(store[basedn], batchLimit)
    ret[basedn] = batches.map(filters => new OrFilter({ filters }))
  }
  return ret
}

type PooledClient = Client & { busy?: boolean, lastUsed?: Date }

export default class Ldap {
  protected connectpromise?: Promise<void>
  protected config: ClientOptions
  protected clients: PooledClient[]
  protected poolSize: number
  protected keepaliveSeconds?: number
  protected idleTimeoutSeconds?: number
  protected intervalTimer?: ReturnType<typeof setTimeout>
  protected preserveAttributeCase: boolean
  protected transformEntries?: (entry: LdapEntry) => void
  protected bindDN: string
  protected bindCredentials: string
  protected startTLSCert?: string | Buffer | boolean
  protected poolQueue: ((client: Client & { busy?: boolean, lastUsed?: Date }) => void)[]
  protected closeRequest?: (value?: any) => void
  private console: NonNullable<LdapConfig['logger']>

  constructor (config: LdapConfig = {}) {
    if (!config.url) {
      const secure = config.secure ?? process.env.LDAP_SECURE
      const host = config.host ?? process.env.LDAP_HOST ?? ''
      const port = config.port ?? process.env.LDAP_PORT
      config.url = `${secure ? 'ldaps://' : 'ldap://'}${host}:${port ?? (secure ? '636' : '389')}`
    }

    this.console = config.logger ?? console

    this.bindDN = (config as any).bindDN ?? process.env.LDAP_DN ?? ''
    this.bindCredentials = (config as any).bindCredentials ?? process.env.LDAP_PASSWORD ?? process.env.LDAP_PASS ?? ''
    this.config = {} as any
    for (const [key, value] of Object.entries(config)) {
      if (value != null && !localConfig.has(key)) (this.config as any)[key] = value
    }

    this.startTLSCert = config.startTLSCert ?? (!!process.env.LDAP_STARTTLS || (process.env.LDAP_STARTTLS_CERT ? readFileSync(process.env.LDAP_STARTTLS_CERT) : undefined))
    this.poolSize = config.poolSize ?? (parseInt(process.env.LDAP_POOLSIZE ?? 'NaN') || 5)
    this.keepaliveSeconds = config.keepaliveSeconds ?? (parseInt(process.env.LDAP_KEEPALIVE_SECONDS ?? 'NaN') || undefined)
    this.idleTimeoutSeconds = config.idleTimeoutSeconds ?? parseInt(process.env.LDAP_IDLE_TIMEOUT_SECONDS ?? 'NaN')
    if (isNaN(this.idleTimeoutSeconds)) this.idleTimeoutSeconds = 230
    if (this.idleTimeoutSeconds === 0) this.idleTimeoutSeconds = undefined
    this.clients = []
    this.poolQueue = []
    this.preserveAttributeCase = config.preserveAttributeCase ?? !!process.env.LDAP_PRESERVE_ATTRIBUTE_CASE
    this.transformEntries = config.transformEntries
  }

  protected async connect () {
    const client = Object.assign(new Client(this.config), { busy: true })
    this.clients.push(client)
    if (this.idleTimeoutSeconds) this.intervalTimer ??= setInterval(this.idleCleanup.bind(this), Math.min(1, this.idleTimeoutSeconds / 2) * 1000)
    return await this.bindConnection(client)
  }

  protected async bindConnection (client: PooledClient) {
    try {
      if (this.startTLSCert) {
        await client.startTLS({ cert: this.startTLSCert !== true ? this.startTLSCert : undefined })
      }
      await client.bind(this.bindDN, this.bindCredentials)
      if (this.keepaliveSeconds) (client as any).socket.setKeepAlive(true, this.keepaliveSeconds * 1000)
      return client
    } catch (e) {
      await client.unbind().catch(() => {})
      this.clients = this.clients.filter(c => c !== client)
      throw e
    }
  }

  protected async getClient () {
    let client = this.clients.find(c => !c.busy)
    if (!client) {
      if (this.clients.length < this.poolSize) {
        client = await this.connect()
      } else {
        client = await new Promise<Client & { busy?: boolean }>(resolve => {
          this.poolQueue.push(resolve)
        })
      }
    }
    client.busy = true
    if (!client.isConnected) await this.bindConnection(client)
    return client
  }

  protected release (client: PooledClient) {
    client.busy = false
    client.lastUsed = new Date()
    const nextInQueue = this.poolQueue.shift()
    if (nextInQueue) nextInQueue(client)
    else if (this.clients.every(c => !c.busy) && this.closeRequest) this.closeRequest()
  }

  protected idleCleanup () {
    const now = new Date()
    this.clients = this.clients.filter(client => {
      if (client.busy) return true
      if (!client.lastUsed) return true
      const idleSeconds = (now.getTime() - client.lastUsed.getTime()) / 1000
      if (idleSeconds >= this.idleTimeoutSeconds!) {
        client.unbind().catch(console.error)
        return false
      }
      return true
    })
    if (this.clients.length === 0) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = undefined
    }
  }

  async close () {
    if (this.closeRequest) return
    if (this.clients.some(c => c.busy)) {
      await new Promise(resolve => {
        this.closeRequest = resolve
      })
      this.closeRequest = undefined
    }
    const clients = this.clients
    this.clients = []
    clearInterval(this.intervalTimer)
    this.intervalTimer = undefined
    for (const client of clients) await client.unbind()
  }

  async wait () {
    let loops = 0
    while (true) {
      try {
        const client = await this.getClient()
        this.release(client)
        break
      } catch (e: any) {
        if (loops++ < 2) this.console.warn('Unable to connect to LDAP. Trying again in 2 seconds.')
        else this.console.error('Unable to connect to LDAP. Trying again in 2 seconds.', e.message)
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  }

  async get<T = any> (base: string, options?: SearchOptions, controls?: Control | Control[]) {
    options ??= {}
    options.scope ??= 'base'
    return (await this.search<T>(base, options, controls))[0]
  }

  protected loadPairs = new Map<string, Set<string>>()
  protected loadPromises: Record<string, Promise<Map<string, LdapEntry>> | undefined> = {}
  async load (dn: string, attributes?: SearchOptions['attributes']) {
    const { basedn, attr, val } = searchForDN(dn)
    const attrKey = JSON.stringify(attributes) + basedn
    if (!this.loadPairs.has(attrKey)) this.loadPairs.set(attrKey, new Set())
    this.loadPairs.get(attrKey)!.add(this.filter`(${attr}=${val})`)
    this.loadPromises[attrKey] ??= new Promise((resolve, reject) => {
      setTimeout(() => {
        this.loadPromises[attrKey] = undefined
        const filters = Array.from(this.loadPairs.get(attrKey)!)
        this.loadPairs.delete(attrKey)
        const ret = new Map<string, LdapEntry>()
        const batches = batch(filters)
        const promises: Promise<void>[] = []
        for (const filters of batches) {
          promises.push(this.search(basedn, { scope: 'sub', filter: `(|${filters.join('')})`, attributes }).then(results => {
            for (const entry of results) ret.set(entry.dn, entry)
          }))
        }
        Promise.all(promises).then(() => { resolve(ret) }).catch(reject)
      }, 0)
    })
    const entries = await this.loadPromises[attrKey]
    return entries.get(dn)
  }

  async search<T = any>(base: string, options?: SearchOptions, controls?: Control | Control[]) {
    const stream = this.stream<T>(base, options, controls)
    const results: LdapEntry<T>[] = []
    for await (const result of stream) {
      results.push(result)
    }
    return results
  }

  stream<T = any> (base: string, options: SearchOptions = {}, controls?: Control | Array<Control>) {
    if (options.paged == null || options.paged === true) options.paged = {}
    if (typeof options.paged === 'object') {
      if (!options.paged.pageSize) options.paged.pageSize = 200
    }
    options.explicitBufferAttributes ??= binaryAttributes
    let canceled = false
    let unpause: ((value: any) => void) | undefined
    const stream = new Readable({ objectMode: true, autoDestroy: true }) as GenericReadable<LdapEntry<T>>
    stream._read = () => { unpause?.(undefined) }
    stream.on('close', () => { canceled = true })
    const stacktraceError: { stack?: string } = {}
    Error.captureStackTrace(stacktraceError, this.stream)
    const sendError = (e: any) => {
      if (canceled) return
      e.clientstack = e.stack
      e.stack = (stacktraceError.stack ?? '').replace(/^Error:/, `Error: ${e.message as string ?? ''}`)
      stream.emit('error', e)
    }

    this.getClient().then(async client => {
      try {
        const searchIterator = client.searchPaginated(base, options ?? {}, controls ?? [])
        for await (const result of searchIterator) {
          for (const entry of result.searchEntries) {
            if (canceled) break
            const keepGoing = stream.push(new LdapEntry(entry, this, this.transformEntries))
            if (!keepGoing) {
              await new Promise(resolve => { unpause = resolve })
            }
          }
          if (canceled) break
        }
        stream.push(null)
      } finally {
        this.release(client)
      }
    }).catch(sendError)
    return stream
  }

  protected async useClient<T>(callback: (client: Client) => Promise<T>) {
    const client = await this.getClient()
    try {
      return await callback(client)
    } finally {
      this.release(client)
    }
  }

  /**
   * Raw access to the modify LDAP functionality. Consider setAttribute, pushAttribute,
   * or pullAttribute instead, or addMember/removeMember to manage group memberships. These
   * methods add extra convenience.
   */
  async modify (dn: string, operationOrChanges: string | LdapChange[], modification?: AttributeOptions): Promise<boolean> {
    return await this.useClient(async client => {
      const changes = Array.isArray(operationOrChanges)
        ? operationOrChanges.map(c => new Change({
          operation: c.operation as 'add' | 'delete' | 'replace',
          modification: c.modification instanceof Attribute ? c.modification : new Attribute(c.modification)
        }))
        : [new Change({ operation: operationOrChanges as 'add' | 'delete' | 'replace', modification: modification instanceof Attribute ? modification : new Attribute(modification) })]
      await client.modify(dn, changes)
      return true
    })
  }

  /**
   * Add an object into the system.
   */
  async add (newDn: string, entry: any) {
    return await this.useClient(async client => {
      await client.add(newDn, entry)
      return true
    })
  }

  /**
   * Remove an object from the system.
   */
  async remove (dn: string) {
    return await this.useClient(async client => {
      await client.del(dn)
      return true
    })
  }

  /**
   * Rename an object.
   */
  async modifyDN (oldDn: string, newDn: string) {
    return await this.useClient(async client => {
      await client.modifyDN(oldDn, newDn)
      return true
    })
  }

  /**
   * Use this method to completely replace an attribute. If you use it on an array attribute,
   * any existing values will be lost.
   */
  async setAttribute (dn: string, attribute: string, val: ValidAttributeInput | ValidAttributeInput[] | undefined) {
    return await this.modify(dn, 'replace', { type: attribute, values: valsToStringOrBuffer(val) })
  }

  /**
   * Use this method to completely replace multiple attributes. If any of the given attributes
   * are array attributes, any existing values will be lost.
   *
   * If you need to mix set and push operations, you can do multiple round trips or you can send
   * multiple operations to the `modify` method.
   */
  async setAttributes (dn: string, modification: Record<string, ValidAttributeInput | ValidAttributeInput[] | undefined>) {
    const changes = Object.entries(modification).map(([attr, val]) => ({ operation: 'replace', modification: { type: attr, values: valsToStringOrBuffer(val) } }))
    return await this.modify(dn, changes)
  }

  /**
   * Use this method to add more values to an array attribute without removing any existing values. Any
   * values that already exist will be ignored (if you used a raw 'modify' operation, you'd get an error).
   */
  async pushAttribute (dn: string, attribute: string, valueOrValues: string | string[]) {
    const values = Array.isArray(valueOrValues) ? valueOrValues : [valueOrValues]
    const current = await this.get(dn)
    // the ldap client only returns an array when there are 2 or more elements
    // if there is only one element, it comes back as a scalar
    const attr = await current.fullRange(attribute)
    const existingValues = new Set(Array.isArray(attr) ? attr : [attr])
    const valuesToAdd = values.filter(v => !existingValues.has(v))
    if (valuesToAdd.length === 0) return true
    return await this.modify(dn, 'add', { type: attribute, values: valuesToAdd })
  }

  /**
   * Use this method to remove the specified values from an array attribute while leaving any other
   * values in place. Any values that don't already exist will be ignored (if you used a raw 'modify'
   * operation, you'd get an error).
   */
  async pullAttribute (dn: string, attribute: string, valueOrValues: string | string[]) {
    const values = Array.isArray(valueOrValues) ? valueOrValues : [valueOrValues]
    const current = await this.get(dn)
    // the ldap client only returns an array when there are 2 or more elements
    // if there is only one element, it comes back as a scalar
    const attr = await current.fullRange(attribute)
    const existingValues = new Set(Array.isArray(attr) ? attr : [attr])
    const valuesToDelete = values.filter(v => existingValues.has(v))
    if (valuesToDelete.length === 0) return true
    return await this.modify(dn, 'delete', { type: attribute, values: valuesToDelete })
  }

  async removeAttribute (dn: string, attribute: string) {
    return await this.modify(dn, 'delete', { type: attribute, values: undefined })
  }

  /**
   * Use this method to add a member to a group. memberdn can be an array. each memberdn can be a group or a person.
   * Any memberdn entries that are already members will be ignored.
   */
  async addMember (memberdn: string | string[], groupdn: string) {
    return await this.pushAttribute(groupdn, 'member', memberdn)
  }

  /**
   * Use this method to remove a member from a group. memberdn can be an array. each memberdn can be a group or a person.
   * Any memberdn entries that are not already members will be ignored.
   */
  async removeMember (memberdn: string | string[], groupdn: string) {
    return await this.pullAttribute(groupdn, 'member', memberdn)
  }

  private async getMemberRecur (ret: Readable, g: LdapEntry, groupsExplored: Set<string>, attributes?: SearchOptions['attributes']) {
    const members = await g.fullRange('member')
    const batchMap = batchOnBase(members.map(searchForDN))
    const groups: LdapEntry[] = []
    for (const [basedn, batches] of Object.entries(batchMap)) {
      for (const filter of batches) {
        const strm = this.stream(basedn, { scope: 'sub', filter, attributes })
        for await (const m of strm) {
          const isGroup = m.one('member') != null
          if (isGroup) groups.push(m)
          else {
            const feedme = ret.push(m)
            if (!feedme) {
              await new Promise(resolve => {
                ret.once('resume', () => {
                  resolve(undefined)
                })
              })
            }
          }
        }
      }
    }
    for (const sg of groups) {
      if (!groupsExplored.has(sg.dn)) {
        groupsExplored.add(sg.dn)
        await this.getMemberRecur(ret, sg, groupsExplored, attributes)
      }
    }
  }

  getMemberStream<T = any> (groupdn: string, attributes?: SearchOptions['attributes']) {
    attributes = attributes?.length ? attributes.filter(attr => attr !== 'member').concat(['member']) : undefined
    const ret = new Readable({ objectMode: true, highWaterMark: 100 }) as GenericReadable<LdapEntry<T>>
    ret._read = () => { ret.resume() }
    this.get(groupdn, { attributes: ['member'] }).then(async g => {
      await this.getMemberRecur(ret, g, new Set([groupdn]), attributes)
      ret.push(null)
    }).catch(e => ret.destroy(e))
    return ret
  }

  async getMembers<T = any> (groupdn: string, attributes?: SearchOptions['attributes']) {
    const strm = this.getMemberStream<T>(groupdn, attributes)
    const members: LdapEntry<T>[] = []
    for await (const m of strm) members.push(m)
    return members
  }

  protected templateLiteralEscape (regex: RegExp, replacements: any, strings: TemplateStringsArray, values: (string | number)[]) {
    let safe = ''
    for (let i = 0; i < strings.length; i++) {
      safe += strings[i]
      if (values.length > i) {
        safe += `${values[i]}`.replace(new RegExp(regex.source, 'gm'), (ch: string) => replacements[ch])
      }
    }
    return safe
  }

  filter (strings: TemplateStringsArray, ...values: (string | number)[]) {
    return this.templateLiteralEscape(/[\0()*\\]/, filterReplacements, strings, values)
  }

  filterAllowWildcard (strings: TemplateStringsArray, ...values: (string | number)[]) {
    return this.templateLiteralEscape(/[\0()\\]/, filterReplacements, strings, values)
  }

  dn (strings: TemplateStringsArray, ...values: (string | number)[]) {
    return this.templateLiteralEscape(/((^ )|["#+,;<=>\\]|( $))/, dnReplacements, strings, values)
  }

  in (values: (string | number)[], property: string) {
    return `(|${values.map(v => this.filter`(${property}=${v})`).join('')})`
  }

  any (values: Record<string, (string | number)>, wildcards = false) {
    return wildcards
      ? `(|${Object.entries(values).map(([k, v]) => this.filterAllowWildcard`(${k}=${v})`).join('')})`
      : `(|${Object.entries(values).map(([k, v]) => this.filter`(${k}=${v})`).join('')})`
  }

  all (values: Record<string, (string | number)>, wildcards = false) {
    return wildcards
      ? `(&${Object.entries(values).map(([k, v]) => this.filterAllowWildcard`(${k}=${v})`).join('')})`
      : `(&${Object.entries(values).map(([k, v]) => this.filter`(${k}=${v})`).join('')})`
  }

  anyall (values: Record<string, string | number>[], wildcards = false) {
    return wildcards
      ? `(|${values.map(v => `(&${Object.entries(v).map(([prop, val]) => this.filterAllowWildcard`(${prop}=${val})`).join('')})`).join('')})`
      : `(|${values.map(v => `(&${Object.entries(v).map(([prop, val]) => this.filter`(${prop}=${val})`).join('')})`).join('')})`
  }
}

const binaryAttributes = ['photo', 'audio', 'jpegphoto', 'jpegPhoto', 'thumbnailphoto', 'thumbnailPhoto', 'thumbnaillogo', 'thumbnailLogo']
const WINDOWS_FILETIME_EPOCH_DIFF = BigInt('116444736000000000')
const FILETIME_TO_MS = BigInt(10000)
const GENERALIZED_TIME_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?(Z|[+-]\d{4})$/

export class LdapEntry<T = any> {
  attrs = new Map<string, { type: string, values: string[] | Buffer<ArrayBufferLike>[] }>()
  dn: string
  constructor (data: Entry, protected client: Ldap, transformEntries?: (entry: LdapEntry) => void) {
    this.dn = data.dn
    for (const [key, value] of Object.entries(data)) {
      if (value.length === 0) continue
      const attrWithoutOptions = key.split(';', 2)[0].toLocaleLowerCase()
      this.attrs.set(attrWithoutOptions, {
        type: key,
        values: (Array.isArray(value) ? value : [value]) as string[] | Buffer<ArrayBufferLike>[]
      })
    }
    transformEntries?.(this)
  }

  set (attr: string, value: ValidAttributeInput | ValidAttributeInput[] | undefined) {
    this.attrs.set(attr.toLocaleLowerCase(), { type: attr, values: valsToStringOrBuffer(value) })
  }

  get (attr: string) {
    return this.all(attr)[0] as string | undefined
  }

  protected static date (val: string, typeHint?: 'ldap' | 'unix' | 'millis' | 'iso' | 'windows') {
    // automatically detect date in the following formats:
    // YYYYMMDDHHmmSSZ, ISO8601, Unix Timestamp (seconds or milliseconds), or Windows FILETIME”
    const genMatch = typeHint && typeHint !== 'ldap' ? undefined : val.match(GENERALIZED_TIME_RE)
    typeHint ??= genMatch ? 'ldap'
      : (/^\d+$/.test(val))
        // a 12 digit number might be epoch millis 1973-2001, or epoch seconds 5138+;
        // 1973-2001 is more likely, but neither is particularly likely and in this case
        // LDAP is a lot less likely to contain millis so we are going to favor seconds.
        // this way the library doesn't break in 5138 AD :)
        ? val.length < 13 ? 'unix'
          // a 16 digit epoch in millis would exceed javascript number limits, so we'll assume
          // anything 16 or longer is windows filetime
          : val.length < 16 ? 'millis'
          : 'windows'
        // if there were any non-digit characters, assume iso8601 - that's all we're going to support
        : 'iso'

    switch (typeHint) {
      case 'ldap':
        if (!genMatch) return undefined
        const [, ys, mons, ds, hs, mins, secs, frac, zone] = genMatch
        const year = Number(ys)
        const month = Number(mons) - 1
        const day = Number(ds)
        const hour = Number(hs)
        const minute = Number(mins)
        const second = Number(secs)
        const millisecond = Number(frac?.slice(0, 3) ?? '0')
        const utcTimestamp = Date.UTC(year, month, day, hour, minute, second, millisecond)
        if (zone && zone !== 'Z') {
          const sign = zone[0] === '-' ? -1 : 1
          const offsetHours = Number(zone.slice(1, 3))
          const offsetMinutes = Number(zone.slice(3, 5))
          const offsetTotalMinutes = offsetHours * 60 + offsetMinutes
          const offsetTotalMilliseconds = offsetTotalMinutes * 60 * 1000 * sign
          return new Date(utcTimestamp - offsetTotalMilliseconds)
        }
        return new Date(utcTimestamp)

      case 'millis':
        return new Date(Number(val))

      case 'unix':
        return new Date(Number(val) * 1000)

      case 'windows': {
        const n = BigInt(val)
        const msSinceEpoch = (n - WINDOWS_FILETIME_EPOCH_DIFF) / FILETIME_TO_MS
        return new Date(Number(msSinceEpoch))
      }
      default: // iso8601
        const d = new Date(val)
        if (isNaN(d.getTime())) return undefined
        return d
    }
  }

  dates (attr: string, typeHint?: 'ldap' | 'unix' | 'millis' | 'iso' | 'windows') {
    const vals = this.all(attr)
    return vals.map(v => LdapEntry.date(v, typeHint)).filter(d => d != null) as Date[]
  }

  date (attr: string, typeHint?: 'ldap' | 'unix' | 'millis' | 'iso' | 'windows') {
    return this.dates(attr, typeHint)[0] as Date | undefined
  }

  one (attr: string) {
    return this.get(attr)
  }

  first (attr: string) {
    return this.get(attr)
  }

  all (attr: string) {
    const lcAttr = attr.toLocaleLowerCase()
    if (lcAttr === 'dn') return [this.dn]
    return (this.attrs.get(lcAttr)?.values ?? []).map(val => Buffer.isBuffer(val) ? val.toString('base64') : val)
  }

  buffer (attr: string) {
    return this.buffers(attr)[0] as Buffer<ArrayBufferLike> | undefined
  }

  buffers (attr: string) {
    return this.attrs.get(attr.toLocaleLowerCase())?.values.map(val => Buffer.isBuffer(val) ? val : Buffer.from(val, 'utf-8')) ?? []
  }

  binary (attr: string) {
    return this.buffer(attr)
  }

  binaries (attr: string) {
    return this.buffers(attr)
  }

  isBinary (attr: string) {
    const val = this.attrs.get(attr.toLocaleLowerCase())?.values[0]
    return val && Buffer.isBuffer(val)
  }

  options (attr: string) {
    return this.attrs.get(attr.toLocaleLowerCase())?.type.split(';').slice(1) ?? []
  }

  toJSON () {
    const obj: Record<string, string | string[] | Buffer | Buffer[]> = { dn: this.dn }
    for (const attr of this.attrs.values()) {
      const baseAttr = attr.type.split(';', 2)[0]
      const lcAttr = baseAttr.toLocaleLowerCase()
      const resolvedAttr = (this.client as any).preserveAttributeCase ? baseAttr : lcAttr
      const values = this.attrs.get(lcAttr)?.values
      if (values?.length) {
        if (this.isBinary(baseAttr)) {
          const buffers = values as Buffer<ArrayBufferLike>[]
          if (buffers.length === 1) obj[resolvedAttr] = buffers[0].toString('base64')
          else obj[resolvedAttr] = buffers.map((b: Buffer) => b.toString('base64'))
        } else {
          if (values.length === 1) obj[resolvedAttr] = values[0]
          else obj[resolvedAttr] = values
        }
      }
    }
    return obj as T
  }

  pojo () {
    return this.toJSON()
  }

  toString () {
    return JSON.stringify(this.toJSON(), null, 2)
  }

  async range (attr: string, low: number, high: number) {
    if (!this.options(attr).some(o => o.startsWith('range='))) {
      const values = this.all(attr)
      return { values: values.slice(low, high), hasMore: high < values.length }
    }
    const attrWithOptions = [attr, ...this.options(attr).filter(o => !o.startsWith('range='))].join(';')
    const entry = await this.client.load(this.dn, [attrWithOptions + `;range=${low}-${high}`])
    const values = entry?.all(attr) ?? []
    return { values, hasMore: entry?.options(attr).some(o => o.startsWith('range=') && !o.endsWith('*') && values.length > 0) ?? false }
  }

  async * pages (attr: string, pageSize = Number.MAX_SAFE_INTEGER) {
    const firstPage = this.all(attr)
    yield firstPage
    if (!this.options(attr).some(o => o.startsWith('range=') || o.endsWith('*'))) return
    pageSize = Math.min(pageSize, firstPage.length)
    let low = firstPage.length
    while (true) {
      const high = low + pageSize - 1
      const { values, hasMore } = await this.range(attr, low, high)
      yield values
      if (!hasMore) break
      low = high + 1
    }
  }

  async fullRange (attr: string) {
    const ret: string[] = []
    for await (const page of this.pages(attr)) ret.push(...page)
    return ret
  }
}
