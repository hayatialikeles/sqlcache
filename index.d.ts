/**
 * Type definitions for sqlcache
 * Project: https://github.com/hayatialikeles/sqlcache
 * Definitions by: Hayati Ali Keleş
 */

/// <reference types="node" />

declare module 'sqlcache' {
    /**
     * Result of a write statement: mysql2's ResultSetHeader (`affectedRows`, `insertId`, `info`,
     * `serverStatus`, `warningStatus`, `changedRows`, `fieldCount`). `warningCount`, `message` and
     * `protocol41` are kept for compatibility; mysql2 does not set them.
     */
    export interface QueryResult {
        affectedRows?: number;
        insertId?: number;
        warningCount?: number;
        message?: string;
        protocol41?: boolean;
        changedRows?: number;
        fieldCount?: number;
        serverStatus?: number;
        /** Server message, e.g. "Rows matched: 1  Changed: 1  Warnings: 0" */
        info?: string;
        /** Number of warnings */
        warningStatus?: number;
    }

    /**
     * Pagination result structure
     */
    export interface PaginationResult<T = any> {
        totalCount: number;
        pageCount: number;
        detail: T[];
    }

    /**
     * Redis client interface
     */
    export interface RedisClient {
        [key: string]: any;
    }

    // ==================== DATABASE FUNCTIONS ====================

    /**
     * Runs a SQL statement on MySQL. It never reads the cache. After the statement succeeds, every
     * cached key starting with `resetCacheName` (a prefix, or an array of prefixes) is deleted; without
     * it, automatic invalidation applies when CORE_AUTO_INVALIDATION=true or enableAutoInvalidation()
     * is on. A `resetCacheName` replaces the automatic patterns for the call.
     *
     * Prefixes are Redis glob patterns: escape `* ? [ ] \` in user-supplied parts. An empty prefix
     * without REDIS_VHOST deletes every key in that Redis database.
     *
     * On connection errors the statement is attempted up to 3 times, so a write can run twice: make
     * writes idempotent. mysql2 errors carry `err.sql` with the parameter values filled in.
     *
     * @param sql - The SQL statement to execute
     * @param parameters - The parameters to be passed to the SQL statement (optional)
     * @param resetCacheName - Prefix or prefixes of the cache keys to delete after the statement (optional)
     * @param database - The database name to switch to (optional)
     * @returns The mysql2 result: rows for a SELECT, a {@link QueryResult} for a write. Pass the type
     *   for reads, e.g. `QuaryCache<User[]>('SELECT ...', [id])`.
     *
     * @example
     * ```typescript
     * const result = await QuaryCache(
     *   "INSERT INTO users SET name = ?, email = ?",
     *   ["John", "john@example.com"],
     *   "users-cache"
     * );
     * console.log(result.insertId);
     *
     * // Several prefixes
     * await QuaryCache("DELETE FROM users WHERE id = ?", [1], ["users:", "profiles:"]);
     * ```
     */
    export function QuaryCache<T = QueryResult>(
        sql: string,
        parameters?: any[],
        resetCacheName?: string | string[] | null,
        database?: string | null
    ): Promise<T>;

