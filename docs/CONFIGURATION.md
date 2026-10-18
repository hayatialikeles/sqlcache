# Configuration Guide

Complete configuration reference for sqlcache.

---

## Environment Variables

sqlcache reads its settings from `process.env` when it is first required. It loads `.env` from the
working directory (only that file, and `${VAR}` references are not expanded); variables already set
in the environment take precedence. A commented template is in `node_modules/sqlcache/.env.example`.

### Required Configuration

```bash
# MySQL Database
DB_HOST=localhost              # MySQL host
DB_USERNAME=root               # MySQL username
DB_NAME=mydb                   # Database name

# Redis Cache (required unless REDIS_ENABLED=false)
REDIS_SERVER=localhost         # Redis host
```

### Optional Configuration

#### Database Settings

```bash
DB_PASSWORD=secret                    # MySQL password (default: empty)
DB_PORT=3306                          # MySQL port (default: 3306)
DB_CONNECTION_LIMIT=10                # Max connections in pool, per process (default: 151)
DB_QUEUE_LIMIT=0                      # Max queued requests (default: 0 = unlimited)
DB_CONNECT_TIMEOUT=10000              # Connection timeout in ms (default: 10000)
DB_MULTIPLE_STATEMENTS=false          # Allow multiple statements (default: true, for backward compatibility; false is recommended for new projects)
DB_COALESCE_QUERIES=true              # Concurrent identical cache misses share one query (default: true)
DB_COALESCE_MAX_WAIT=10000            # Max wait (ms) for such a shared query before running a fresh one (default: 10000, v2.9.1)
DB_PAGINATION_REUSE_TOTAL=false       # Reuse a query's pagination total across pages (default: false)
DB_MAX_IDLE=10                        # Idle connections kept in the pool (default: 10)
DB_IDLE_TIMEOUT=60000                 # Idle time (ms) before connections above DB_MAX_IDLE close (default: 60000)
TIMEZONE=+00:00                       # Timezone offset (default: +00:00)
```

`DB_MULTIPLE_STATEMENTS=true` lets an SQL injection run additional statements; new projects should
set it to `false` unless they send several statements in one query. The default stays `true` in 2.x.

Size the pool for the whole deployment: instances × workers × `DB_CONNECTION_LIMIT`, plus any other
clients, must stay below MySQL's `max_connections`. MySQL's default `max_connections` is 151, the same
as sqlcache's default limit, so a second process with default settings can already exceed it.

#### Redis Settings

```bash
REDIS_PORT=6379                       # Redis port (default: 6379)
REDIS_PASSWORD=secret                 # Redis password (if required)
REDIS_VHOST=my_app                    # Redis key namespace/prefix, keys become my_app:<key> (set once per process)
REDIS_ENABLED=true                    # Enable/disable Redis (default: true)
```

#### Redis Resilience & Performance

```bash
REDIS_WAIT_TIMEOUT=10000              # Max wait (ms) for Redis to (re)connect before falling back (default: 10000)
REDIS_FAIL_FAST=true                  # After REDIS_WAIT_TIMEOUT of downtime, cache reads/writes stop waiting (default: true)
REDIS_COMMAND_TIMEOUT=10000           # Max time (ms) a cache read/write may stay unanswered (default: max(REDIS_WAIT_TIMEOUT, 10000), 0 = off)
REDIS_RECONNECT_MAX_DELAY=5000        # Max delay (ms) between reconnect attempts (default: 5000; 30000 before v2.9.0)
REDIS_SCAN_COUNT=1000                 # Keys examined per SCAN round trip in prefix deletes (default: 1000; 100 before v2.9.0)
```

