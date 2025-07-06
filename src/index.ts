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
  startTLSCert?: string | Buffer | boolean
  logger?: {
    debug: (...args: string[]) => void
    info: (...args: string[]) => void
    warn: (...args: string[]) => void
    error: (...args: string[]) => void
  }
}
const localConfig = new Set(['host', 'port', 'secure', 'poolSize', 'startTLSCert', 'logger'])

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

function valToString (val: any) {
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE'
  if (typeof val === 'number') return String(val)
  return val
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

export default class Ldap {
  protected connectpromise?: Promise<void>
  protected config: ClientOptions
  protected clients: (Client & { busy?: boolean })[]
  protected poolSize: number
  protected bindDN: string
  protected bindCredentials: string
  protected startTLSCert?: string | Buffer | boolean
  protected poolQueue: ((client: Client & { busy?: boolean }) => void)[]
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
    this.clients = []
    this.poolQueue = []
  }

  protected async connect () {
    const client = Object.assign(new Client({ url: this.config.url }), { busy: true })
    this.clients.push(client)
    return await this.bindConnection(client)
  }

  protected async bindConnection (client: Client & { busy?: boolean }) {
    try {
      if (this.startTLSCert) {
        await client.startTLS({ cert: this.startTLSCert !== true ? this.startTLSCert : undefined })
      }
      await client.bind(this.bindDN, this.bindCredentials)
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
          this.poolQueue.push(client => {
            resolve(client)
          })
        })
      }
    }
    client.busy = true
    if (!client.isConnected) await this.bindConnection(client)
    return client
  }

  protected release (client: Client & { busy?: boolean }) {
    client.busy = false
    const nextInQueue = this.poolQueue.shift()
    if (nextInQueue) nextInQueue(client)
    else if (this.clients.every(c => !c.busy)) this.closeRequest?.()
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
            const keepGoing = stream.push(new LdapEntry(entry, this))
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
    const values = (Array.isArray(val) ? val : (val == null ? [] : [val])).map(valToString)
    return await this.modify(dn, 'replace', { type: attribute, values })
  }

  /**
   * Use this method to completely replace multiple attributes. If any of the given attributes
   * are array attributes, any existing values will be lost.
   *
   * If you need to mix set and push operations, you can do multiple round trips or you can send
   * multiple operations to the `modify` method.
   */
  async setAttributes (dn: string, modification: Record<string, ValidAttributeInput | ValidAttributeInput[] | undefined>) {
    const changes = Object.entries(modification).map(([attr, val]) => ({ operation: 'replace', modification: { type: attr, values: (Array.isArray(val) ? val : (val == null ? [] : [val])).map(valToString) } }))
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
    const attr = current.all(attribute)
    const existingValues = new Set(Array.isArray(attr) ? attr : [attr])
    const newValues = values.filter(v => !existingValues.has(v))
    if (newValues.length === 0) return true
    return await this.modify(dn, 'add', { type: attribute, values: newValues })
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
    const attr = current.all(attribute)
    const existingValues = new Set(Array.isArray(attr) ? attr : [attr])
    const oldValues = values.filter(v => existingValues.has(v))
    if (oldValues.length === 0) return true
    return await this.modify(dn, 'delete', { type: attribute, values: oldValues })
  }

  async removeAttribute (dn: string, attribute: string) {
    return await this.modify(dn, 'delete', { type: attribute, values: [] })
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

export class LdapEntry<T = any> {
  attrs = new Map<string, { type: string, values: string[] | Buffer<ArrayBufferLike>[] }>()
  dn: string
  constructor (data: Entry, protected client: Ldap) {
    this.dn = data.dn
    for (const [key, value] of Object.entries(data)) {
      const attrWithoutOptions = key.split(';', 2)[0].toLocaleLowerCase()
      this.attrs.set(attrWithoutOptions, {
        type: key,
        values: (Array.isArray(value) ? value : [value]) as string[] | Buffer<ArrayBufferLike>[]
      })
    }
  }

  get (attr: string) {
    return this.all(attr)[0] as string | undefined
  }

  one (attr: string) {
    return this.get(attr)
  }

  first (attr: string) {
    return this.get(attr)
  }

  all (attr: string) {
    if (attr === 'dn') return [this.dn]
    return (this.attrs.get(attr.toLocaleLowerCase())?.values ?? []).map(val => Buffer.isBuffer(val) ? val.toString('base64') : val)
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

  protected optionsCache: string[] | undefined
  options (attr: string) {
    this.optionsCache ??= this.attrs.get(attr.toLocaleLowerCase())?.type.split(';').slice(1)
    return this.optionsCache ?? []
  }

  toJSON () {
    const obj: Record<string, string | string[] | Buffer | Buffer[]> = { dn: this.dn }
    for (const attr of this.attrs.values()) {
      const lcAttr = attr.type.split(';', 2)[0].toLocaleLowerCase()
      const values = this.attrs.get(lcAttr)?.values
      if (values?.length) {
        if (this.isBinary(lcAttr)) {
          const buffers = values as Buffer<ArrayBufferLike>[]
          if (buffers.length === 1) obj[lcAttr] = buffers[0].toString('base64')
          else obj[lcAttr] = buffers.map((b: Buffer) => b.toString('base64'))
        } else {
          if (values.length === 1) obj[lcAttr] = values[0]
          else obj[lcAttr] = values
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

  async fullRange (attr: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let entry: LdapEntry = this
    const attrWithOptions = [attr, ...this.options(attr).filter(o => !o.startsWith('range='))].join(';')
    const ret: string[] = []
    while (true) {
      const allVals = entry.all(attr)
      if (allVals) ret.push(...allVals)
      const pageOpt = entry.options(attr).find(o => o.startsWith('range='))
      if (!pageOpt || pageOpt.endsWith('*') || !allVals) return ret
      const [, rangeStr] = pageOpt.split('=')
      const [low, high] = rangeStr.split('-').map(Number)
      const pageSize = 1 + high - low
      const newLow = allVals.length ? high + 1 : low
      const newHigh = allVals.length ? newLow + pageSize - 1 : '*'
      entry = (await this.client.load(this.dn, [attrWithOptions + `;range=${newLow}-${newHigh}`]))!
    }
  }
}