    /**
     * Retrieves data from cache or database based on the provided SQL query and parameters.
     * If the data is found in the cache, it is returned. Otherwise, the data is fetched from the database,
     * stored in the cache, and then returned.
     *
     * **v2.6.0:** cacheName is now optional when CORE_AUTO_FEATURES=true.
     * The cache key will be auto-generated from the SQL query and parameters.
     *
     * **v2.9.0:** concurrent cache misses for the same key, database, SQL and parameters share
     * one database query; every caller still gets its own copy of the rows
     * (`DB_COALESCE_QUERIES=false` turns this off). Auto-generated keys of calls that pass
     * `database` end with `@<database>`, so databases (tenants) never share cache entries.
     *
     * **v2.9.1:** empty results are not written to the cache (they were never served from it), and a
     * cached value that is not a non-empty array is treated as a miss. A read that started before an
     * invalidation in the same process does not write its possibly stale result. A caller that has
     * waited `DB_COALESCE_MAX_WAIT` ms (default 10000) for a shared query starts its own, but still
     * takes the shared result if it arrives first; an `ER_QUERY_TIMEOUT` of the shared query goes to
     * every caller waiting on it.
     *
     * Results are cached for 40000 s as JSON: on a cache hit a `Date` is an ISO string and a `Buffer`
     * is `{ type, data }`, while a miss returns mysql2's types. Without `cacheName` and with automatic
     * keys disabled, the call rejects with `cacheName is required...`.
     *
     * @param sql - The SQL query to be executed
     * @param parameters - The parameters to be passed to the SQL query (optional)
     * @param cacheName - The name of the cache to store the data (optional if auto key enabled)
     * @param database - The database name to switch to (optional)
     * @returns A promise that resolves to the retrieved data
     *
     * @example
     * ```typescript
     * interface User {
     *   id: number;
     *   name: string;
     *   email: string;
     * }
     *
     * // v2.5.3 style (still works)
     * const users = await getCacheQuery<User>(
     *   "SELECT * FROM users WHERE company_id = ?",
     *   [123],
     *   "users-company-123"
     * );
     *
     * // v2.6.0 style (auto key) - Requires CORE_AUTO_FEATURES=true
     * const users = await getCacheQuery<User>(
     *   "SELECT * FROM users WHERE company_id = ?",
     *   [123]
     * );
     * // Auto key: "users:company_id:a7b3c2d1"
     * ```
     */
    export function getCacheQuery<T = any>(
        sql: string,
        parameters?: any[],
        cacheName?: string | null,
        database?: string | null
    ): Promise<T[]>;

    /**
     * Retrieves paginated data from cache or database based on the provided SQL query and parameters.
     * If the data is available in cache, it is returned directly. Otherwise, the data is fetched from the database,
     * paginated, and then stored in the cache for future use.
     *
     * **v2.9.0:** the total is counted with `SELECT COUNT(*)` over the query, and not at all when the
     * requested page is the last one. Queries MySQL cannot wrap in a derived table (e.g. duplicate
     * column names) are counted by fetching every row, as before. A leading `MAX_EXECUTION_TIME`
     * optimizer hint also bounds the count. With `DB_PAGINATION_REUSE_TOTAL=true` the total of one
     * page is reused for the other pages of the same query until `cacheName` is invalidated.
     *
     * Each page is cached as `<cacheName>:page<n>:size<m>`, so invalidating `cacheName` clears every
     * page.
     *
     * **v2.9.1:** `LIMIT` is appended on a new line, so SQL ending in a `-- comment` paginates
     * correctly, and a cached value is only used if it is a page object. Without a `cacheName`, an
     * automatic key is used when automatic keys are enabled; otherwise the result is not cached and a
     * one-time warning is logged (before 2.9.1 all such calls shared one cache key).
     *
     * @param sql - The SQL query to execute
     * @param parameters - The parameters to be used in the SQL query (`[]` for none)
     * @param cacheName - The name of the cache to store the data (`null`: see above)
     * @param page - The page number of the data to retrieve (0-based)
     * @param pageSize - The number of records per page (default: 30)
     * @param database - The database name to switch to (optional)
     * @returns A promise that resolves to `{ totalCount, pageCount, detail }`
     *
     * @example
     * ```typescript
     * interface Product {
     *   id: number;
     *   name: string;
     *   price: number;
     * }
     *
     * const result = await getCacheQueryPagination<Product>(
     *   "SELECT * FROM products WHERE category = ?",
     *   [5],
     *   "products:cat:5",
     *   0,
     *   25
     * );
     *
     * console.log(`Total: ${result.totalCount}`);
     * console.log(`Pages: ${result.pageCount}`);
     * result.detail.forEach(product => console.log(product.name));
     * ```
     */
    export function getCacheQueryPagination<T = any>(
        sql: string,
        parameters: any[],
        cacheName: string | null | undefined,
        page: number,
        pageSize?: number,
        database?: string | null
    ): Promise<PaginationResult<T>>;

