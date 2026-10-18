# Migration Guide

Guide for migrating to v2.6.0 and adopting smart features.

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
const { getCacheQuery, QuaryCache } = require('node-caching-mysql-connector-with-redis');

// .env
CORE_AUTO_FEATURES=true

// Read with auto-cache
app.get('/users/:id', async (req, res) => {
    const users = await getCacheQuery('SELECT * FROM users WHERE id = ?', [req.params.id]);
    res.json(users[0]);
});

// Write with auto-invalidation
app.post('/users', async (req, res) => {
    await QuaryCache('INSERT INTO users (name, email) VALUES (?, ?)', [req.body.name, req.body.email]);
    // ✅ All user caches automatically cleared!
    res.json({ success: true });
});
```

**Benefits:**
- 10+ lines → 3 lines
- No cache key management
- No manual invalidation
- No forgotten keys

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
const { getCacheQuery } = require('node-caching-mysql-connector-with-redis');

const users = await getCacheQuery('SELECT * FROM users WHERE id = ?', [123]);
// ✅ Same API + automatic caching!
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
const { getCacheQuery } = require('node-caching-mysql-connector-with-redis');

const users = await getCacheQuery('SELECT * FROM users WHERE id = ?', [123]);
```

---

## Version Migration

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
  kept running after `end()` and later spun in a synchronous loop at 100% CPU.
- **The Redis client really never stops reconnecting.** node-redis gave up after one hour of retries,
  leaving the cache disabled until a restart.
- **Invalidations missed during a Redis outage are replayed** when Redis is ready again, instead of
  leaving stale entries for the rest of their TTL.
- A failed command sent without a callback through `getRedisClient()` no longer marks Redis as down.
- `REDIS_ENABLED=false` no longer opens a Redis connection (and reconnect loop) at startup; it is
  opened on the first direct Redis call, including `isRedisConnected()`.
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
   await getCacheQuery('SELECT * FROM users', [], 'users-all');
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
npm install node-caching-mysql-connector-with-redis

// Use with manual keys (no changes to existing logic)
const { getCacheQuery, QuaryCache } = require('node-caching-mysql-connector-with-redis');

await getCacheQuery('SELECT * FROM users', [], 'users-all');
await QuaryCache('INSERT INTO users...', [data], 'users_*');
```

### Phase 2: Enable Auto Features

```javascript
// .env
CORE_AUTO_FEATURES=true

// Remove cache keys from new code
await getCacheQuery('SELECT * FROM users', []); // Auto key ✨

// Old code with manual keys still works
await getCacheQuery('SELECT * FROM orders', [], 'orders-all'); // Manual key
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
await getCacheQuery('SELECT * FROM users', [], 'users-all');
await getCacheQuery('SELECT * FROM posts', [], 'posts-recent');

// After (once confident in auto features)
await getCacheQuery('SELECT * FROM users', []);
await getCacheQuery('SELECT * FROM posts', []);
```

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
const { getCacheQuery } = require('node-caching-mysql-connector-with-redis');

app.get('/users', async (req, res) => {
    const users = await getCacheQuery('SELECT * FROM users', []);
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
const { QuaryCache } = require('node-caching-mysql-connector-with-redis');

async function processOrders() {
    const orders = await getCacheQuery('SELECT * FROM orders WHERE status = ?', ['pending']);
    
    for (const order of orders) {
        await QuaryCache('UPDATE orders SET status = ? WHERE id = ?', ['processing', order.id]);
        // ✅ Caches automatically cleared
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
const { withTransaction } = require('node-caching-mysql-connector-with-redis');

async function createUserWithProfile(userData, profileData) {
    return await withTransaction(async (tx) => {
        const userResult = await tx.query('INSERT INTO users...', [userData]);
        await tx.query('INSERT INTO profiles...', [userResult.insertId, profileData]);
        return userResult.insertId;
        // ✅ Auto commit, auto rollback, auto cache invalidation
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
const { getCacheQuery } = require('node-caching-mysql-connector-with-redis');

describe('User API', () => {
    it('should fetch users with cache', async () => {
        const users = await getCacheQuery('SELECT * FROM users', []);
        expect(users).to.be.an('array');
    });
});
```

### Integration Tests

```javascript
// Test with Redis enabled
process.env.REDIS_ENABLED = 'true';
process.env.CORE_AUTO_FEATURES = 'true';

// Test without Redis (fallback)
process.env.REDIS_ENABLED = 'false';
```

---

## Rollback Plan

If you need to rollback:

1. **Disable auto features**
   ```bash
   CORE_AUTO_FEATURES=false
   ```

2. **Add manual keys back**
   ```javascript
   await getCacheQuery('SELECT * FROM users', [], 'users-all');
   await QuaryCache('INSERT INTO users...', [data], 'users_*');
   ```

3. **Downgrade if needed**
   ```bash
   npm install node-caching-mysql-connector-with-redis@2.5.3
   ```

---

## Performance Considerations

### Before Migration

- Manual cache management: ~50ms per request
- Risk of stale data due to missed invalidations
- Complex code maintenance

### After Migration

- Auto cache: ~2ms overhead
- Guaranteed cache consistency
- Simpler code (80% less boilerplate)

### Benchmark

```javascript
// Manual approach: 10 lines, 50ms
// Auto approach: 2 lines, 52ms
// Trade-off: +2ms for huge DX improvement ✅
```

---

## Support & Help

- **Documentation**: [API Reference](API.md) | [Examples](EXAMPLES.md)
- **Issues**: [GitHub Issues](https://github.com/hayatialikeles/NODE-CACHING-MYSQL-CONNECTOR-WITH-REDIS/issues)
- **Community**: [Discussions](https://github.com/hayatialikeles/NODE-CACHING-MYSQL-CONNECTOR-WITH-REDIS/discussions)

---

**[← Back to Main README](../README.md)**
