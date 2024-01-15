import { Change, type Client, type ClientOptions, type Control, createClient, type SearchOptions, type SearchEntry, type Attribute, EqualityFilter, type Filter, OrFilter } from 'ldapjs'
import { TextDecoder } from 'node:util'
import { Readable, finished } from 'stream'

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
  logger?: {
    debug: (...args: string[]) => void
    info: (...args: string[]) => void
    warn: (...args: string[]) => void
    error: (...args: string[]) => void
  }
}

interface LdapClient extends Client {
  busy?: boolean
}

export interface LdapChange {
  operation: string
  modification: any
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

const utfDecoder = new TextDecoder('utf8', { fatal: true })
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
  protected clients: LdapClient[]
  protected poolSize: number
  protected bindDN: string
  protected bindCredentials: string
  protected poolQueue: ((client: LdapClient) => void)[]
  protected closeRequest?: (value?: any) => void
  private console: NonNullable<LdapConfig['logger']>

  constructor (config: LdapConfig = {}) {
    if (!config.url) {
      const secure = config.secure ?? process.env.LDAP_SECURE
      const host = config.host ?? process.env.LDAP_HOST ?? ''
      const port = config.port ?? process.env.LDAP_PORT
      delete config.secure
      delete config.host
      delete config.port
      config.url = `${secure ? 'ldaps://' : 'ldap://'}${host}:${port ?? (secure ? '636' : '389')}`
    }

    this.console = config.logger ?? console
    this.bindDN = config.bindDN ?? process.env.LDAP_DN ?? ''
    this.bindCredentials = config.bindCredentials ?? process.env.LDAP_PASSWORD ?? process.env.LDAP_PASS ?? ''
    delete config.bindDN
    delete config.bindCredentials

    if (!config.reconnect || config.reconnect === true) config.reconnect = {}
    if (!config.reconnect.initialDelay) config.reconnect.initialDelay = 500
    if (!config.reconnect.failAfter) config.reconnect.failAfter = Number.MAX_SAFE_INTEGER
    if (!config.reconnect.maxDelay) config.reconnect.maxDelay = 5000
    this.config = config as ClientOptions

    this.poolSize = config.poolSize ?? (parseInt(process.env.LDAP_POOLSIZE ?? 'NaN') || 5)
    this.clients = []
    this.poolQueue = []
  }