    // ==================== REDIS FUNCTIONS ====================

    /**
     * Retrieves an item from Redis cache
     *
     * Never throws: returns `[]` on a miss or when Redis is unavailable. Once Redis has been
     * unavailable for REDIS_WAIT_TIMEOUT it returns `[]` without waiting (REDIS_FAIL_FAST), and a
     * command unanswered for REDIS_COMMAND_TIMEOUT also falls back to `[]`.
     *
     * @param key - The cache key
     * @returns A promise that resolves to the cached data or empty array if not found
     *
     * @example
     * ```typescript
     * const userData = await getArrayItem<User>('user-123');
     * if (userData.length > 0) {
     *   console.log(userData);
     * }
     * ```
     */
    export function getArrayItem<T = any>(key: string): Promise<T[]>;

    /**
     * Stores an item in Redis cache with optional expiry
     *
     * Never throws: if Redis is unavailable the data is returned without being cached
     * (without waiting once Redis has been down for REDIS_WAIT_TIMEOUT).
     *
     * @param key - The cache key
     * @param array - The data to cache
     * @param expiryDate - Time to live in seconds (default: 40000)
     * @returns A promise that resolves to the cached data
     *
     * @example
     * ```typescript
     * await addArrayItem('user-123', userData, 3600); // 1 hour TTL
     * ```
     */
    export function addArrayItem<T = any>(
        key: string,
        array: T[],
        expiryDate?: number
    ): Promise<T[]>;

    /**
     * Deletes one or more keys from Redis cache
     *
     * Waits for Redis (up to REDIS_WAIT_TIMEOUT) and is never cut short by REDIS_COMMAND_TIMEOUT.
     * Keys that could not be deleted because Redis was unreachable are deleted once it is ready again.
     *
     * @param keys - Single key or array of keys to delete
     * @returns A promise that resolves when deletion is complete
     *
     * @example
     * ```typescript
     * // Delete single key
     * await delKeyItem('user-123');
     *
     * // Delete multiple keys
     * await delKeyItem(['user-123', 'user-456', 'user-789']);
     * ```
     */
    export function delKeyItem(keys: string | string[]): Promise<void>;

    /**
     * Deletes all keys matching a prefix pattern from Redis cache
     *
     * Uses SCAN (REDIS_SCAN_COUNT keys per round trip) and deletes while scanning. Several prefixes
     * are scanned concurrently; prefixes that can share one pass (e.g. 'users_' and 'users:') are
     * merged. Waits for Redis like delKeyItem, and invalidations that could not run because Redis
     * was unreachable are replayed once it is ready again.
     *
     * Prefixes are Redis glob patterns (`*` is appended): escape `* ? [ ] \` in user-supplied parts.
     * An empty prefix without REDIS_VHOST deletes every key in that Redis database.
     *
     * @param keys - Single prefix or array of prefixes
     * @returns A promise that resolves when deletion is complete
     *
     * @example
     * ```typescript
     * // Delete all keys starting with "users-"
     * await delPrefixKeyItem('users-');
     *
     * // Delete multiple prefixes
     * await delPrefixKeyItem(['users-', 'products-', 'orders-']);
     * ```
     */
    export function delPrefixKeyItem(keys: string | string[]): Promise<void>;

    /**
     * Check if Redis connection is healthy.
     * Useful for health-check endpoints and monitoring.
     * **v2.9.1:** with REDIS_ENABLED=false it returns false without opening a connection (2.9.0
     * opened one on the first call).
     *
     * @returns true if Redis is connected and ready
     *
     * @example
     * ```typescript
     * app.get('/health', (req, res) => {
     *   res.json({ redis: isRedisConnected() });
     * });
     * ```
     */
    export function isRedisConnected(): boolean;

    /**
     * Returns the raw Redis client instance
     *
     * @returns The Redis client
     *
     * @example
     * ```typescript
     * const client = getRedisClient();
     * client.set('custom-key', 'value');
     * ```
     */
    export function getRedisClient(): RedisClient;

