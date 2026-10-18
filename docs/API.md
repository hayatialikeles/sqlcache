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
    parameters: any[],
    cacheName?: string | null,
    database?: string | null
): Promise<T[]>
```

#### Parameters

- `sql` (string): SQL SELECT query
- `parameters` (any[]): Query parameters (use `?` placeholders)
- `cacheName` (string | null, optional): Cache key. Auto-generated if `CORE_AUTO_FEATURES=true`
- `database` (string | null, optional): Database name to switch to

#### Returns

Promise resolving to array of query results

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
    [123]
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
        console.error('Query failed:', error);
    }
}
```

---

### QuaryCache

Execute INSERT/UPDATE/DELETE queries with automatic cache invalidation.

#### Signature

```typescript
QuaryCache(
    sql: string,
    parameters: any[],
    resetCacheName?: string | string[] | null,
    database?: string | null
): Promise<any>
```

#### Parameters

- `sql` (string): SQL query (INSERT/UPDATE/DELETE)
- `parameters` (any[]): Query parameters
- `resetCacheName` (string | string[] | null, optional): Cache patterns to invalidate. Auto-detected if `CORE_AUTO_FEATURES=true`
- `database` (string | null, optional): Database name to switch to

#### Returns

Promise resolving to query result (insertId, affectedRows, etc.)

#### Examples

```javascript
// Auto invalidation (requires CORE_AUTO_FEATURES=true)
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
bounds the count. Concurrent cache misses for the same page share one database query.

#### Signature

```typescript
getCacheQueryPagination<T = any>(
    sql: string,
    parameters: any[],
    cacheName: string,
    page: number,
    pageSize?: number,
    database?: string | null
): Promise<PaginationResult<T>>
```

#### Parameters

- `sql` (string): SQL SELECT query
- `parameters` (any[]): Query parameters
- `cacheName` (string): Cache key prefix
- `page` (number): Page number (1-indexed)
- `pageSize` (number, optional): Items per page (default: 10)
- `database` (string | null, optional): Database to switch to

#### Returns

```typescript
interface PaginationResult<T> {
    data: T[];
    page: number;
    pageSize: number;
    totalCount: number;
    pageCount: number;
}
```

#### Examples

```javascript
const result = await getCacheQueryPagination(
    'SELECT * FROM users WHERE status = ?',
    ['active'],
    'active-users',
    1,  // page 1
    20  // 20 items per page
);

console.log(result);
/*
{
    data: [...],
    page: 1,
    pageSize: 20,
    totalCount: 157,
    pageCount: 8
}
*/
```

---

### withTransaction

Execute queries within a database transaction with automatic commit/rollback.

#### Signature

```typescript
withTransaction<T = any>(
    callback: (tx: TransactionContext) => Promise<T>,
    options?: TransactionOptions
): Promise<T>
```

#### Parameters

- `callback` (function): Async function receiving transaction context
- `options` (object, optional):
  - `database` (string | null): Database to switch to

#### Transaction Context

```typescript
interface TransactionContext {
    query<T>(sql: string, parameters: any[], resetCacheName?: string | string[] | null): Promise<T>;
    getCacheQuery<T>(sql: string, parameters: any[], cacheName?: string | null): Promise<T[]>;
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

    // Update user
    await tx.query(
        'UPDATE users SET balance = balance + ? WHERE id = ?',
        [100, user.id]
    );
});
```

#### Important Notes

- Cache invalidation is buffered and applied **only on commit**
- `tx.getCacheQuery()` reads from cache but **doesn't guarantee transaction isolation**
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

- `table` (string): Table name
- `records` (array): Array of objects with column-value pairs
- `options` (object, optional):
  - `chunkSize` (number): Records per chunk (default: 1000)
  - `database` (string | null): Database to switch to
  - `resetCacheName` (string | null): Cache pattern to invalidate

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
    parameters: any[],
    cacheName: string,
    options?: QueryTimeoutOptions
): Promise<T[]>
```

#### Parameters

- `sql` (string): SQL query
- `parameters` (any[]): Query parameters
- `cacheName` (string): Cache key
- `options` (object, optional):
  - `timeout` (number): Timeout in milliseconds (default: 30000)
  - `database` (string | null): Database to switch to
  - `cancelOnTimeout` (boolean, v2.9.0): stop a query still running on the server when the timeout
    fires (`KILL QUERY`, using a short-lived extra connection) instead of letting it finish and cache
    its result (default: false)

Since v2.9.0 a call whose timeout fires before its query started (e.g. while waiting for a pool
connection) no longer runs the query afterwards.

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

Gracefully close all database connections.

#### Signature

```typescript
closeConnections(): Promise<void>
```

#### Examples

```javascript
// In app shutdown
process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    await closeConnections();
    process.exit(0);
});

// In tests
after(async () => {
    await closeConnections();
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

// Monitor pool usage
setInterval(() => {
    const stats = getPoolStats();
    if (stats.activeConnections === stats.totalConnections) {
        console.warn('Connection pool exhausted!');
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
configure(config?: CoreConfig): void
```

#### Parameters

```typescript
interface CoreConfig {
    autoKey?: {
        enabled?: boolean;
    };
    autoInvalidation?: {
        enabled?: boolean;
        tables?: Record<string, string | string[]>;
    };
}
```

#### Examples

```javascript
const { configure } = require('node-caching-mysql-connector-with-redis');

configure({
    autoKey: { enabled: true },
    autoInvalidation: {
        enabled: true,
        tables: {
            users: ['users_*', 'profiles_*'],
            orders: ['orders_*', 'cart_*']
        }
    }
});
```

---

### enableAutoKey

Enable automatic cache key generation.

#### Signature

```typescript
enableAutoKey(config?: AutoKeyConfig): void
```

#### Examples

```javascript
const { enableAutoKey } = require('node-caching-mysql-connector-with-redis');

enableAutoKey({ enabled: true });
```

---

### enableAutoInvalidation

Enable automatic cache invalidation.

#### Signature

```typescript
enableAutoInvalidation(config?: AutoInvalidationConfig): void
```

#### Examples

```javascript
const { enableAutoInvalidation } = require('node-caching-mysql-connector-with-redis');

enableAutoInvalidation({
    enabled: true,
    tables: {
        users: ['users_*', 'profiles_*'],
        orders: 'orders_*'
    }
});
```

---

**[← Back to Main README](../README.md)**
