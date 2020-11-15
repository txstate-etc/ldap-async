import { Client, ClientOptions, Control, createClient, SearchOptions } from 'ldapjs'
import { Readable, finished } from 'stream'
import { replacements } from './escape'

type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>
interface StreamIterator <T> {
  [Symbol.asyncIterator]: () => StreamIterator<T>
  next: () => Promise<{ done: boolean, value: T }>
  return: () => Promise<{ done: boolean, value: T }>
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
    const stream = new Readable({ objectMode: true }) as GenericReadable<T>
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

    this.getClient().then(client => client.search(base, options ?? {}, controls ?? [], (err, result) => {
      if (err) return sendError(err)

      result.on('searchEntry', data => {
        if (canceled) return
        if (!stream.push(data.object)) paused = true
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
      finished(stream as Readable, {}, () => this.release(client))
    })).catch(sendError)
    return stream
  }

  filter (strings: TemplateStringsArray, ...values: (string | number)[]) {
    let safe = ''
    strings.forEach((string, i) => {
      safe += string
      if (values.length > i) {
        safe += `${values[i]}`.replace(/[\0()*\\]/gm, (ch: string) => (replacements.filter as any)[ch])
      }
    })
    return safe
  }

  dn (strings: TemplateStringsArray, ...values: (string | number)[]) {
    let safe = ''
    strings.forEach((string, i) => {
      safe += string
      if (values.length > i) {
        safe += `${values[i]}`
          .replace(/["#+,;<=>\\]/gm, (ch) => (replacements.dn as any)[ch])
          .replace(/^ /gm, (ch) => (replacements.dnBegin as any)[ch])
          .replace(/ $/gm, (ch) => (replacements.dnEnd as any)[ch])
      }
    })
    return safe
  }
}