    // ==================== PRODUCTION-GRADE FEATURES (v2.5.3+) ====================

    /**
     * Bulk insert options
     */
    export interface BulkInsertOptions {
        /** Database name to switch to */
        database?: string | null;
        /** Number of records per chunk (default: 1000) */
        chunkSize?: number;
        /**
         * Cache name prefix (or prefixes) to reset after insert. Without it, automatic invalidation
         * applies when enabled (v2.9.1).
         */
        resetCacheName?: string | string[] | null;
        /**
         * v2.9.0: insert all chunks in one transaction (all or nothing, and faster for large
         * inserts). Without it each chunk commits on its own, as before (default: false).
         * v2.9.1: an error from COMMIT is not retried and carries `err.commitOutcomeUnknown = true`.
         */
        transaction?: boolean;
    }

    /**
     * Bulk insert result
     */
    export interface BulkInsertResult {
        /** Total number of rows inserted */
        insertedRows: number;
        /** Number of chunks processed */
        chunks: number;
    }

    /**
     * Query timeout options
     */
    export interface QueryTimeoutOptions {
        /** Query timeout in milliseconds (default: 30000) */
        timeout?: number;
        /** Database name to switch to */
        database?: string | null;
        /**
         * v2.9.0: stop a query that is still running on the server when the timeout fires
         * (KILL QUERY), instead of letting it finish and cache its result (default: false)
         */
        cancelOnTimeout?: boolean;
    }

    /**
     * Pool statistics
     */
    export interface PoolStats {
        /** Total number of connections in the pool */
        totalConnections: number;
        /** Number of active connections currently in use */
        activeConnections: number;
        /** Number of free connections available */
        freeConnections: number;
        /** Number of queued requests waiting for a connection */
        queuedRequests: number;
    }

    /**
     * Executes a bulk insert operation with automatic chunking for large datasets.
     * Prevents memory issues by splitting large datasets into manageable chunks.
     *
     * The columns are the keys of the first record, and the table and column names are used in the
     * SQL as-is. Never pass untrusted keys: map request or CSV input onto a fixed list of columns.
     * **v2.9.1:** an invalid name is rejected before anything is sent, with a `TypeError`
     * (`bulkInsert: invalid table name "<name>"` / `bulkInsert: invalid column name "<name>"`).
     *
     * After a connection error the insert is retried from the first unacknowledged chunk, so a chunk
     * can be inserted twice. With `transaction: true` a retry starts over, and (v2.9.1) an error from
     * COMMIT is not retried and carries `err.commitOutcomeUnknown = true`.
     *
     * **v2.9.1:** without `resetCacheName`, automatic invalidation (CORE_AUTO_INVALIDATION /
     * enableAutoInvalidation) applies, and invalidation also runs when the insert fails after rows
     * may have been written.
     *
     * @param table - The table name to insert into
     * @param records - Array of objects with column-value pairs
     * @param options - Optional settings for bulk insert
     * @returns Promise resolving to insert statistics
     *
     * @example
     * ```typescript
     * const users = [
     *   { name: 'Alice', email: 'alice@example.com' },
     *   { name: 'Bob', email: 'bob@example.com' }
     * ];
     *
     * const result = await bulkInsert('users', users, {
     *   chunkSize: 500,
     *   resetCacheName: 'users_'
     * });
     * // { insertedRows: 2, chunks: 1 }
     * ```
     */
    export function bulkInsert<T = any>(
        table: string,
        records: T[],
        options?: BulkInsertOptions
    ): Promise<BulkInsertResult>;

