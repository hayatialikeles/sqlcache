# node-caching-mysql-connector-with-redis

[![npm version](https://img.shields.io/npm/v/node-caching-mysql-connector-with-redis.svg)](https://www.npmjs.com/package/node-caching-mysql-connector-with-redis)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

Read-through Redis caching for MySQL in Node.js. You run SQL through a small API and the package
caches the results in Redis, invalidates them when you write, and keeps working when Redis or
MySQL fail.

- **Read-through cache** for `SELECT` results, with prefix-based invalidation after writes
- **Optional automatic cache keys and invalidation**, derived from the SQL
- **Pagination, transactions, bulk inserts and query timeouts** with the same caching model
- **Built for failure.** Redis outages degrade to plain MySQL reads, connections and caches recover
  on their own, and it is tested against 18 Docker chaos scenarios
- **Efficient under load.** Concurrent misses for one key share a single query, pagination counts
  with `COUNT(*)`, and invalidation streams `SCAN` results
- **TypeScript types included**

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Cache keys and invalidation](#cache-keys-and-invalidation)
- [Configuration](#configuration)
- [Failure handling](#failure-handling)
- [Performance](#performance)
- [TypeScript](#typescript)
- [Upgrading](#upgrading)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

## Requirements

- Node.js 10 or newer (the test suite runs on Node 22)
- MySQL 5.7 or 8.x (tested with 8.0)
- Redis 2.8 or newer for `SCAN` (tested with 7); optional, see `REDIS_ENABLED`

## Installation

```bash
npm install node-caching-mysql-connector-with-redis
```

## Quick start

The package is configured with environment variables. It loads a `.env` file from the working
directory and validates the settings when it is first required, with an error that lists what is
missing.

```bash
# .env
DB_HOST=localhost
DB_USERNAME=app
DB_PASSWORD=secret
DB_NAME=app
REDIS_SERVER=localhost
```

```javascript
const { getCacheQuery, QuaryCache } = require('node-caching-mysql-connector-with-redis');

// Read through the cache under the key 'user:42'
const [user] = await getCacheQuery('SELECT * FROM users WHERE id = ?', [42], 'user:42');

// Write, then delete every cached key that starts with 'user:'
await QuaryCache('UPDATE users SET name = ? WHERE id = ?', ['Ada', 42], 'user:');
```

> `QuaryCache` is the function's published name (with this spelling) and is kept for compatibility.

## Usage

### Reading

```javascript
const rows = await getCacheQuery(sql, params, cacheName, database);
```

- **Cache hit:** the rows come from Redis.
- **Cache miss:** the query runs on MySQL, and the rows are cached for 40,000 s (about 11 h) before
  the promise resolves. Keep cached data fresh through invalidation; there is no per-call TTL.
- **Empty results** are not served from the cache, so a query that returned no rows runs again on
  the next call.
- **Concurrent misses** for the same key, database, SQL and parameters share one query, and each
  caller receives its own copy of the rows. Set `DB_COALESCE_QUERIES=false` to turn this off.

### Writing and invalidation

```javascript
const result = await QuaryCache(sql, params, resetCacheName, database);
// result: rows for SELECT, or { insertId, affectedRows, ... } for writes
```

After the statement succeeds, every key that starts with `resetCacheName` is deleted.
`resetCacheName` can be a string or an array of prefixes. The call resolves once the invalidation
has finished.

### Pagination

```javascript
const { totalCount, pageCount, detail } = await getCacheQueryPagination(
    'SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC',
    [7],
    'orders:customer:7', // cache name
    0,                   // page (0-based)
    20                   // page size (default 30)
);
```

- Each page is cached as `<cacheName>:page<n>:size<m>`, so `QuaryCache(..., 'orders:customer:7')`
  clears every page.
- The total is counted with `SELECT COUNT(*)` only when the page is full; a short page is the last
  one and already gives the total.
- With `DB_PAGINATION_REUSE_TOTAL=true`, the total is counted once and reused for the other pages
  until the cache name is invalidated.

### Transactions

```javascript
const { withTransaction } = require('node-caching-mysql-connector-with-redis');

const orderId = await withTransaction(async (tx) => {
    const { insertId } = await tx.query('INSERT INTO orders (customer_id) VALUES (?)', [7], 'orders:');
    await tx.query('UPDATE stock SET qty = qty - 1 WHERE product_id = ?', [3], 'stock:');
    return insertId;
});
```

The transaction commits when the callback resolves and rolls back when it throws. Cache invalidations
from `tx.query` are buffered and applied only after a successful commit. `tx.getCacheQuery` reads
through the cache inside the transaction, and `tx.getConnection()` returns the raw mysql2 connection.

### Bulk insert

```javascript
const { insertedRows, chunks } = await bulkInsert('events', records, {
    chunkSize: 1000,          // rows per INSERT statement (default 1000)
    resetCacheName: 'events:',
    transaction: true         // optional: all chunks or none
});
```

Without `transaction`, each chunk commits on its own. If a connection error interrupts the insert,
the retry continues from the first chunk that was not acknowledged.

### Query timeouts

```javascript
const rows = await getCacheQueryWithTimeout(sql, params, 'report:daily', {
    timeout: 5000,          // ms (default 30000)
    cancelOnTimeout: true   // optional: KILL QUERY on the server when the timeout fires
});
```

The call rejects with `Query timeout exceeded`. If it timed out before its query started (for example
while waiting for a pool connection), the query is not run. Without `cancelOnTimeout`, a query that
was already running finishes on the server and its result is cached.

### Several databases

Every query function accepts an optional database name, used for that call only:

```javascript
await getCacheQuery('SELECT * FROM users', [], 'tenant7:users', 'tenant_7');
```

Pass the database per call. Do not change `process.env` per request: environment variables are
shared by all concurrent requests.

### Redis helpers

```javascript
const { getArrayItem, addArrayItem, delKeyItem, delPrefixKeyItem, getRedisClient } =
    require('node-caching-mysql-connector-with-redis');

await addArrayItem('settings', [{ theme: 'dark' }], 3600); // TTL in seconds (default 40000)
const settings = await getArrayItem('settings');            // [] on a miss
await delKeyItem(['settings', 'flags']);
await delPrefixKeyItem('user:');
```

None of these throw when Redis is unavailable: reads return `[]`, writes return the data without
caching it, and deletes are retried when Redis is back. `getRedisClient()` returns the underlying
node-redis v3 client.

### Health checks and shutdown

```javascript
app.get('/health', (req, res) => res.json({ redis: isRedisConnected(), mysql: getPoolStats() }));
// getPoolStats(): { totalConnections, activeConnections, freeConnections, queuedRequests }

process.on('SIGTERM', async () => {
    await closeConnections(); // closes the MySQL pool; new queries are rejected afterwards
});
```

## Cache keys and invalidation

All keys are prefixed with `REDIS_VHOST:` when `REDIS_VHOST` is set. Invalidation always works by
prefix, so give related keys a common prefix, such as `user:42` and `user:list`.

### Automatic keys and invalidation (opt-in)

```bash
CORE_AUTO_FEATURES=true       # generate a cache key when cacheName is omitted
CORE_AUTO_INVALIDATION=true   # after INSERT/UPDATE/DELETE/REPLACE, invalidate <table>:* and <table>_*
```

You can also turn them on in code:

```javascript
const { configure } = require('node-caching-mysql-connector-with-redis');

configure({
    autoKey: { enabled: true },
    autoInvalidation: { enabled: true, tables: { users: ['users:*', 'profiles:*'] } } // optional custom rules
});

const users = await getCacheQuery('SELECT * FROM users WHERE company_id = ?', [5]); // key users:company_id:<hash>
await QuaryCache('UPDATE users SET active = 0 WHERE id = ?', [9]);                // clears users:* and users_*
```

- **How keys are built:** from the table name, the `WHERE` column names and a hash of the parameters,
  for example `users:company_id:a7b3c2d1`, or `users:all` without a `WHERE`. Calls that pass a
  `database` get an `@<database>` suffix.
- **Caveat:** the key does not include the selected columns, `ORDER BY` or `LIMIT`. If two queries on
  the same table and `WHERE` columns differ only in those, pass explicit cache names.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | *required* | MySQL host |
| `DB_USERNAME` | *required* | MySQL user |
| `DB_PASSWORD` | `''` | MySQL password |
| `DB_NAME` | *required* | Default database |
| `DB_PORT` | `3306` | MySQL port |
| `DB_CONNECTION_LIMIT` | `151` | Max connections per process (MySQL's default `max_connections` is also 151) |
| `DB_QUEUE_LIMIT` | `0` | Max requests queued for a connection (`0` = unlimited) |
| `DB_MAX_IDLE` | `10` | Idle connections kept open |
| `DB_IDLE_TIMEOUT` | `60000` | ms before idle connections above `DB_MAX_IDLE` close |
| `DB_CONNECT_TIMEOUT` | `10000` | ms to establish a connection |
| `DB_MULTIPLE_STATEMENTS` | `true` | Allow several statements per query |
| `TIMEZONE` | `+00:00` | Connection time zone |
| `DB_COALESCE_QUERIES` | `true` | Share one query between concurrent identical cache misses |
| `DB_PAGINATION_REUSE_TOTAL` | `false` | Reuse a paginated query's total across its pages |
| `REDIS_ENABLED` | `true` | `false` runs every query on MySQL without caching; Redis is only connected if you call a Redis helper |
| `REDIS_SERVER` | *required if enabled* | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | none | Redis password |
| `REDIS_VHOST` | none | Prefix for every key (`<vhost>:<key>`) |
| `REDIS_WAIT_TIMEOUT` | `10000` | ms an operation waits for Redis to (re)connect |
| `REDIS_FAIL_FAST` | `true` | After `REDIS_WAIT_TIMEOUT` of downtime, stop waiting and fall back immediately |
| `REDIS_COMMAND_TIMEOUT` | `max(REDIS_WAIT_TIMEOUT, 10000)` | ms a cache read/write may stay unanswered (`0` = off) |
| `REDIS_RECONNECT_MAX_DELAY` | `5000` | Max ms between reconnect attempts |
| `REDIS_SCAN_COUNT` | `1000` | Keys examined per `SCAN` round trip during invalidation |
| `CORE_AUTO_FEATURES` | `false` | Automatic cache keys |
| `CORE_AUTO_INVALIDATION` | `false` | Automatic invalidation after writes |

[docs/CONFIGURATION.md](docs/CONFIGURATION.md) covers pool tuning, bursty traffic and troubleshooting.

## Failure handling

| Situation | Behavior |
|---|---|
| Redis down | Reads go to MySQL and results are not cached. Calls wait up to `REDIS_WAIT_TIMEOUT` for a reconnect, then fall back immediately for the rest of the outage. Invalidations that could not run are replayed when Redis is back. |
| Redis connection hangs | Cache reads and writes time out after `REDIS_COMMAND_TIMEOUT`, and a connection that stops answering is reopened. |
| Redis restarts | Reconnects with exponential backoff and jitter, capped at `REDIS_RECONNECT_MAX_DELAY`, and never gives up. |
| MySQL connection errors | On `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `PROTOCOL_CONNECTION_LOST` or `ER_CON_COUNT_ERROR` a call is attempted up to 3 times, waiting 1 s and then 2 s (plus jitter). The whole statement is retried, so make writes idempotent where a duplicate would matter. |
| Error inside `withTransaction` | The transaction is rolled back and buffered invalidations are dropped. |

The resilience behavior is covered by unit tests, integration tests against real MySQL and Redis,
and 18 Docker chaos scenarios. These include killing Redis and MySQL mid-operation, 30-second
outages, network partitions, pool exhaustion, thundering herds and both services down at once.

## Performance

Measured for v2.9.0 against v2.8.1 on MySQL 8 and Redis 7 running in Docker on a laptop:

| Scenario | v2.8.1 | v2.9.0 |
|---|---|---|
| Pagination page miss on 1M rows (page 0) | 2,044 ms, +556 MB RAM | 119 ms |
| 200 concurrent misses on one key | 200 queries, p99 2.6 s | 1 query, p99 0.26 s |
| Write with auto-invalidation (~400k keys in Redis) | 7,970 `SCAN`s, 1.3 s | 400 `SCAN`s, 0.22 s |
| Cache miss while Redis is down (`REDIS_WAIT_TIMEOUT=2000`) | 4 s | 2 ms |

Tips:

- Prefer pagination to caching very large results. Cached values are JSON, so 100k rows cost about
  100 ms to serialize and 75 ms to parse.
- Deep `LIMIT` offsets get slower with depth. For long lists, an indexed `WHERE id > ?` condition in
  your SQL stays fast at any depth.

## TypeScript

Type definitions ship with the package:

```typescript
import { getCacheQuery, getCacheQueryPagination } from 'node-caching-mysql-connector-with-redis';

interface User { id: number; name: string; }

const users = await getCacheQuery<User>('SELECT id, name FROM users WHERE active = ?', [1], 'users:active');
const page = await getCacheQueryPagination<User>('SELECT id, name FROM users', [], 'users:list', 0, 50);
```

## Upgrading

v2.9.0 does not change the API. [docs/MIGRATION.md](docs/MIGRATION.md#v28x--v290-performance--resilience)
lists every behavior difference from v2.8.x and the settings that restore the old behavior.

## Development

```bash
npm test                                       # unit tests
INTEGRATION=1 npm test                         # also integration tests: Redis on 127.0.0.1:6399, MySQL on 127.0.0.1:3399
INTEGRATION=1 node test/chaos.test.js          # Redis chaos suite (Docker containers test-redis / test-mysql)
INTEGRATION=1 node test/chaos-mysql.test.js    # MySQL chaos suite
```

The test suite uses mocha 9, which runs on Node 22 but does not start on Node 26.
See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for contribution guidelines.

## Documentation

- [API reference](docs/API.md)
- [Configuration](docs/CONFIGURATION.md)
- [Examples](docs/EXAMPLES.md)
- [Migration guide](docs/MIGRATION.md)
- Use cases: [e-commerce](docs/USE-CASE-ECOMMERCE.md), [multi-tenant SaaS](docs/USE-CASE-SAAS.md),
  [real-time apps](docs/USE-CASE-REALTIME.md), [bulk operations](docs/USE-CASE-BULK.md)
- [Türkçe README](docs/README.tr.md)

## License

MIT © Hayati Ali KELEŞ
