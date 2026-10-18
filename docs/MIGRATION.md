# Migration Guide

Guide for upgrading between sqlcache versions and adopting the automatic features.

---

## v2.9.0 → v2.9.1

A patch release. The API is unchanged; some TypeScript types accept more than before. The
differences:

### Requirements

- Node.js 14 or newer (tested on 18–26); `engines.node` is `>=14`.
- mysql2 3.23.1 or newer (the dependency is now `^3.23.1`). Older versions have security
  advisories, including critical ones; update lockfiles that pin an older mysql2.

### Imports

- Named ESM imports work: `import { getCacheQuery } from 'sqlcache'`. On 2.9.0 and earlier, native
  ESM could only import `QuaryCache` by name; use the default import there.
- `import sqlcache from 'sqlcache'` works without `esModuleInterop`: the module now has a
  non-enumerable `default` property, as the type definitions always declared.
- Types: `QuaryCache<T>()` takes the result type (default `QueryResult`, which gained `info` and
  `warningStatus`); `resetCacheName` accepts `string[]` in `QuaryCache` and `bulkInsert`; `parameters`
  is optional except in `getCacheQueryPagination`; the cache name may be omitted in
  `getCacheQueryWithTimeout` and passed as `null` to `getCacheQueryPagination`; a `withTransaction`
  callback may return a plain value; `configure`, `enableAutoKey` and `enableAutoInvalidation` accept
  booleans.

### Caching

- Empty results are no longer written to the cache; they were never served from it.
- A cached value that is not a non-empty array is treated as a miss. For pagination, it must be a
  page object.
- A read that started before an invalidation in the same process no longer writes its possibly stale
  result to the cache. Across processes a short window remains.
- `tx.getCacheQuery` still reads the cache first, but writes to it only after the transaction commits.
  Nothing is cached from a rolled-back transaction.
- `getCacheQueryPagination` and `getCacheQueryWithTimeout` without a cache name use an automatic key
  when automatic keys are enabled; otherwise the result is not cached and a one-time warning is
  logged. Before 2.9.1 all such calls shared one cache key.
- Automatic keys of queries without a detectable table (`CALL`, `SELECT fn(?)`) now include the
  parameters: `query:<sqlhash>:<paramhash>`. `BigInt` parameters no longer throw.
- New `DB_COALESCE_MAX_WAIT` (ms, default 10000): how long concurrent cache misses wait for a shared
  query before starting a fresh one, which protects against a stuck connection. A waiting caller
  still takes the original result if it arrives first. When a shared query fails with
  `ER_QUERY_TIMEOUT` (`MAX_EXECUTION_TIME`), that error goes to every caller waiting on it.

### Turning features off

- `enableAutoKey(false)`, `enableAutoInvalidation(false)` and `configure({ autoKey: false })` now
  disable the feature. Before 2.9.1 they enabled it; check calls that pass `false`.

### bulkInsert

- Invalid table or column names are rejected before anything is sent, with a `TypeError`:
  `bulkInsert: invalid table name "<name>"` or `bulkInsert: invalid column name "<name>"`. Valid names
  are unchanged.
- Auto-invalidation (`CORE_AUTO_INVALIDATION` / `enableAutoInvalidation`) now also applies to
  `bulkInsert` when no `resetCacheName` is given.
- Invalidation also runs when `bulkInsert` fails after rows may have been written.
- With `transaction: true`, an error from `COMMIT` is not retried and carries
  `err.commitOutcomeUnknown = true`.

### Queries and connections

- `cancelOnTimeout`: the connection whose query was killed is discarded instead of being returned to
  the pool, at most 4 cancellations run at once, and a timeout during the database switch also stops
  the query from being sent.
- Pagination appends `LIMIT` on a new line, so SQL ending in a `-- comment` paginates correctly.
- `DROP DATABASE` / `DROP SCHEMA` in your SQL is handled like `USE`: the next call on that pooled
  connection selects its database again.

### Redis

- `isRedisConnected()` returns `false` without opening a connection when `REDIS_ENABLED=false`.
- One log line per reconnect attempt: `Redis reconnecting... (attempt N, delay Xms)`.
- A log line appears if more than 1000 invalidations are missed during an outage.
- A one-time warning appears if `REDIS_VHOST` changes at runtime.

---

## Migrating from Manual Cache Management

