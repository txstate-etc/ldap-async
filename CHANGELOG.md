# Changelog

## 3.2.0

### Added
- Tracing via `node:diagnostics_channel`. Every search, add, modify, delete and modifyDN is published on the `ldap-async:operation` TracingChannel, and time spent waiting for a pool connection is published on `ldap-async:connection:wait`. Nothing is published unless something subscribes. See the Tracing section of the README.
- The `LdapTraceContext`, `LdapOperation` and `ConnectionWaitMessage` types are exported.

### Fixed
- Requests no longer hang forever after the LDAP server has been down. A failed connection used to keep its slot in the pool without ever releasing it, so once the pool filled up with failures, every later request waited indefinitely.
- A connection that ldapts reconnected after a drop is now re-bound before use, instead of running operations unauthenticated.
- TypeScript types now resolve correctly in ESM projects, including the `ldap-async/client` entry point.
- A search stream that fails is now destroyed instead of only emitting an error, so it always closes.

### Changed
- Requires Node 22 or later, following ldapts 9.
- Updated to ldapts 9.