Deletes (`delKeyItem`, `delPrefixKeyItem`, invalidation after writes) always wait for Redis and are
never cut short by `REDIS_COMMAND_TIMEOUT`; deletes that fail because Redis is unreachable are
replayed once it is ready again. See [MIGRATION.md](MIGRATION.md#v28x--v290-performance--resilience)
for the full list of v2.9.0 changes and how to restore v2.8.x behavior.

With `REDIS_ENABLED=false` no Redis connection is opened unless a Redis function
(`getArrayItem`, `getRedisClient`, ...) is called directly. Since v2.9.1 `isRedisConnected()` then
returns `false` without opening one.

`REDIS_VHOST` applies to the whole process. Changing it at runtime (for example per tenant request)
mixes the cache entries of concurrent requests; v2.9.1 logs a one-time warning when it changes.

Redis is a trusted store: cached rows are returned as stored. Protect it with AUTH
(`REDIS_PASSWORD`) and a private network, and give each application its own `REDIS_VHOST` or Redis
database.

#### Smart Features (v2.6.0)

```bash
CORE_AUTO_FEATURES=true              # Auto cache keys only (does not enable invalidation)
CORE_AUTO_INVALIDATION=true          # Auto cache invalidation
```

Set both to use automatic keys together with automatic invalidation.

---

## Programmatic Configuration

### All-in-One Setup

```javascript
const { configure } = require('sqlcache');

configure({
    autoKey: {
        enabled: true
    },
    autoInvalidation: {
        enabled: true,
        tables: {
            users: ['users:*', 'users_*', 'profiles_*', 'sessions_*'],
            orders: ['orders:*', 'orders_*', 'cart_*', 'analytics_*'],
            products: ['products:*', 'products_*', 'catalog_*']
        }
    }
});
```

A `tables` rule replaces the default `<table>_*` and `<table>:*` patterns for that table. Automatic
keys start with `<table>:`, so keep `<table>:*` in the rule when you use them.

### Individual Feature Configuration

```javascript
const { enableAutoKey, enableAutoInvalidation } = require('sqlcache');

// Enable auto key generation
enableAutoKey({ enabled: true });

// Enable auto invalidation with custom rules
enableAutoInvalidation({
    enabled: true,
    tables: {
        users: ['users:*', 'users_*'],
        orders: ['orders:*', 'orders_*', 'analytics_*']
    }
});

// Turn features off again (`false` works since v2.9.1; earlier versions turned the feature on for it)
enableAutoKey(false);
enableAutoInvalidation({ enabled: false });
```

`enableAutoKey`, `enableAutoInvalidation` and the `autoKey` / `autoInvalidation` options of
`configure` accept `true`/`false` as well as an options object.

---

## Configuration by Environment

sqlcache itself only loads `.env`. To keep one file per environment, load it yourself before the
first `require('sqlcache')` (with `dotenv` in your own dependencies); values that are already set
are not overwritten by `.env`:

```javascript
require('dotenv').config({ path: `.env.${process.env.NODE_ENV}` });
const { getCacheQuery } = require('sqlcache');
```

Secrets such as `DB_PASSWORD` and `REDIS_PASSWORD` are best set in the process environment by your
deployment. `${VAR}` references in these files are not expanded: `DB_PASSWORD=${PROD_DB_PASSWORD}`
would be used literally.

### Development

```bash
# .env.development
DB_HOST=localhost
DB_USERNAME=root
DB_PASSWORD=dev_password
DB_NAME=myapp_dev
DB_CONNECTION_LIMIT=5
REDIS_SERVER=localhost
REDIS_PORT=6379
CORE_AUTO_FEATURES=true
CORE_AUTO_INVALIDATION=true
```

### Staging

```bash
# .env.staging (DB_PASSWORD and REDIS_PASSWORD come from the environment)
DB_HOST=staging-db.example.com
DB_USERNAME=app_user
DB_NAME=myapp_staging
DB_CONNECTION_LIMIT=20
DB_MULTIPLE_STATEMENTS=false
REDIS_SERVER=staging-redis.example.com
REDIS_PORT=6379
CORE_AUTO_FEATURES=true
CORE_AUTO_INVALIDATION=true
```

### Production

```bash
# .env.production (DB_PASSWORD and REDIS_PASSWORD come from the environment)
DB_HOST=prod-db.example.com
DB_USERNAME=app_user
DB_NAME=myapp_prod
DB_CONNECTION_LIMIT=50
DB_CONNECT_TIMEOUT=5000
DB_MULTIPLE_STATEMENTS=false
REDIS_SERVER=prod-redis.example.com
REDIS_PORT=6379
REDIS_VHOST=myapp_prod
CORE_AUTO_FEATURES=true
CORE_AUTO_INVALIDATION=true
```

---

## Connection Pool Tuning

The limits below are per process. Multiply by the number of instances and workers, add other
clients, and keep the sum below MySQL's `max_connections` (default 151).

### Small Application (< 100 concurrent users)

```bash
DB_CONNECTION_LIMIT=10
DB_QUEUE_LIMIT=0
DB_CONNECT_TIMEOUT=10000
```

### Medium Application (100-1000 concurrent users)

```bash
DB_CONNECTION_LIMIT=50
DB_QUEUE_LIMIT=100
DB_CONNECT_TIMEOUT=5000
```

### Large Application (1000+ concurrent users)

```bash
DB_CONNECTION_LIMIT=100
DB_QUEUE_LIMIT=500
DB_CONNECT_TIMEOUT=3000
```

### Bursty Traffic

Connections above `DB_MAX_IDLE` are closed once idle for `DB_IDLE_TIMEOUT` and opened again on the
next burst. If load comes in bursts further apart than that (e.g. scheduled jobs), every burst pays
for new connections; keep them warm by raising `DB_MAX_IDLE` towards `DB_CONNECTION_LIMIT` or by
raising `DB_IDLE_TIMEOUT`:

```bash
DB_CONNECTION_LIMIT=50
DB_MAX_IDLE=50
```

### Large Result Sets and Deep Pages

- Cached results are stored as JSON, and serializing and parsing grow with the number of rows (see
  the README's Performance section), so prefer `getCacheQueryPagination` over caching very large
  results. On a cache hit a `Date` is an ISO string and a `Buffer` is `{ type, data }`, while a miss
  returns mysql2's types; normalize such columns in your code.
- Pagination uses `LIMIT offset, size`; MySQL reads and skips `offset` rows, so very deep pages cost
  more. For long lists, an indexed `WHERE id > ?` (keyset) condition in the SQL stays fast at any depth.
- `DB_PAGINATION_REUSE_TOTAL=true` avoids recounting the total on every page miss of large lists.

### Monitoring Pool Usage

```javascript
const { getPoolStats } = require('sqlcache');

setInterval(() => {
    const stats = getPoolStats();
    console.log({
        total: stats.totalConnections,
        active: stats.activeConnections,
        free: stats.freeConnections,
        queued: stats.queuedRequests
    });

    // Connections are opened on demand, so an idle pool has 0 of 0 connections in use.
    // Requests waiting for a connection are what shows an exhausted pool.
    if (stats.queuedRequests > 0) {
        console.warn('⚠️ Connection pool exhausted: requests are waiting for a connection');
    }
}, 60000); // Check every minute
```

---

## Cache Configuration

### Default Cache TTL

```javascript
const { addArrayItem } = require('sqlcache');

// Default TTL: 40000 seconds (~11 hours)
await addArrayItem('my-key', data);

// Custom TTL: 1 hour
await addArrayItem('my-key', data, 3600);

// Custom TTL: 5 minutes
await addArrayItem('my-key', data, 300);
```

### Cache Invalidation Patterns

#### Default Patterns

When auto-invalidation is enabled, default patterns are:
- `{table}_*` (underscore prefix)
- `{table}:*` (colon prefix)

```javascript
// INSERT INTO users triggers:
// - Clears: users_*
// - Clears: users:*
```

They apply to `QuaryCache` and `tx.query` writes without a `resetCacheName`, and since v2.9.1 also to
`bulkInsert` without one. A `resetCacheName` replaces the automatic patterns for that call.

#### Custom Patterns

A rule replaces the defaults for its table, so keep `{table}:*` when you use automatic keys:

```javascript
enableAutoInvalidation({
    enabled: true,
    tables: {
        users: [
            'users:*',        // Automatic keys
            'users_*',        // All user caches
            'profiles_*',     // User profiles
            'sessions_*',     // User sessions
            'feed:*'          // User feeds
        ],
        orders: [
            'orders:*',
            'orders_*',
            'cart_*',
            'analytics_orders_*'
        ]
    }
});
```

Patterns are Redis glob patterns used as prefixes: escape `*`, `?`, `[`, `]` and `\` in any part that
comes from user input. An empty prefix without `REDIS_VHOST` deletes every key in that Redis database.

### Disable Redis

```bash
REDIS_ENABLED=false
```

```javascript
// Queries execute normally without caching
const users = await getCacheQuery('SELECT * FROM users', [], 'users:all');
// No Redis involved (a cache name is still required unless automatic keys are enabled)
```

---

## Auto Key Generation Strategy

Automatic keys are used when a call has no cache name and `CORE_AUTO_FEATURES=true` (or
`enableAutoKey()`) is set.

### Detailed Strategy (1-3 parameters)

```javascript
// Query
SELECT * FROM users WHERE id = ? AND status = ?

// Generated key
users:id:status:a7b3c2d1
```

### Simple Strategy (4+ parameters)

```javascript
// Query
SELECT * FROM orders WHERE a = ? AND b = ? AND c = ? AND d = ?

// Generated key
orders:9f2ac12b
```

### Other Keys

- No `WHERE` clause: `<table>:all`, whatever the rest of the SQL.
- No detectable table (`CALL ...`, `SELECT fn(?)`): `query:<sqlhash>:<paramhash>` since v2.9.1
  (earlier versions left the parameters out).
- Calls with a `database` argument: the key ends with `@<database>`.

### Limits

The select list, `ORDER BY`, `LIMIT`, literal values and joined tables are not part of the key, and
the parameter hash is 32-bit, so different queries can share a key. Use explicit cache names for
aggregates, joins, `LIMIT`/`ORDER BY` variants, time-relative SQL (`NOW()`, `CURDATE()`) and anything
user-specific or sensitive.

### Manual Override

```javascript
// Auto key
const users = await getCacheQuery('SELECT * FROM users WHERE id = ?', [123]);

// Manual key (overrides auto)
const users = await getCacheQuery('SELECT * FROM users WHERE id = ?', [123], 'my-custom-key');
```

---

## Security Best Practices

### Environment Variables

```bash
# NEVER commit passwords to git
# Use environment variables or secrets management

# Good: set DB_PASSWORD and REDIS_PASSWORD in the process environment (e.g. container secrets);
# they take precedence over .env. A line like DB_PASSWORD=${DATABASE_PASSWORD} in .env is
# NOT expanded and would be used literally.

# Bad: a real password in a committed .env file
DB_PASSWORD=mypassword123
```

### SQL Injection Protection

```javascript
// ✅ Good - Use parameterized queries
await getCacheQuery('SELECT * FROM users WHERE id = ?', [userId], `user:${userId}`);

// ❌ Bad - String interpolation
await getCacheQuery(`SELECT * FROM users WHERE id = ${userId}`, [], `user:${userId}`);
```

- Set `DB_MULTIPLE_STATEMENTS=false` in new projects, so an injection cannot run extra statements.
- `bulkInsert` puts the table name and the keys of the first record into the SQL as-is (v2.9.1
  rejects invalid names before anything is sent). Map request or CSV input onto a fixed list of
  columns; never pass untrusted keys.
- Cache-name prefixes are Redis glob patterns: escape `*`, `?`, `[`, `]` and `\` in user input.

### Redis

- Redis is a trusted store: cached rows are returned as stored. Use AUTH, a private network, and a
  `REDIS_VHOST` or Redis database of the application's own.
- `REDIS_VHOST` is per process. Do not change it per request; for tenants, pass the tenant's
  `database` per call and put the tenant in explicit cache names.

### Error Details

mysql2 errors carry `err.sql` with the parameter values filled in. Do not send whole error objects to
logs or clients you do not trust.

### Connection Limits

```bash
# Prevent connection exhaustion attacks
DB_CONNECTION_LIMIT=50
DB_QUEUE_LIMIT=100
DB_CONNECT_TIMEOUT=5000
```

---

## Troubleshooting

### Connection Errors

```bash
# Error: connect ECONNREFUSED
# Solution: Check if MySQL/Redis is running

mysql -u root -p
redis-cli ping
```

### Too Many Connections

```bash
# Error: Too many connections (ER_CON_COUNT_ERROR)
# Cause: all clients together exceed MySQL's max_connections (default 151)
# Solution: lower DB_CONNECTION_LIMIT so that instances x workers x limit + other clients
# stays below max_connections, or raise max_connections on the server

DB_CONNECTION_LIMIT=30
```

When the pool itself is exhausted, requests wait for a free connection (`queuedRequests` in
`getPoolStats()`), or fail once more than `DB_QUEUE_LIMIT` are waiting.

### Timeout Issues

```bash
# Error: Query timeout exceeded
# Cause: a getCacheQueryWithTimeout() call took longer than its timeout option (default 30000 ms)
# Solution: pass a larger timeout, or optimize the query; DB_CONNECT_TIMEOUT does not affect it
```

```javascript
await getCacheQueryWithTimeout(sql, params, 'report:daily', { timeout: 60000 });
```

### Redis Outage Log Lines

```bash
# "Redis reconnecting... (attempt 3, delay 2000ms)"
#   One line per reconnect attempt (v2.9.1) while Redis is unreachable.
# "Redis operation failed: Redis unavailable for 10234ms — serving cache misses without waiting until it recovers"
#   Redis has been unreachable for REDIS_WAIT_TIMEOUT: cache reads/writes fall back immediately
#   (once per outage). Restore the old wait-on-every-call behavior with REDIS_FAIL_FAST=false.
# "Redis operation failed: Redis get timed out after 10000ms"
#   A command got no reply within REDIS_COMMAND_TIMEOUT. Raise it for slow links, or 0 to disable.
# "Redis gave no reply for 10000ms — reconnecting"
#   The connection was silent while commands waited (e.g. dropped after a failover); it is reopened.
# "Redis: replaying 3 invalidation(s) missed while it was unavailable"
#   Deletes that failed during the outage are being applied now that Redis is back.
```

Since v2.9.1 a line is also logged when more than 1000 invalidations are missed during an outage
(only the most recent 1000 are replayed), and a one-time warning when `REDIS_VHOST` changes at
runtime.

### Cache Issues

```bash
# Clear all cache (FLUSHALL deletes every key on that Redis server, not only sqlcache's)
redis-cli FLUSHALL

# Clear specific pattern (with REDIS_VHOST=my_app the keys start with "my_app:")
redis-cli --scan --pattern "my_app:users_*" | xargs redis-cli DEL
```

---

**[← Back to Main README](../README.md)**