    /**
     * Executes a query with timeout protection to prevent long-running queries.
     * Automatically retries on connection errors with exponential backoff.
     *
     * **v2.9.0:** a call whose timeout fires before its query started (e.g. while waiting for a
     * pool connection) no longer runs the query afterwards. A query that is already running
     * keeps running and caches its result, unless `cancelOnTimeout: true` is set.
     *
     * **v2.9.1:** a timeout during the database switch also stops the query from being sent. With
     * `cancelOnTimeout`, the connection whose query was killed is discarded instead of being
     * returned to the pool, and at most 4 cancellations run at once. Without a `cacheName`, an
     * automatic key is used when automatic keys are enabled; otherwise the result is not cached and
     * a one-time warning is logged (before 2.9.1 all such calls shared one cache key).
     *
     * The call rejects with `Query timeout exceeded` when the timeout fires.
     *
     * @param sql - The SQL query to execute
     * @param parameters - Query parameters (optional)
     * @param cacheName - Cache key for storing results (see above when omitted)
     * @param options - Optional timeout and database settings
     * @returns Promise resolving to query results
     *
     * @example
     * ```typescript
     * const users = await getCacheQueryWithTimeout<User>(
     *   'SELECT * FROM users WHERE status = ?',
     *   ['active'],
     *   'active_users',
     *   { timeout: 5000, database: 'analytics_db' }
     * );
     * ```
     */
    export function getCacheQueryWithTimeout<T = any>(
        sql: string,
        parameters?: any[],
        cacheName?: string | null,
        options?: QueryTimeoutOptions
    ): Promise<T[]>;

    /**
     * Gracefully closes the MySQL connection pool; new queries are rejected afterwards.
     * Should be called during application shutdown to prevent connection leaks.
     *
     * The Redis client is not closed: when Redis is enabled, also call `getRedisClient().quit()`,
     * or the open Redis connection keeps the process alive.
     *
     * @example
     * ```typescript
     * process.on('SIGTERM', async () => {
     *   await closeConnections();
     *   if (process.env.REDIS_ENABLED !== 'false') getRedisClient().quit();
     *   process.exit(0);
     * });
     * ```
     */
    export function closeConnections(): Promise<void>;

    /**
     * Gets current connection pool statistics for monitoring and debugging.
     * Useful for detecting connection leaks or pool exhaustion.
     *
     * @returns Current pool statistics
     *
     * @example
     * ```typescript
     * const stats = getPoolStats();
     * console.log(`Active: ${stats.activeConnections}/${stats.totalConnections}`);
     * ```
     */
    export function getPoolStats(): PoolStats;

    // ==================== v2.6.0 SMART AUTO FEATURES ====================

    /**
     * Auto key generation configuration
     */
    export interface AutoKeyConfig {
        /** Enable auto key generation */
        enabled?: boolean;
    }

    /**
     * Auto invalidation configuration
     */
    export interface AutoInvalidationConfig {
        /** Enable auto invalidation */
        enabled?: boolean;
        /**
         * Table-specific invalidation patterns. A rule replaces the default `<table>_*` and
         * `<table>:*` patterns for its table; keep `<table>:*` when you use automatic keys.
         */
        tables?: Record<string, string | string[]>;
    }

    /**
     * All-in-one configuration interface
     */
    export interface CoreConfig {
        /** Auto key generation config */
        autoKey?: AutoKeyConfig;
        /** Auto invalidation config */
        autoInvalidation?: AutoInvalidationConfig;
    }

    /**
     * Options of configure(): like {@link CoreConfig}, and each feature also accepts a boolean.
     */
    export interface ConfigureOptions {
        /** Auto key generation config, or `true`/`false` */
        autoKey?: AutoKeyConfig | boolean;
        /** Auto invalidation config, or `true`/`false` */
        autoInvalidation?: AutoInvalidationConfig | boolean;
    }