### Before (Manual Redis)

```javascript
const redis = require('redis').createClient();
const mysql = require('mysql2/promise');
const db = mysql.createPool({...});

// Read with manual cache
app.get('/users/:id', async (req, res) => {
    const cacheKey = `user-${req.params.id}`;
    
    // Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
        return res.json(JSON.parse(cached));
    }
    
    // Query database
    const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
    const user = users[0];
    
    // Store in cache
    await redis.setex(cacheKey, 3600, JSON.stringify(user));
    
    res.json(user);
});

// Write with manual invalidation
app.post('/users', async (req, res) => {
    await db.query('INSERT INTO users (name, email) VALUES (?, ?)', [req.body.name, req.body.email]);
    
    // Manual invalidation - easy to forget!
    await redis.del('users-all');
    await redis.del('users-active');
    // Did we forget any keys?
    
    res.json({ success: true });
});
```

### After (With This Package)

```javascript
const { getCacheQuery, QuaryCache } = require('sqlcache');

// .env
CORE_AUTO_FEATURES=true       // automatic cache keys
CORE_AUTO_INVALIDATION=true   // automatic invalidation (CORE_AUTO_FEATURES alone does not enable it)

// Read with auto-cache (key users:id:<hash>)
app.get('/users/:id', async (req, res) => {
    const users = await getCacheQuery('SELECT * FROM users WHERE id = ?', [req.params.id]);
    res.json(users[0]);
});

// Write with auto-invalidation
app.post('/users', async (req, res) => {
    await QuaryCache('INSERT INTO users (name, email) VALUES (?, ?)', [req.body.name, req.body.email]);
    // ✅ users:* and users_* automatically cleared
    res.json({ success: true });
});
```

**Benefits:**
- 10+ lines → 3 lines
- No cache key management for simple queries
- No manual invalidation for writes to the cached table

