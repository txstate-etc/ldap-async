import { Change, Client, ClientOptions, Control, createClient, SearchOptions } from 'ldapjs'
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

export default class Ldap {
  protected connectpromise?: Promise<void>
  protected config: ClientOptions
  protected clients: LdapClient[]
  protected poolSize: number
  protected bindDN: string
  protected bindCredentials: string
  protected poolQueue: ((client: LdapClient) => void)[]

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
          client.bind(this.bindDN, this.bindCredentials, err => {
            if (err) reject(err)
            client.on('error', e => console.warn('Caught an error on ldap client, it is probably a connection problem that will auto-reconnect.', e.message))
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
  }

  async wait () {
    let loops = 0
    while (true) {
      try {
        const client = await this.getClient()
        this.release(client)
      } catch (e) {
        if (loops++ < 2) console.log('Unable to connect to LDAP, trying again in 2 seconds.')
        else console.error('Unable to connect to LDAP. Trying again in 2 seconds.')
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  }

  async get<T = any> (base: string, options?: SearchOptions, controls?: Control | Control[]) {
    return (await this.search<T>(base, options, controls))[0]
  }

  async search<T = any> (base: string, options?: SearchOptions, controls?: Control | Control[]) {
    const stream = this.stream<T>(base, options, controls)
    const results: T[] = []
    for await (const result of stream) {
      results.push(result)
    }
    return results
  }

  stream<T = any> (base: string, options: SearchOptions = {}, controls?: Control | Array<Control>) {
    if (!options.paged || options.paged === true) options.paged = {}
    if (!options.paged.pageSize) options.paged.pageSize = 200
    options.paged.pagePause = true
    let unpause: Function | undefined
    let paused = true
    let canceled = false
    const stream = new Readable({ objectMode: true, autoDestroy: true }) as GenericReadable<T>
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
        if (err) return sendError(err)

        result.on('searchEntry', data => {
          if (canceled) return
          if (!stream.push({ ...data.object, _raw: data.raw })) paused = true
        })

        result.on('page', (result, cb) => {
          if (paused) unpause = cb
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
  async modify (dn: string, operation: string, modification: any): Promise<Boolean>
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
  async setAttribute (dn: string, attribute: string, value: any) {
    return await this.modify(dn, 'replace', { [attribute]: value })
  }

  /**
   * Use this method to completely replace multiple attributes. If any of the given attributes
   * are array attributes, any existing values will be lost.
   *
   * If you need to mix set and push operations, you can do multiple round trips or you can send
   * multiple operations to the `modify` method.
   */
  async setAttributes (dn: string, modification: Record<string, any>) {
    const changes = Object.entries(modification).map(([attr, val]) => ({ operation: 'replace', modification: { [attr]: val } }))
    return await this.modify(dn, changes)
  }

  /**
   * Use this method to add more values to an array attribute without removing any existing values. Any
   * values that already exist will be ignored (if you used a raw 'modify' operation, you'd get an error).
   */
  async pushAttribute (dn: string, attribute: string, valueOrValues: string|string[]) {
    const values = Array.isArray(valueOrValues) ? valueOrValues : [valueOrValues]
    const current = await this.get(dn)
    // the ldap client only returns an array when there are 2 or more elements
    // if there is only one element, it comes back as a scalar
    const attr = current[attribute] ?? []
    const existingValues = new Set(Array.isArray(attr) ? attr : [attr])
    const newValues = values.filter(v => !existingValues.has(v))
    if (newValues.length === 0) return true
    return await this.modify(dn, 'add', { [attribute]: newValues })
  }

  /**
   * Use this method to remove the specified values from an array attribute while leaving any other
   * values in place. Any values that don't already exist will be ignored (if you used a raw 'modify'
   * operation, you'd get an error).
   */
  async pullAttribute (dn: string, attribute: string, valueOrValues: string|string[]) {
    const values = Array.isArray(valueOrValues) ? valueOrValues : [valueOrValues]
    const current = await this.get(dn)
    // the ldap client only returns an array when there are 2 or more elements
    // if there is only one element, it comes back as a scalar
    const attr = current[attribute] ?? []
    const existingValues = new Set(Array.isArray(attr) ? attr : [attr])
    const oldValues = values.filter(v => existingValues.has(v))
    if (oldValues.length === 0) return true
    return await this.modify(dn, 'delete', { [attribute]: oldValues })
  }

  async removeAttribute (dn: string, attribute: string) {
    return await this.modify(dn, 'delete', { [attribute]: undefined })
  }

  /**
   * Use this method to add a member to a group. memberdn can be an array. each memberdn can be a group or a person.
   * Any memberdn entries that are already members will be ignored.
   */
  async addMember (memberdn: string|string[], groupdn: string) {
    return await this.pushAttribute(groupdn, 'member', memberdn)
  }

  /**
   * Use this method to remove a member from a group. memberdn can be an array. each memberdn can be a group or a person.
   * Any memberdn entries that are not already members will be ignored.
   */
  async removeMember (memberdn: string|string[], groupdn: string) {
    return await this.pullAttribute(groupdn, 'member', memberdn)
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

  anyall (values: Record<string, string|number>[], wildcards = false) {
    return wildcards
      ? `(|${values.map(v => `(&${Object.entries(v).map(([prop, val]) => this.filterAllowWildcard`(${prop}=${val})`).join('')})`).join('')})`
      : `(|${values.map(v => `(&${Object.entries(v).map(([prop, val]) => this.filter`(${prop}=${val})`).join('')})`).join('')})`
  }
}