    /**
     * Enables auto cache key generation feature.
     * When enabled, the cacheName parameter becomes optional in getCacheQuery() and
     * tx.getCacheQuery(), and (v2.9.1) may be omitted in getCacheQueryPagination() and
     * getCacheQueryWithTimeout(). Same as CORE_AUTO_FEATURES=true.
     *
     * **v2.9.1:** `enableAutoKey(false)` disables the feature (before 2.9.1 it enabled it). Queries
     * without a detectable table (`CALL`, `SELECT fn(?)`) get the key `query:<sqlhash>:<paramhash>`,
     * and BigInt parameters no longer throw.
     *
     * Keys are built from the table, the WHERE column names and a 32-bit parameter hash; the select
     * list, ORDER BY, LIMIT, literal values and joins are not part of them. Use explicit cache names
     * for queries that differ only in those, and for anything user-specific or sensitive.
     *
     * @param config - Auto key configuration, or `true`/`false`
     *
     * @example
     * ```typescript
     * enableAutoKey({ enabled: true });
     *
     * // Now cacheName is optional
     * const users = await getCacheQuery('SELECT * FROM users WHERE id = ?', [123]);
     * ```
     */
    export function enableAutoKey(config?: AutoKeyConfig | boolean): void;

    /**
     * Enables auto cache invalidation feature.
     * When enabled, writes without a resetCacheName (QuaryCache, tx.query and, since v2.9.1,
     * bulkInsert) clear the `<table>_*` and `<table>:*` keys of the table they write to. Same as
     * CORE_AUTO_INVALIDATION=true; CORE_AUTO_FEATURES does not enable it.
     *
     * **v2.9.1:** `enableAutoInvalidation(false)` disables the feature (before 2.9.1 it enabled it).
     *
     * @param config - Auto invalidation configuration, or `true`/`false`
     *
     * @example
     * ```typescript
     * enableAutoInvalidation({
     *     enabled: true,
     *     tables: {
     *         users: ['users:*', 'users_*', 'profiles_*'],
     *         orders: ['orders:*', 'orders_*']
     *     }
     * });
     *
     * // Now resetCacheName is optional
     * await QuaryCache('INSERT INTO users...', [data]);
     * // Auto-clears: users:*, users_*, profiles_*
     * ```
     */
    export function enableAutoInvalidation(config?: AutoInvalidationConfig | boolean): void;

    /**
     * All-in-one configuration helper for v2.6.0 features.
     * Each option is passed to enableAutoKey() / enableAutoInvalidation(); since v2.9.1 `false`
     * disables the feature (e.g. `configure({ autoKey: false })`).
     *
     * @param config - Configuration object
     *
     * @example
     * ```typescript
     * configure({
     *     autoKey: { enabled: true },
     *     autoInvalidation: {
     *         enabled: true,
     *         tables: {
     *             users: ['users:*', 'users_*', 'profiles_*']
     *         }
     *     }
     * });
     * ```
     */
    export function configure(config?: ConfigureOptions): void;

    // ==================== TRANSACTION SUPPORT (v2.6.0+) ====================

    /**
     * Transaction context object provided to transaction callback.
     * Contains methods to execute queries within the transaction.
     */
    export interface TransactionContext {
        /**
         * Executes a query within the transaction.
         * Cache invalidation is buffered and applied only on successful commit.
         *
         * @param sql - SQL query to execute
         * @param parameters - Query parameters (optional)
         * @param resetCacheName - Optional cache patterns to invalidate on commit
         * @returns Promise resolving to query result
         *
         * @example
         * ```typescript
         * await tx.query('INSERT INTO users (name) VALUES (?)', ['John']);
         * await tx.query('UPDATE orders SET user_id = ?', [123], 'orders_*');
         * ```
         */
        query<T = any>(
            sql: string,
            parameters?: any[],
            resetCacheName?: string | string[] | null
        ): Promise<T>;

        /**
         * Executes a cached read query within the transaction.
         * Note: Reads from cache first, so a cache hit doesn't reflect the transaction's own changes;
         * use query() for reads that decide a write (e.g. `SELECT ... FOR UPDATE`).
         *
         * **v2.9.1:** rows read on a cache miss are written to the cache only after the transaction
         * commits; nothing is cached from a rolled-back transaction (2.9.0 cached them immediately).
         *
         * @param sql - SQL query to execute
         * @param parameters - Query parameters (optional)
         * @param cacheName - Cache key (optional if auto-key enabled)
         * @returns Promise resolving to query results
         *
         * @example
         * ```typescript
         * const user = await tx.getCacheQuery('SELECT * FROM users WHERE id = ?', [123], 'user-123');
         * ```
         */
        getCacheQuery<T = any>(
            sql: string,
            parameters?: any[],
            cacheName?: string | null
        ): Promise<T[]>;