Automatic keys and invalidation follow the first table of each statement only; see the README's
[Cache keys and invalidation](../README.md#cache-keys-and-invalidation) for what needs an explicit
cache name or `resetCacheName` (joins, aggregates, `CALL`, writes from other applications, ...).

---

## Migrating from Other MySQL Packages

### From `mysql2`

```javascript
// Before
const mysql = require('mysql2/promise');
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [123]);

// After
const { getCacheQuery } = require('sqlcache');

const users = await getCacheQuery('SELECT * FROM users WHERE id = ?', [123], 'user:123');
// ✅ Same SQL and parameters + automatic caching; returns the rows directly (no [rows, fields])
```

### From `knex`

```javascript
// Before
const knex = require('knex')({
    client: 'mysql2',
    connection: {
        host: process.env.DB_HOST,
        user: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    }
});

const users = await knex('users').where('id', 123).select('*');

// After
const { getCacheQuery } = require('sqlcache');

const users = await getCacheQuery('SELECT * FROM users WHERE id = ?', [123], 'user:123');
```

---

## Version Migration

For v2.9.0 → v2.9.1 see [the top of this guide](#v290--v291).

### Package renamed to `sqlcache` (v2.9.0)

From v2.9.0 the package is published as `sqlcache`; the API is unchanged.

```bash
npm uninstall node-caching-mysql-connector-with-redis
npm install sqlcache
```

```javascript
// before
const { getCacheQuery } = require('node-caching-mysql-connector-with-redis');
// after
const { getCacheQuery } = require('sqlcache');
```

Deep imports (`/dbConnector`, `/redis.Connector`, `/core/...`) and TypeScript imports change the same
way. You do not have to switch right away: `node-caching-mysql-connector-with-redis@2.9.0` only
forwards to `sqlcache@^2.9.0` (including those deep paths and the types), so `npm update` on the old
name already runs the same code. The old name is deprecated and gets no new major versions. Deep
imports have no type declarations of their own; TypeScript code should import from `'sqlcache'`.

### v2.8.x → v2.9.0 (performance & resilience)

No API, signature or return-shape changes. The observable differences are listed below; most
can be switched back with an environment variable.

#### Faster by default

| Area | v2.8.x | v2.9.0 |
|------|--------|--------|
| `getCacheQueryPagination` total | Fetched **every row** of the query to count it | `SELECT COUNT(*)` over the query; no count at all when the page is the last one |
| Concurrent cache misses (same key, database, SQL, parameters) | One query per caller | One query; every caller gets its own copy of the rows |
| Calls with `database` | `USE db` on every call | `USE db` only when the pooled connection is on another database |
| MySQL connection during cache writes / invalidation | Held for the Redis round trips | Returned to the pool first (outside transactions) |
| `delPrefixKeyItem` / auto-invalidation | `SCAN COUNT 100`, one full scan per pattern (two per write) | `SCAN COUNT 1000`, one scan per write, deletes streamed while scanning |
| Redis outage | Every cache read/write waited `REDIS_WAIT_TIMEOUT` | After `REDIS_WAIT_TIMEOUT` of downtime, reads/writes fall back at once |
| Hung Redis connection | Calls could hang until TCP gave up (~15 min) | Reads/writes fall back after `REDIS_COMMAND_TIMEOUT`; a silent connection is reconnected |
| Reconnect after Redis returns | Backoff up to 30 s | Backoff up to 5 s |
| Retries on connection errors | 1 s, 2 s | 1 s, 2 s plus up to 20% jitter |
| `getCacheQueryWithTimeout` timing out while waiting for a pool connection | Query still ran later (adding load to a saturated pool) | Query is not run |
| `getCacheQueryWithTimeout` timing out while the query runs | Query keeps running | Same by default; `cancelOnTimeout: true` stops it with `KILL QUERY` |

#### Bug fixes you may notice

- **`USE db` no longer leaks between pooled callers.** A call with `database` used to leave its
  pooled connection on that database, so a later call *without* `database` could run against the
  wrong schema.
- **Auto-generated keys are per database.** With auto keys, the same SQL on two databases (e.g. one
  database per tenant) shared one cache entry, so one tenant could receive another tenant's rows.
  Calls that pass `database` now get keys ending in `@<database>` (still under the `table:` prefix
  that auto-invalidation deletes). Keys of calls without `database` are unchanged.
- **Auto-invalidation understands MySQL modifiers.** `INSERT IGNORE`, `INSERT ... ON DUPLICATE KEY
  UPDATE`, `UPDATE LOW_PRIORITY`, `DELETE QUICK`, `REPLACE ... 'UPDATE ...'` now invalidate the table
  they write to (previously no table, or a wrong one).
- **`bulkInsert` no longer re-inserts committed chunks** when a connection error triggers a retry.
- **`closeConnections()` no longer hangs the process.** With mysql2 3.3.x the pool's idle reaper
  kept running after `end()` and later spun in a synchronous loop at 100% CPU. It closes only the
  MySQL pool: with Redis enabled, also call `getRedisClient().quit()`, or the open Redis connection
  keeps the process alive.
- **The Redis client really never stops reconnecting.** node-redis gave up after one hour of retries,
  leaving the cache disabled until a restart.
- **Invalidations missed during a Redis outage are replayed** when Redis is ready again, instead of
  leaving stale entries for the rest of their TTL.
- A failed command sent without a callback through `getRedisClient()` no longer marks Redis as down.
- `REDIS_ENABLED=false` no longer opens a Redis connection (and reconnect loop) at startup; it is
  opened on the first direct Redis call, including `isRedisConnected()` (no longer the case for
  `isRedisConnected()` since v2.9.1).
- An empty `REDIS_PASSWORD` no longer sends `AUTH ""`.

#### Smaller observable differences (no switch)

- Pagination counts with `COUNT(*)`, which does not evaluate the select list: a query whose select
  list fails only on some rows (e.g. invalid JSON in a few rows) now fails only for pages that
  contain those rows, and a session `sql_select_limit` no longer caps `totalCount`.
- Statement hints other than a leading `MAX_EXECUTION_TIME` do not apply to the count query.
- Log lines: during an outage there is one "Redis unavailable for … serving cache misses" line
  instead of one failure line per call; new lines report command timeouts, reconnects of a silent
  connection, and replayed invalidations.

#### New opt-in options

- `DB_PAGINATION_REUSE_TOTAL=true`: count a paginated query once and reuse the total for its other
  pages until the cache name is invalidated (totals may lag behind writes that do not invalidate it).
- `bulkInsert(table, records, { transaction: true })`: all chunks in one transaction, all or nothing.
- `getCacheQueryWithTimeout(..., { cancelOnTimeout: true })`: stop a timed-out query on the server.

#### Restoring v2.8.x behavior

```bash
DB_COALESCE_QUERIES=false        # one query per concurrent cache miss
REDIS_FAIL_FAST=false            # every cache read/write waits REDIS_WAIT_TIMEOUT during outages
REDIS_COMMAND_TIMEOUT=0          # no per-command timeout (and no reconnect of silent connections)
REDIS_RECONNECT_MAX_DELAY=30000  # previous reconnect backoff cap
REDIS_SCAN_COUNT=100             # previous SCAN batch size
```

The pagination count, the `USE` handling and the merged invalidation scans have no switch: they
return the same results with less work.

### v2.5.x → v2.6.0

#### What's New
- Automatic cache keys and invalidation, opt-in (`CORE_AUTO_FEATURES`, `CORE_AUTO_INVALIDATION`,
  `configure()`, `enableAutoKey()`, `enableAutoInvalidation()`)
- Transaction support (`withTransaction`)
- Enhanced documentation
- More comprehensive tests

#### Breaking Changes
**None!** 100% backward compatible.

#### Migration Steps

1. **Update package**
   ```bash
   npm update node-caching-mysql-connector-with-redis
   ```

2. **No code changes required**
   ```javascript
   // Your v2.5.x code works exactly the same
   await getCacheQuery('SELECT * FROM users', [], 'users_all');
   await QuaryCache('INSERT INTO users...', [data], 'users_*');
   ```

3. **Optional: Adopt transactions**
   ```javascript
   // Old way
   const connection = await pool.getConnection();
   await connection.beginTransaction();
   try {
       await connection.query('INSERT...');
       await connection.query('UPDATE...');
       await connection.commit();
   } catch (error) {
       await connection.rollback();
       throw error;
   } finally {
       connection.release();
   }

   // New way
   await withTransaction(async (tx) => {
       await tx.query('INSERT...');
       await tx.query('UPDATE...');
   });
   ```

---

## Gradual Adoption Strategy

### Phase 1: Install & Basic Usage

```javascript
// Install
npm install sqlcache

// Use with manual keys (no changes to existing logic)
const { getCacheQuery, QuaryCache } = require('sqlcache');

await getCacheQuery('SELECT * FROM users', [], 'users_all');
await QuaryCache('INSERT INTO users...', [data], 'users_*'); // clears users_all
```

### Phase 2: Enable Auto Features

```javascript
// .env
CORE_AUTO_FEATURES=true       // automatic keys
CORE_AUTO_INVALIDATION=true   // automatic invalidation (not enabled by CORE_AUTO_FEATURES)

// Remove cache keys from new code
await getCacheQuery('SELECT * FROM users', []); // Auto key users:all ✨

// Old code with manual keys still works
await getCacheQuery('SELECT * FROM orders', [], 'orders_all'); // Manual key

// But a resetCacheName replaces the automatic patterns, so old writes that clear only
// 'users_*' leave the new users:... keys stale. Drop the resetCacheName from such writes,
// or clear both prefixes:
await QuaryCache('INSERT INTO users...', [data], ['users_', 'users:']);
```

### Phase 3: Adopt Transactions

```javascript
// Refactor critical operations to use transactions
await withTransaction(async (tx) => {
    const orderResult = await tx.query('INSERT INTO orders...', [data]);
    await tx.query('UPDATE inventory...', [data]);
    return orderResult.insertId;
});
```

### Phase 4: Remove Manual Keys

```javascript
// Before
await getCacheQuery('SELECT * FROM users', [], 'users_all');
await getCacheQuery('SELECT * FROM posts', [], 'posts_recent');

// After (once confident in auto features)
await getCacheQuery('SELECT * FROM users', []);
await getCacheQuery('SELECT * FROM posts', []);
```

Keep explicit names where automatic keys would collide, such as aggregates, joins and
`LIMIT`/`ORDER BY` variants (see the README's caveats).

---

## Common Migration Scenarios

### Scenario 1: Express.js API

```javascript
// Before
app.get('/users', async (req, res) => {
    const cacheKey = 'users-all';
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));
    
    const [users] = await db.query('SELECT * FROM users');
    await redis.setex(cacheKey, 3600, JSON.stringify(users));
    res.json(users);
});

// After
const { getCacheQuery } = require('sqlcache');

app.get('/users', async (req, res) => {
    const users = await getCacheQuery('SELECT * FROM users', []); // auto key users:all (CORE_AUTO_FEATURES=true)
    res.json(users);
});
```

### Scenario 2: Background Jobs

```javascript
// Before
async function processOrders() {
    const [orders] = await db.query('SELECT * FROM orders WHERE status = ?', ['pending']);
    
    for (const order of orders) {
        await db.query('UPDATE orders SET status = ? WHERE id = ?', ['processing', order.id]);
        await redis.del(`order-${order.id}`);
        await redis.del('orders-pending');
    }
}

// After
const { QuaryCache } = require('sqlcache');

async function processOrders() {
    // A work queue must see the current rows: QuaryCache reads MySQL without the cache
    const orders = await QuaryCache('SELECT * FROM orders WHERE status = ?', ['pending']);
    
    for (const order of orders) {
        await QuaryCache('UPDATE orders SET status = ? WHERE id = ?', ['processing', order.id]);
        // ✅ orders:* and orders_* cleared (CORE_AUTO_INVALIDATION=true)
    }
}
```

### Scenario 3: Complex Transactions

```javascript
// Before
async function createUserWithProfile(userData, profileData) {
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    
    try {
        const [userResult] = await connection.query('INSERT INTO users...', [userData]);
        await connection.query('INSERT INTO profiles...', [userResult.insertId, profileData]);
        await connection.commit();
        
        // Manual cache clearing
        await redis.del('users-all');
        await redis.del('profiles-all');
        
        return userResult.insertId;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

// After
const { withTransaction } = require('sqlcache');

async function createUserWithProfile(userData, profileData) {
    return await withTransaction(async (tx) => {
        const userResult = await tx.query('INSERT INTO users...', [userData]);
        await tx.query('INSERT INTO profiles...', [userResult.insertId, profileData]);
        return userResult.insertId;
        // ✅ Auto commit, auto rollback, cache invalidation after the commit
        //    (automatic with CORE_AUTO_INVALIDATION=true, or pass resetCacheName to tx.query)
    });
}
```

---

## Testing Migration

### Unit Tests

```javascript
// Before
describe('User API', () => {
    it('should fetch users', async () => {
        const [users] = await db.query('SELECT * FROM users');
        expect(users).to.be.an('array');
    });
});

// After
const { getCacheQuery } = require('sqlcache');

describe('User API', () => {
    it('should fetch users with cache', async () => {
        const users = await getCacheQuery('SELECT * FROM users', [], 'users_all');
        expect(users).to.be.an('array');
    });
});
```

### Integration Tests

`REDIS_ENABLED`, like the pool and coalescing settings, is read once, when sqlcache is first
required. Changing it afterwards has no effect, so set it before the first `require` and run the
Redis and no-Redis variants as separate test processes:

```javascript
// test/setup-redis.js (one test run)
process.env.REDIS_ENABLED = 'true';
process.env.CORE_AUTO_FEATURES = 'true';

// test/setup-no-redis.js (another test run): MySQL only, no caching
process.env.REDIS_ENABLED = 'false';
```

---

## Rollback Plan

If you need to rollback:

1. **Disable auto features**
   ```bash
   CORE_AUTO_FEATURES=false
   CORE_AUTO_INVALIDATION=false
   ```

2. **Add manual keys back**
   ```javascript
   await getCacheQuery('SELECT * FROM users', [], 'users_all');
   await QuaryCache('INSERT INTO users...', [data], 'users_*');
   ```

3. **Downgrade if needed**
   ```bash
   npm install node-caching-mysql-connector-with-redis@2.5.3
   ```

---

## Performance Considerations

### Before Migration

- Risk of stale data due to missed invalidations
- Complex code maintenance

### After Migration

- Cache hits are served from Redis; a miss adds a Redis read to the query, and a Redis write when
  the result is not empty
- Invalidation is automatic for writes made through sqlcache to the first table of each statement;
  joins, aggregates, `CALL`, writes from other applications and the cases listed in the README still
  need explicit cache names or `resetCacheName`
- Simpler code

---

## Support & Help

- **Documentation**: [API Reference](API.md) | [Examples](EXAMPLES.md)
- **Issues**: [GitHub Issues](https://github.com/hayatialikeles/sqlcache/issues)

---

**[← Back to Main README](../README.md)**
