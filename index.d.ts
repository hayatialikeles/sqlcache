/**
 * Type definitions for node-caching-mysql-connector-with-redis
 * Project: https://github.com/hayatialikeles/NODE-CACHING-MYSQL-CONNECTOR-WITH-REDIS
 * Definitions by: Ali Hayati Keleş
 */

/// <reference types="node" />

declare module 'node-caching-mysql-connector-with-redis' {
    /**
     * MySQL query result type
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
     * Executes a SQL query and returns the result from the cache or the database.
     * If a resetCacheName is provided, it deletes the cache item before executing the query.
     *
     * @param sql - The SQL query to execute
     * @param parameters - The parameters to be passed to the SQL query
     * @param resetCacheName - The name of the cache item to reset (optional)
     * @param database - The database name to switch to (optional)
     * @returns A promise that resolves with the result of the query
     *
     * @example
     * ```typescript
     * const result = await QuaryCache(
     *   "INSERT INTO users SET name = ?, email = ?",
     *   ["John", "john@example.com"],
     *   "users-cache"
     * );
     * console.log(result.insertId);
     * ```
     */
    export function QuaryCache(
        sql: string,
        parameters: any[],
        resetCacheName?: string | null,
        database?: string | null
    ): Promise<QueryResult>;

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
     * @param sql - The SQL query to be executed
     * @param parameters - The parameters to be passed to the SQL query
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
        parameters: any[],
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
     * @param sql - The SQL query to execute
     * @param parameters - The parameters to be used in the SQL query
     * @param cacheName - The name of the cache to store the data
     * @param page - The page number of the data to retrieve (0-based)
     * @param pageSize - The number of records per page (default: 30)
     * @param database - The database name to switch to (optional)
     * @returns A promise that resolves to an object containing the paginated data
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
     *   "products-cat-5-page-0",
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
        cacheName: string,
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
     * With REDIS_ENABLED=false the first call opens the connection.
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
        /** Cache name prefix to reset after insert */
        resetCacheName?: string | null;
        /**
         * v2.9.0: insert all chunks in one transaction (all or nothing, and faster for large
         * inserts). Without it each chunk commits on its own, as before (default: false)
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
     * @param sql - The SQL query to execute
     * @param parameters - Query parameters
     * @param cacheName - Cache key for storing results
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
        parameters: any[],
        cacheName: string,
        options?: QueryTimeoutOptions
    ): Promise<T[]>;

    /**
     * Gracefully closes all database connections.
     * Should be called during application shutdown to prevent connection leaks.
     *
     * @example
     * ```typescript
     * process.on('SIGTERM', async () => {
     *   await closeConnections();
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
        /** Table-specific invalidation patterns */
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
     * Enables auto cache key generation feature.
     * When enabled, cacheName parameter becomes optional in getCacheQuery().
     *
     * @param config - Auto key configuration
     *
     * @example
     * ```typescript
     * enableAutoKey({ enabled: true });
     *
     * // Now cacheName is optional
     * const users = await getCacheQuery('SELECT * FROM users WHERE id = ?', [123]);
     * ```
     */
    export function enableAutoKey(config?: AutoKeyConfig): void;

    /**
     * Enables auto cache invalidation feature.
     * When enabled, cache will be automatically cleared on write operations.
     *
     * @param config - Auto invalidation configuration
     *
     * @example
     * ```typescript
     * enableAutoInvalidation({
     *     enabled: true,
     *     tables: {
     *         users: ['users_*', 'profiles_*'],
     *         orders: ['orders_*']
     *     }
     * });
     *
     * // Now resetCacheName is optional
     * await QuaryCache('INSERT INTO users...', [data]);
     * // Auto-clears: users_*, profiles_*
     * ```
     */
    export function enableAutoInvalidation(config?: AutoInvalidationConfig): void;

    /**
     * All-in-one configuration helper for v2.6.0 features.
     *
     * @param config - Core configuration object
     *
     * @example
     * ```typescript
     * configure({
     *     autoKey: { enabled: true },
     *     autoInvalidation: {
     *         enabled: true,
     *         tables: {
     *             users: ['users_*', 'profiles_*']
     *         }
     *     }
     * });
     * ```
     */
    export function configure(config?: CoreConfig): void;

    // ==================== TRANSACTION SUPPORT (v2.7.0+) ====================

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
         * @param parameters - Query parameters
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
            parameters: any[],
            resetCacheName?: string | string[] | null
        ): Promise<T>;

        /**
         * Executes a cached read query within the transaction.
         * Note: Reads from cache but doesn't guarantee transaction isolation.
         *
         * @param sql - SQL query to execute
         * @param parameters - Query parameters
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
            parameters: any[],
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
     * @param callback - Async function that receives transaction context
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
        callback: (tx: TransactionContext) => Promise<T>,
        options?: TransactionOptions
    ): Promise<T>;

    // ==================== BACKWARD COMPATIBILITY ====================

    /**
     * Default export for backward compatibility with v2.4.x
     *
     * @example
     * ```typescript
     * // v2.4.x style (still supported)
     * import dbConnector = require('node-caching-mysql-connector-with-redis');
     * dbConnector.QuaryCache(...);
     *
     * // v2.5.0 style (recommended)
     * import { QuaryCache, getCacheQuery } from 'node-caching-mysql-connector-with-redis';
     * QuaryCache(...);
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