  protected async connect () {
    const client = createClient(this.config) as LdapClient
    client.busy = true
    this.clients.push(client)

    try {
      return await new Promise<LdapClient>((resolve, reject) => {
        client.on('connect', () => {
          client.removeAllListeners('error')
          client.removeAllListeners('connectError')
          client.removeAllListeners('setupError')
          client.on('error', e => { reject(e) })
          client.bind(this.bindDN, this.bindCredentials, err => {
            if (err) { reject(err); return }
            client.removeAllListeners('error')
            client.on('error', e => { this.console.warn('Caught an error on ldap client, it is probably a connection problem that will auto-reconnect.', e.message) })
            resolve(client)
          })
        })
        client.on('error', (err) => {
          reject(err)
        })
        client.on('connectError', (err) => {
          reject(err)
        })
        client.on('setupError', (err) => {
          reject(err)
        })
      })
    } catch (e) {
      client.destroy()
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
        client = await new Promise<LdapClient>(resolve => {
          this.poolQueue.push(client => {
            resolve(client)
          })
        })
      }
    }
    client.busy = true
    return client
  }

  protected release (client: LdapClient) {
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
    for (const client of this.clients) client.unbind()
    this.clients = []
  }

  async wait () {
    let loops = 0
    while (true) {
      try {
        const client = await this.getClient()
        this.release(client)
      } catch (e) {
        if (loops++ < 2) this.console.warn('Unable to connect to LDAP. Trying again in 2 seconds.')
        else if (typeof this.config.reconnect === 'object' && loops > (this.config.reconnect.failAfter! / 2000)) {
          throw new Error('Unable to connect to LDAP after ' + (loops * 2) + ' seconds.')
        } else this.console.error('Unable to connect to LDAP. Trying again in 2 seconds.')
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
            for (const entry of results) ret.set(entry.get('dn')!, entry)
          }))
        }
        Promise.all(promises).then(() => { resolve(ret) }).catch(reject)
      }, 0)
    })
    const entries = await this.loadPromises[attrKey]!
    return entries.get(dn)
  }

  async search<T = any> (base: string, options?: SearchOptions, controls?: Control | Control[]) {
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
      options.paged.pagePause = true
    }
    let unpause: (() => void) | undefined
    let paused = true
    let canceled = false
    const stream = new Readable({ objectMode: true, autoDestroy: true }) as GenericReadable<LdapEntry<T>>
    stream._read = () => {
      paused = false
      unpause?.()
      unpause = undefined
    }
    stream._destroy = (err: Error, cb) => {
      canceled = true
      cb(err)
    }
    const stacktraceError: { stack?: string } = {}
    Error.captureStackTrace(stacktraceError, this.stream)
    const sendError = (e: any) => {
      if (canceled) return
      e.clientstack = e.stack
      e.stack = (stacktraceError.stack ?? '').replace(/^Error:/, `Error: ${e.message as string ?? ''}`)
      stream.emit('error', e)
    }

    this.getClient().then(client => {
      finished(stream as Readable, () => { this.release(client) })
      client.search(base, options ?? {}, controls ?? [], (err, result) => {
        if (err) { sendError(err); return }

        result.on('searchEntry', data => {
          if (canceled) return
          if (!stream.push(new LdapEntry(data, this))) paused = true
        })

        result.on('page', (result, cb) => {
          if (paused && !canceled) unpause = cb
          else cb?.()
        })

        result.on('error', sendError)

        result.on('end', (result) => {
          if (canceled) return
          if (result?.status === 0) {
            stream.push(null)
          } else {
            sendError(new Error(`${result?.errorMessage ?? 'LDAP Search Failed'}\nStatus: ${result?.status ?? 'undefined'}`))
          }
        })
      })
    }).catch(sendError)
    return stream
  }

  protected async useClient<T>(callback: (client: LdapClient) => Promise<T>) {
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
  async modify (dn: string, operation: string, modification: any): Promise<boolean>
  async modify (dn: string, changes: Change[]): Promise<boolean>
  async modify (dn: string, operationOrChanges: string | LdapChange[], modification?: any) {
    const changes = Array.isArray(operationOrChanges)
      ? operationOrChanges.map(c => new Change(c))
      : [new Change({ operation: operationOrChanges, modification })]
    return await this.useClient(async client => await new Promise<boolean>((resolve, reject) => {
      client.modify(dn, changes, err => {
        if (err) reject(err)
        else resolve(true)
      })
    }))
  }

  /**
   * Add an object into the system.
   */
  async add (newDn: string, entry: any) {
    return await this.useClient(async client => await new Promise<boolean>((resolve, reject) => {
      client.add(newDn, entry, err => {
        if (err) reject(err)
        else resolve(true)
      })
    }))
  }

  /**
   * Remove an object from the system.
   */
  async remove (dn: string) {
    return await this.useClient(async client => await new Promise<boolean>((resolve, reject) => {
      client.del(dn, err => {
        if (err) reject(err)
        else resolve(true)
      })
    }))
  }

  /**
   * Rename an object.
   */
  async modifyDN (oldDn: string, newDn: string) {
    return await this.useClient(async client => await new Promise<boolean>((resolve, reject) => {
      client.modifyDN(oldDn, newDn, err => {
        if (err) reject(err)
        else resolve(true)
      })
    }))
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

  private async getMemberRecur (ret: Readable, g: LdapEntry, groupsExplored: Set<string>) {
    const members = await g.fullRange('member')
    const batchMap = batchOnBase(members.map(searchForDN))
    const groups: LdapEntry[] = []
    for (const [basedn, batches] of Object.entries(batchMap)) {
      for (const filter of batches) {
        const strm = this.stream(basedn, { scope: 'sub', filter })
        for await (const m of strm) {
          const isGroup = m.one('member') != null
          if (isGroup) groups.push(m)
          else {
            const feedme = ret.push(m)
            if (!feedme) {
              await new Promise(resolve => {
                ret.on('resume', () => {
                  ret.removeAllListeners('resume')
                  resolve(undefined)
                })
              })
            }
          }
        }
      }
    }
    for (const sg of groups) {
      const dn = sg.one('dn')!
      if (!groupsExplored.has(dn)) {
        groupsExplored.add(dn)
        await this.getMemberRecur(ret, sg, groupsExplored)
      }
    }
  }

  getMemberStream<T = any> (groupdn: string) {
    const ret = new Readable({ objectMode: true, highWaterMark: 100 }) as GenericReadable<LdapEntry<T>>
    ret._read = () => {}
    this.get(groupdn).then(async g => {
      await this.getMemberRecur(ret, g, new Set(groupdn))
      ret.push(null)
    }).catch(e => ret.destroy(e))
    return ret
  }

  async getMembers<T = any> (groupdn: string) {
    const strm = this.getMemberStream<T>(groupdn)
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

const binaryAttributes = new Set(['photo', 'personalsignature', 'audio', 'jpegphoto', 'javaserializeddata', 'thumbnaildhoto', 'thumbnaillogo', 'userpassword', 'usercertificate', 'cacertificate', 'authorityrevocationlist', 'certificaterevocationlist', 'crosscertificatepair', 'x500uniqueidentifier'])

export class LdapEntry<T = any> {
  attrs = new Map<string, Attribute>()
  constructor (data: SearchEntry, protected client: Ldap) {
    for (const attr of data.attributes) {
      const attrWithoutOptions = attr.type.split(';', 2)[0]!.toLocaleLowerCase()
      this.attrs.set(attrWithoutOptions, attr)
    }
  }

  get (attr: string) {
    return this.attrs.get(attr.toLocaleLowerCase())?.values?.[0]
  }

  one (attr: string) {
    return this.get(attr.toLocaleLowerCase())
  }

  first (attr: string) {
    return this.get(attr.toLocaleLowerCase())
  }

  all (attr: string) {
    return this.attrs.get(attr.toLocaleLowerCase())?.values as string[] ?? []
  }

  buffer (attr: string) {
    return this.attrs.get(attr.toLocaleLowerCase())?.buffers?.[0]
  }

  buffers (attr: string) {
    return this.attrs.get(attr.toLocaleLowerCase())?.buffers ?? []
  }

  binary (attr: string) {
    return this.buffer(attr)
  }

  binaries (attr: string) {
    return this.buffers(attr)
  }

  isBinary (attr: string) {
    const lcAttr = attr.toLocaleLowerCase()
    return binaryAttributes.has(lcAttr) || this.options(lcAttr).includes('binary') || this.attrs.get(lcAttr)?.buffers.some(b => {
      try {
        utfDecoder.decode(b)
        return false
      } catch {
        return true
      }
    })
  }

  protected optionsCache: string[] | undefined
  options (attr: string) {
    this.optionsCache ??= this.attrs.get(attr.toLocaleLowerCase())?.type.split(';').slice(1)
    return this.optionsCache ?? []
  }

  toJSON () {
    const obj: Record<string, string | string[] | Buffer | Buffer[]> = {}
    for (const attr of this.attrs.values()) {
      if (attr.buffers.length > 0) {
        const lcAttr = attr.type.split(';', 2)[0].toLocaleLowerCase()
        if (this.isBinary(lcAttr)) {
          if (attr.values.length === 1) obj[lcAttr] = attr.buffers[0].toString('base64')
          else obj[lcAttr] = attr.buffers.map(b => b.toString('base64'))
        } else {
          if (attr.values.length === 1) obj[lcAttr] = attr.values[0]
          else obj[lcAttr] = attr.values
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
    const dn = this.get('dn')!
    const attrWithOptions = [attr, ...this.options(attr).filter(o => !o.startsWith('range='))].join(';')
    const ret: string[] = []
    while (true) {
      ret.push(...entry.all(attr))
      const pageOpt = entry.options(attr).find(o => o.startsWith('range='))
      if (!pageOpt || pageOpt.endsWith('*') || entry.all(attr).length === 0) return ret
      const [, rangeStr] = pageOpt.split('=')
      const [low, high] = rangeStr.split('-').map(Number)
      const pageSize = 1 + high - low
      const newLow = high + 1
      const newHigh = newLow + pageSize - 1
      entry = (await this.client.load(dn, attrWithOptions + `;range=${newLow}-${newHigh}`))!
    }
  }
}