        /**
         * Gets the underlying MySQL connection object.
         * For advanced use cases requiring direct connection access.
         *
         * @returns MySQL connection object
         */
        getConnection(): any;
    }

    /**
     * Transaction options
     */
    export interface TransactionOptions {
        /** Database name to switch to for the transaction */
        database?: string | null;
    }

    /**
     * Executes queries within a database transaction.
     * Automatically commits on success or rolls back on error.
     * Cache invalidation is buffered and applied only on successful commit.
     *
     * @param callback - Function (usually async) that receives transaction context
     * @param options - Transaction options
     * @returns Promise resolving to callback return value
     * @throws Error if transaction fails or is rolled back
     *
     * @example
     * ```typescript
     * // Basic transaction
     * await withTransaction(async (tx) => {
     *     await tx.query('INSERT INTO users (name) VALUES (?)', ['John']);
     *     await tx.query('INSERT INTO orders (user_id) VALUES (?)', [123]);
     *     // Auto commit on success, auto rollback on error
     * });
     *
     * // With database switching
     * await withTransaction(async (tx) => {
     *     await tx.query('INSERT INTO logs...', [data]);
     * }, { database: 'analytics_db' });
     *
     * // With return value
     * const userId = await withTransaction(async (tx) => {
     *     const result = await tx.query('INSERT INTO users...', [data]);
     *     return result.insertId;
     * });
     *
     * // Error handling (automatic rollback)
     * try {
     *     await withTransaction(async (tx) => {
     *         await tx.query('INSERT INTO users...', [data]);
     *         throw new Error('Business logic error');
     *         // Transaction automatically rolled back
     *     });
     * } catch (error) {
     *     console.error('Transaction failed:', error);
     * }
     * ```
     */
    export function withTransaction<T = any>(
        callback: (tx: TransactionContext) => T | Promise<T>,
        options?: TransactionOptions
    ): Promise<T>;

    // ==================== BACKWARD COMPATIBILITY ====================

    /**
     * Default export for backward compatibility with v2.4.x.
     *
     * Since v2.9.1 the CommonJS module also has a non-enumerable `default` property, so
     * `import sqlcache from 'sqlcache'` works without `esModuleInterop`; with 2.9.0 and earlier it
     * needs `esModuleInterop` (or use `import sqlcache = require('sqlcache')`). Since v2.9.1 named
     * imports also work in native ESM; with 2.9.0 and earlier, native ESM code should use the
     * default import.
     *
     * @example
     * ```typescript
     * // v2.4.x style (still supported)
     * import dbConnector = require('sqlcache');
     * dbConnector.QuaryCache(...);
     *
     * // v2.5.0 style (recommended)
     * import { QuaryCache, getCacheQuery } from 'sqlcache';
     * QuaryCache(...);
     *
     * // Default import
     * import sqlcache from 'sqlcache';
     * sqlcache.getCacheQuery(...);
     * ```
     */
    const connector: {
        QuaryCache: typeof QuaryCache;
        getCacheQuery: typeof getCacheQuery;
        getCacheQueryPagination: typeof getCacheQueryPagination;
        bulkInsert: typeof bulkInsert;
        getCacheQueryWithTimeout: typeof getCacheQueryWithTimeout;
        closeConnections: typeof closeConnections;
        getPoolStats: typeof getPoolStats;
        withTransaction: typeof withTransaction;
        enableAutoKey: typeof enableAutoKey;
        enableAutoInvalidation: typeof enableAutoInvalidation;
        configure: typeof configure;
        getArrayItem: typeof getArrayItem;
        addArrayItem: typeof addArrayItem;
        delKeyItem: typeof delKeyItem;
        delPrefixKeyItem: typeof delPrefixKeyItem;
        isRedisConnected: typeof isRedisConnected;
        getRedisClient: typeof getRedisClient;
    };

    export default connector;
}
