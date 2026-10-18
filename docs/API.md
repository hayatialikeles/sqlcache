# API Reference

Complete API documentation for all functions.

---

## Table of Contents

- [Core Functions](#core-functions)
  - [getCacheQuery](#getcachequery)
  - [QuaryCache](#quarycache)
  - [getCacheQueryPagination](#getcachequerypagination)
  - [withTransaction](#withtransaction)
- [Production Features](#production-features)
  - [bulkInsert](#bulkinsert)
  - [getCacheQueryWithTimeout](#getcachequerywithtimeout)
  - [closeConnections](#closeconnections)
  - [getPoolStats](#getpoolstats)
- [Redis Operations](#redis-operations)
  - [getArrayItem](#getarrayitem)
  - [addArrayItem](#addarrayitem)
  - [delKeyItem](#delkeyitem)
  - [delPrefixKeyItem](#delprefixkeyitem)
  - [isRedisConnected](#isredisconnected)
  - [getRedisClient](#getredisclient)
- [Configuration](#configuration)
  - [configure](#configure)
  - [enableAutoKey](#enableautokey)
  - [enableAutoInvalidation](#enableautoinvalidation)

---

## Core Functions

### getCacheQuery

Execute a SELECT query with automatic Redis caching.

#### Signature

```typescript
getCacheQuery<T = any>(
    sql: string,
    parameters?: any[],
    cacheName?: string | null,
    database?: string | null
): Promise<T[]>
```

#### Parameters

- `sql` (string): SQL SELECT query
- `parameters` (any[], optional): Query parameters (use `?` placeholders)
- `cacheName` (string | null, optional): Cache key. Auto-generated if `CORE_AUTO_FEATURES=true`
  (or `enableAutoKey()`); otherwise the call throws `cacheName is required...`
- `database` (string | null, optional): Database name to switch to

#### Returns

Promise resolving to array of query results

#### Notes

- Results are cached for 40000 s. Empty results are not served from the cache, and since v2.9.1 not
  written to it; a cached value that is not a non-empty array is treated as a miss.
- A cache hit is a JSON round trip: a `Date` comes back as an ISO string and a `Buffer` as
  `{ type, data }`, while a miss returns mysql2's types.
- Concurrent misses for the same key, database, SQL and parameters share one query
  (`DB_COALESCE_QUERIES`). Since v2.9.1 a caller that has waited `DB_COALESCE_MAX_WAIT` ms (default
  10000) starts its own query, but still takes the shared result if that arrives first; an
  `ER_QUERY_TIMEOUT` error of the shared query (`MAX_EXECUTION_TIME`) goes to every caller waiting on it.
- Since v2.9.1 a read that started before an invalidation in the same process does not write its
  possibly stale result to the cache. Across processes a short window remains.

#### Examples

```javascript
// Auto cache key (requires CORE_AUTO_FEATURES=true)
const users = await getCacheQuery(
    'SELECT * FROM users WHERE status = ?',
    ['active']
);

// Manual cache key
const users = await getCacheQuery(
    'SELECT * FROM users WHERE id = ?',
    [123],
    'user-123'
);

// With database switching
const users = await getCacheQuery(
    'SELECT * FROM users',
    [],
    'all-users',
    'analytics_db'
);

// TypeScript with generics
interface User {
    id: number;
    name: string;
    email: string;
}

const users = await getCacheQuery<User>(
    'SELECT * FROM users WHERE id = ?',
    [123],
    'user:123'
);
```

#### Error Handling

```javascript
try {
    const data = await getCacheQuery('SELECT * FROM users', []);
} catch (error) {
    if (error.code === 'ECONNREFUSED') {
        console.error('Database connection failed');
    } else if (error.message.includes('cacheName is required')) {
        console.error('Auto key disabled, provide cacheName');
    } else {
        console.error('Query failed:', error.code, error.message);
    }
}
```

mysql2 errors carry `err.sql` with the parameter values filled in, so do not send whole error objects
to logs or clients you do not trust.

---

### QuaryCache

Run a statement on MySQL without reading the cache, then invalidate cached keys. Use it for
INSERT/UPDATE/DELETE, and for reads that must not be cached.

#### Signature

```typescript
QuaryCache<T = QueryResult>(
    sql: string,
    parameters?: any[],
    resetCacheName?: string | string[] | null,
    database?: string | null
): Promise<T>
```

#### Parameters

- `sql` (string): SQL statement
- `parameters` (any[], optional): Query parameters
- `resetCacheName` (string | string[] | null, optional): Prefixes whose keys are deleted after the
  statement succeeds. Without it, automatic invalidation applies if `CORE_AUTO_INVALIDATION=true`
  (or `enableAutoInvalidation()`); a `resetCacheName` replaces the automatic patterns for the call
- `database` (string | null, optional): Database name to switch to

Prefixes are Redis glob patterns: escape `*`, `?`, `[`, `]` and `\` in any user-supplied part. An
empty prefix without `REDIS_VHOST` deletes every key in that Redis database.

#### Returns

Promise resolving to the mysql2 result: rows for a `SELECT`, or `{ insertId, affectedRows, ... }`
for a write. In TypeScript, pass the type for reads: `QuaryCache<User[]>('SELECT ...', [id])`.

The statement is retried after connection errors (see the README's Failure handling), so a write
can run twice: make writes idempotent.

#### Examples

```javascript
// Auto invalidation (requires CORE_AUTO_INVALIDATION=true)
const result = await QuaryCache(
    'INSERT INTO users (name, email) VALUES (?, ?)',
    ['John', 'john@example.com']
);
console.log(result.insertId); // 123

// Manual invalidation pattern
await QuaryCache(
    'UPDATE users SET status = ? WHERE id = ?',
    ['active', 123],
    'users_*'  // Clear all keys starting with "users_"
);

// Multiple patterns
await QuaryCache(
    'DELETE FROM users WHERE id = ?',
    [123],
    ['users_*', 'profiles_*', 'sessions_*']
);

// With database switching
await QuaryCache(
    'INSERT INTO logs (message) VALUES (?)',
    ['User logged in'],
    'logs_*',
    'logging_db'
);
```

---

### getCacheQueryPagination

Execute paginated SELECT query with caching.

Since v2.9.0 the total is counted with `SELECT COUNT(*)` over the query, and not at all when the
requested page is the last one. Queries MySQL cannot wrap in a derived table (e.g. duplicate column
names) are counted by fetching every row, as before; a leading `MAX_EXECUTION_TIME` hint also
bounds the count. Concurrent cache misses for the same page share one database query. With
`DB_PAGINATION_REUSE_TOTAL=true` the total of one page is reused for the other pages of the same
query until `cacheName` is invalidated.

Each page is cached as `<cacheName>:page<n>:size<m>`. Since v2.9.1 the `LIMIT` is appended on a new
line, so SQL that ends with a `-- comment` paginates correctly, and a cached value is only used if it
is a page object.

#### Signature

```typescript
getCacheQueryPagination<T = any>(
    sql: string,
    parameters: any[],
    cacheName: string | null | undefined,
    page: number,
    pageSize?: number,
    database?: string | null
): Promise<PaginationResult<T>>
```

#### Parameters

- `sql` (string): SQL SELECT query
- `parameters` (any[]): Query parameters (required, use `[]` for none)
- `cacheName` (string | null): Cache key prefix. Since v2.9.1, without one an automatic key is used when
  automatic keys are enabled; otherwise the result is not cached and a one-time warning is logged
  (earlier versions shared one cache key between all such calls)
- `page` (number): Page number, 0-based (`0` is the first page; invalid values become `0`)
- `pageSize` (number, optional): Items per page (default: 30); must be greater than 0
- `database` (string | null, optional): Database to switch to

#### Returns

```typescript
interface PaginationResult<T> {
    totalCount: number;  // rows in the whole result
    pageCount: number;   // Math.ceil(totalCount / pageSize)
    detail: T[];         // rows of the requested page
}
```

#### Examples

```javascript
const result = await getCacheQueryPagination(
    'SELECT * FROM users WHERE status = ? ORDER BY id',
    ['active'],
    'active-users',
    0,  // first page
    20  // 20 items per page
);

console.log(result);
/*
{
    totalCount: 157,
    pageCount: 8,
    detail: [...]   // up to 20 rows
}
*/
```

---

### withTransaction

Execute queries within a database transaction with automatic commit/rollback.

#### Signature

```typescript
withTransaction<T = any>(
    callback: (tx: TransactionContext) => T | Promise<T>,
    options?: TransactionOptions
): Promise<T>
```

#### Parameters

- `callback` (function): Function (usually async) receiving the transaction context
- `options` (object, optional):
  - `database` (string | null): Database to switch to

#### Transaction Context

```typescript
interface TransactionContext {
    query<T>(sql: string, parameters?: any[], resetCacheName?: string | string[] | null): Promise<T>;
    getCacheQuery<T>(sql: string, parameters?: any[], cacheName?: string | null): Promise<T[]>;
    getConnection(): any;
}
```

#### Returns

Promise resolving to callback return value

#### Examples

```javascript
// Basic transaction
await withTransaction(async (tx) => {
    await tx.query('INSERT INTO users...', [data]);
    await tx.query('INSERT INTO profiles...', [profileData]);
    // Auto commit on success
});

// With return value
const userId = await withTransaction(async (tx) => {
    const userResult = await tx.query(
        'INSERT INTO users (name) VALUES (?)',
        ['John']
    );
    return userResult.insertId;
});

// With database switching
await withTransaction(async (tx) => {
    await tx.query('INSERT INTO logs...', [data]);
}, { database: 'logs_db' });

// Error handling (automatic rollback)
try {
    await withTransaction(async (tx) => {
        await tx.query('INSERT INTO users...', [data]);
        throw new Error('Business logic error');
        // Transaction automatically rolled back
    });
} catch (error) {
    console.error('Transaction failed:', error);
}

// Using getCacheQuery in transaction
await withTransaction(async (tx) => {
    // Read from cache (not transaction-isolated!)
    const [user] = await tx.getCacheQuery(
        'SELECT * FROM users WHERE id = ?',
        [123],
        'user-123'
    );

    // Update user, and drop the cached row once the transaction commits
    await tx.query(
        'UPDATE users SET balance = balance + ? WHERE id = ?',
        [100, user.id],
        'user-123'
    );
});
```

#### Important Notes

- Cache invalidation is buffered and applied **only on commit**
- `tx.getCacheQuery()` checks the cache first, so a hit **doesn't guarantee transaction isolation**
- Since v2.9.1 `tx.getCacheQuery()` writes what it read to the cache only after the commit; nothing
  is cached from a rolled-back transaction (v2.9.0 cached it immediately)
- For critical reads, use `tx.query()` instead
- Transactions auto-rollback on any error

---

## Production Features

### bulkInsert

Insert large datasets with automatic chunking.

#### Signature

```typescript
bulkInsert<T = any>(
    table: string,
    records: T[],
    options?: BulkInsertOptions
): Promise<BulkInsertResult>
```

#### Parameters

- `table` (string): Table name, used in the SQL as-is
- `records` (array): Array of objects with column-value pairs. The columns are the keys of the first
  record, used in the SQL as-is; later records are read for those columns only (a missing key is
  inserted as `NULL`, extra keys are ignored)
- `options` (object, optional):
  - `chunkSize` (number): Records per chunk (default: 1000)
  - `database` (string | null): Database to switch to
  - `resetCacheName` (string | string[] | null): Prefixes to invalidate after the insert
  - `transaction` (boolean, v2.9.0): insert all chunks in one transaction, all or nothing
    (default: false, each chunk commits on its own as before)

#### Notes

- **Never pass untrusted keys.** Map request or CSV input onto a fixed list of columns. Since v2.9.1
  an invalid table or column name is rejected before anything is sent, with a `TypeError`:
  `bulkInsert: invalid table name "<name>"` or `bulkInsert: invalid column name "<name>"`. Valid names
  are unchanged.
- **Invalidation:** `resetCacheName` prefixes are deleted after the insert. Since v2.9.1, without
  `resetCacheName`, auto-invalidation (`CORE_AUTO_INVALIDATION` / `enableAutoInvalidation`) also applies
  to `bulkInsert`, and invalidation also runs when the insert fails after rows may have been written.
- **Retries:** after a connection error the insert is retried from the first chunk that was not
  acknowledged, so a chunk whose acknowledgement was lost can be inserted twice. With
  `transaction: true` a retry starts over; an error from `COMMIT` is not retried and carries
  `err.commitOutcomeUnknown = true` (since v2.9.1), because the rows may or may not have been written.

#### Returns

```typescript
interface BulkInsertResult {
    insertedRows: number;
    chunks: number;
}
```

#### Examples

```javascript
const users = [
    { name: 'Alice', email: 'alice@example.com' },
    { name: 'Bob', email: 'bob@example.com' },
    // ... 100,000 more records
];

const result = await bulkInsert('users', users, {
    chunkSize: 1000,
    resetCacheName: 'users_*',
    database: 'main_db'
});

console.log(result);
// { insertedRows: 100002, chunks: 101 }
```

---

### getCacheQueryWithTimeout

Execute query with timeout protection.

#### Signature

```typescript
getCacheQueryWithTimeout<T = any>(
    sql: string,
    parameters?: any[],
    cacheName?: string | null,
    options?: QueryTimeoutOptions
): Promise<T[]>
```

#### Parameters

- `sql` (string): SQL query
- `parameters` (any[], optional): Query parameters
- `cacheName` (string | null): Cache key. Since v2.9.1, without one an automatic key is used when
  automatic keys are enabled; otherwise the result is not cached and a one-time warning is logged
  (earlier versions shared one cache key between all such calls)
- `options` (object, optional):
  - `timeout` (number): Timeout in milliseconds (default: 30000)
  - `database` (string | null): Database to switch to
  - `cancelOnTimeout` (boolean, v2.9.0): stop a query still running on the server when the timeout
    fires (`KILL QUERY`, using a short-lived extra connection) instead of letting it finish and cache
    its result (default: false)

Since v2.9.0 a call whose timeout fires before its query started (e.g. while waiting for a pool
connection) no longer runs the query afterwards; since v2.9.1 this also holds when the timeout fires
while the call switches to `database`. With `cancelOnTimeout`, since v2.9.1 the connection whose query
was killed is discarded instead of being returned to the pool, and at most 4 cancellations run at
once.

#### Returns

Promise resolving to query results

#### Examples

```javascript
try {
    const users = await getCacheQueryWithTimeout(
        'SELECT * FROM users WHERE created_at > ?',
        [lastWeek],
        'recent-users',
        {
            timeout: 5000,  // 5 second timeout
            database: 'analytics_db'
        }
    );
} catch (error) {
    if (error.message.includes('timeout')) {
        console.error('Query took too long');
    }
}
```

---

### closeConnections

Gracefully close the MySQL connection pool. New queries are rejected afterwards. The Redis client is
not closed: quit it yourself when Redis is enabled, or its open connection keeps the process alive.

#### Signature

```typescript
closeConnections(): Promise<void>
```

#### Examples

```javascript
const { closeConnections, getRedisClient } = require('sqlcache');

async function shutdown() {
    await closeConnections();
    if (process.env.REDIS_ENABLED !== 'false') getRedisClient().quit();
}

// In app shutdown
process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    await shutdown();
    process.exit(0);
});

// In tests
after(async () => {
    await shutdown();
});
```

---

### getPoolStats

Get current connection pool statistics.

#### Signature

```typescript
getPoolStats(): PoolStats
```

#### Returns

```typescript
interface PoolStats {
    totalConnections: number;
    activeConnections: number;
    freeConnections: number;
    queuedRequests: number;
}
```

#### Examples

```javascript
const stats = getPoolStats();
console.log(stats);
/*
{
    totalConnections: 10,
    activeConnections: 3,
    freeConnections: 7,
    queuedRequests: 0
}
*/

// Monitor pool usage. Connections are opened on demand (an idle pool reports 0 of 0),
// so requests waiting for a connection are what shows an exhausted pool.
setInterval(() => {
    const stats = getPoolStats();
    if (stats.queuedRequests > 0) {
        console.warn('Connection pool exhausted: requests are waiting for a connection');
    }
}, 60000);
```

---

## Redis Operations

### getArrayItem

Retrieve data from Redis cache. Never throws: returns `[]` on a miss or when Redis is unavailable
(immediately once Redis has been down for `REDIS_WAIT_TIMEOUT`, see `REDIS_FAIL_FAST`).

#### Signature

```typescript
getArrayItem<T = any>(key: string): Promise<T[]>
```

#### Examples

```javascript
const users = await getArrayItem('active-users');
if (users.length > 0) {
    console.log('Cache hit:', users);
} else {
    console.log('Cache miss');
}
```

---

### addArrayItem

Store data in Redis cache. Never throws: if Redis is unavailable the data is returned without being
cached.

#### Signature

```typescript
addArrayItem<T = any>(
    key: string,
    data: T[],
    expiryDate?: number
): Promise<T[]>
```

#### Parameters

- `key` (string): Cache key
- `data` (array): Data to cache
- `expiryDate` (number, optional): TTL in seconds (default: 40000)

#### Examples

```javascript
await addArrayItem('active-users', users, 3600); // 1 hour TTL
```

---

### delKeyItem

Delete one or more cache keys. Waits for Redis and is never cut short by `REDIS_COMMAND_TIMEOUT`;
keys that could not be deleted because Redis was unreachable are deleted once it is ready again.

#### Signature

```typescript
delKeyItem(keys: string | string[]): Promise<void>
```

#### Examples

```javascript
// Single key
await delKeyItem('user-123');

// Multiple keys
await delKeyItem(['user-123', 'user-456', 'user-789']);
```

---

### delPrefixKeyItem

Delete all keys matching prefix pattern(s). Uses `SCAN` (`REDIS_SCAN_COUNT` keys per round trip)
and deletes while scanning; several prefixes are scanned concurrently, and prefixes that can share
one pass (e.g. `users_` and `users:`) are merged. Waits like `delKeyItem`, and invalidations missed
during an outage are replayed when Redis is ready again.

Prefixes are Redis glob patterns (`*` is appended): escape `*`, `?`, `[`, `]` and `\` in any
user-supplied part. An empty prefix without `REDIS_VHOST` deletes every key in that Redis database.

#### Signature

```typescript
delPrefixKeyItem(patterns: string | string[]): Promise<void>
```

#### Examples

```javascript
// Single pattern
await delPrefixKeyItem('users_');

// Multiple patterns
await delPrefixKeyItem(['users_', 'profiles_', 'sessions_']);
```

---

### isRedisConnected

Check whether the Redis connection is ready, for health checks. Since v2.9.1 it returns `false`
without opening a connection when `REDIS_ENABLED=false` (v2.9.0 opened one on the first call).

#### Signature

```typescript
isRedisConnected(): boolean
```

#### Examples

```javascript
app.get('/health', (req, res) => {
    res.json({ redis: isRedisConnected() });
});
```

---

### getRedisClient

Get raw Redis client instance.

#### Signature

```typescript
getRedisClient(): RedisClient
```

#### Examples

```javascript
const client = getRedisClient();
client.set('custom-key', 'value');
client.expire('custom-key', 3600);
```

---

## Configuration

### configure

Configure all v2.6.0 features at once.

#### Signature

```typescript
configure(config?: ConfigureOptions): void
```

#### Parameters

```typescript
interface ConfigureOptions {
    autoKey?: boolean | {
        enabled?: boolean;
    };
    autoInvalidation?: boolean | {
        enabled?: boolean;
        tables?: Record<string, string | string[]>;
    };
}
```

Each option is passed to `enableAutoKey` / `enableAutoInvalidation`. `{ enabled: false }` turns the
feature off, and since v2.9.1 so does `false` (earlier versions turned it on for `false`).

#### Examples

```javascript
const { configure } = require('sqlcache');

configure({
    autoKey: { enabled: true },
    autoInvalidation: {
        enabled: true,
        tables: {
            users: ['users:*', 'users_*', 'profiles_*'],
            orders: ['orders:*', 'orders_*', 'cart_*']
        }
    }
});
```

A `tables` rule replaces the default `<table>_*` and `<table>:*` patterns for that table; keep
`<table>:*` when you use automatic keys, which start with `<table>:`.

---

### enableAutoKey

Enable automatic cache key generation, used when a call has no cache name.

#### Signature

```typescript
enableAutoKey(config?: AutoKeyConfig | boolean): void
```

#### Examples

```javascript
const { enableAutoKey } = require('sqlcache');

enableAutoKey({ enabled: true });
enableAutoKey(false); // turns it off (v2.9.1; earlier versions turned it on)
```

Since v2.9.1 queries without a detectable table (`CALL`, `SELECT fn(?)`) get the key
`query:<sqlhash>:<paramhash>`, and `BigInt` parameters no longer throw.

---

### enableAutoInvalidation

Enable automatic cache invalidation.

#### Signature

```typescript
enableAutoInvalidation(config?: AutoInvalidationConfig | boolean): void
```

#### Examples

```javascript
const { enableAutoInvalidation } = require('sqlcache');

enableAutoInvalidation({
    enabled: true,
    tables: {
        users: ['users:*', 'users_*', 'profiles_*'],
        orders: ['orders:*', 'orders_*']
    }
});

enableAutoInvalidation(false); // turns it off (v2.9.1; earlier versions turned it on)
```

---

**[← Back to Main README](../README.md)**
