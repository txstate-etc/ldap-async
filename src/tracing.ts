import { channel, tracingChannel } from 'node:diagnostics_channel'

export type LdapOperation = 'search' | 'add' | 'modify' | 'delete' | 'modifyDN'

/**
 * The context published for every LDAP operation on the `ldap-async:operation` TracingChannel.
 * Higher level methods publish one context per round trip they make, so `pushAttribute` publishes
 * a search followed by a modify.
 */
export interface LdapTraceContext {
  operation: LdapOperation
  /** The search base, or the entry being added, modified, deleted or renamed. */
  dn: string
  /** search only: the filter as sent to the server, values included. */
  filter?: string
  /** search only: 'base', 'one', 'sub' or 'children'. */
  scope?: string
  /** modifyDN only: the entry's new DN. */
  newDn?: string
  /** From the client's url, undefined if it couldn't be parsed. */
  serverAddress?: string
  serverPort?: number
  /** search only: how many entries the search returned, set before the stream's span ends. */
  entries?: number
  /**
   * Set when the operation fails. ldapts errors carry the numeric LDAP result code as `code`;
   * network errors carry a string `code` like 'ECONNREFUSED'.
   */
  error?: Error & { code?: number | string }
  /** Set by the TracingChannel when a non-search operation succeeds. */
  result?: unknown
}

export type TraceInfo = Pick<LdapTraceContext, 'operation' | 'dn' | 'filter' | 'scope' | 'newDn'>

export interface ServerInfo {
  serverAddress?: string
  serverPort?: number
}

const operationChannel = tracingChannel<LdapTraceContext, LdapTraceContext>('ldap-async:operation')

/** The channel, but only when someone is listening, so an unwatched operation skips building its context. */
export function subscribedChannel () {
  return operationChannel.hasSubscribers ? operationChannel : undefined
}

/**
 * Published on the `ldap-async:connection:wait` channel every time an operation gets a connection
 * from the pool, so a subscriber can record how long operations wait for one.
 */
export interface ConnectionWaitMessage {
  /** `host:port` from the url, so two Ldap instances pointed at the same server share a name. */
  poolName: string
  serverAddress?: string
  serverPort?: number
  /**
   * Milliseconds from asking the pool for a connection to having a bound one in hand. Includes
   * waiting in line for a busy pool, and opening and binding a new connection if that was needed.
   */
  duration: number
}

const waitChannel = channel('ldap-async:connection:wait')

export function publishConnectionWait (message: ConnectionWaitMessage) {
  waitChannel.publish(message)
}

export function connectionWaitHasSubscribers () {
  return waitChannel.hasSubscribers
}

/** Host and port from an ldap:// or ldaps:// url, with the protocol's default port filled in. */
export function parseServerUrl (url: string | undefined): ServerInfo {
  if (!url) return {}
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1')
    return {
      serverAddress: host || undefined,
      serverPort: Number(parsed.port) || (parsed.protocol === 'ldaps:' ? 636 : 389)
    }
  } catch {
    return {}
  }
}
