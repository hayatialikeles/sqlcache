const crypto = require('crypto');
const db = require('mysql2/promise');
const { getArrayItem, addArrayItem, delPrefixKeyItem } = require('./redis.Connector');
const { generateCacheKey, isAutoKeyEnabled } = require('./core/autoKey');
const { determineInvalidationPatterns, mergeInvalidationPatterns } = require('./core/autoInvalidate');
require('dotenv').config();
const env = process.env;

// Check if Redis is enabled (default: true)
const REDIS_ENABLED = env.REDIS_ENABLED !== 'false';

/**
 * Validates required environment variables and provides helpful error messages
 * @throws {Error} If any required configuration is missing
 */
function validateConfiguration() {
    const errors = [];

    // Required configurations
    if (!env.DB_HOST) {
        errors.push('DB_HOST is required (e.g., DB_HOST=localhost)');
    }

    if (!env.DB_USERNAME) {
        errors.push('DB_USERNAME is required (e.g., DB_USERNAME=root)');
    }

    if (!env.DB_NAME) {
        errors.push('DB_NAME is required (e.g., DB_NAME=my_database)');
    }

    // Validate optional numeric values if provided
    if (env.DB_PORT && isNaN(parseInt(env.DB_PORT))) {
        errors.push('DB_PORT must be a valid number (e.g., DB_PORT=3306)');
    }

    if (env.DB_CONNECTION_LIMIT && isNaN(parseInt(env.DB_CONNECTION_LIMIT))) {
        errors.push('DB_CONNECTION_LIMIT must be a valid number (e.g., DB_CONNECTION_LIMIT=10)');
    }

    if (env.DB_QUEUE_LIMIT && isNaN(parseInt(env.DB_QUEUE_LIMIT))) {
        errors.push('DB_QUEUE_LIMIT must be a valid number (e.g., DB_QUEUE_LIMIT=0)');
    }

    if (env.DB_CONNECT_TIMEOUT && isNaN(parseInt(env.DB_CONNECT_TIMEOUT))) {
        errors.push('DB_CONNECT_TIMEOUT must be a valid number in milliseconds (e.g., DB_CONNECT_TIMEOUT=10000)');
    }

    // Validate Redis configuration if enabled
    if (REDIS_ENABLED) {
        if (!env.REDIS_SERVER) {
            errors.push('REDIS_SERVER is required when Redis is enabled (e.g., REDIS_SERVER=localhost). Set REDIS_ENABLED=false to disable Redis.');
        }

        if (env.REDIS_PORT && isNaN(parseInt(env.REDIS_PORT))) {
            errors.push('REDIS_PORT must be a valid number (e.g., REDIS_PORT=6379)');
        }
    }

    if (errors.length > 0) {
        const errorMessage = [
            '❌ Configuration Error - Missing or invalid environment variables:',
            '',
            ...errors.map(err => `  • ${err}`),
            '',
            '💡 Tip: Copy .env.example to .env and configure your settings:',
            '  cp .env.example .env',
            ''
        ].join('\n');

        throw new Error(errorMessage);
    }
}

// Validate configuration on module load
validateConfiguration();

// Connection pool configuration with auto-reconnection
// Optimized defaults for production use
const poolConfig = {
    host: env.DB_HOST,
    user: env.DB_USERNAME,
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME,
    connectionLimit: parseInt(env.DB_CONNECTION_LIMIT) || 151,       // High traffic default (adjust based on server capacity)
    queueLimit: parseInt(env.DB_QUEUE_LIMIT) || 0,                   // 0 = unlimited queue (wait when pool is full)
    maxIdle: parseInt(env.DB_MAX_IDLE) || 10,                        // Maximum idle connections (MySQL2 recommended)
    idleTimeout: parseInt(env.DB_IDLE_TIMEOUT) || 60000,             // Idle connection timeout in ms (60 seconds)
    connectTimeout: parseInt(env.DB_CONNECT_TIMEOUT) || 10000,       // 10 seconds timeout for initial connection
    multipleStatements: env.DB_MULTIPLE_STATEMENTS !== undefined     // Backward compatible: default true
        ? env.DB_MULTIPLE_STATEMENTS === 'true'
        : true,
    port: parseInt(env.DB_PORT) || 3306,
    timezone: env.TIMEZONE || '+00:00',
    waitForConnections: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
};

const con = db.createPool(poolConfig);

/**
 * Quotes a database name for a USE statement (backticks inside the name are doubled).
 */
function quoteIdentifier(name) {
    return '`' + String(name).replace(/`/g, '``') + '`';
}

// Database each pooled connection is on when it is not the pool's default one, or
// UNKNOWN_DATABASE after SQL that may have switched it. mysql2 does not reset session state on
// release(), so this keeps one caller's `database` from leaking to the next caller, and lets
// repeated calls for the same database skip the USE round trip. Keyed by the underlying
// connection, which outlives each checkout; new connections start on the default database.
const UNKNOWN_DATABASE = Symbol('unknown database');
const connectionDatabases = new WeakMap();

function connectionKey(connection) {
    return connection.connection || connection;
}

/**
 * Puts a pooled connection on `database`, or on the pool's default database when no
 * `database` is given. Sends USE only when the connection is not already there.
 */
async function selectDatabase(connection, database) {
    const key = connectionKey(connection);
    const target = database || poolConfig.database;
    const current = connectionDatabases.has(key) ? connectionDatabases.get(key) : poolConfig.database;
    if (current === target) return;

    await connection.query(`USE ${quoteIdentifier(target)}`);
    if (target === poolConfig.database) {
        connectionDatabases.delete(key);
    } else {
        connectionDatabases.set(key, target);
    }
}

// SQL that may switch the default database by itself (a USE statement, possibly inside a
// multi-statement query). Matching is deliberately broad: a false positive only costs one USE.
const MAY_SWITCH_DATABASE = /\buse\b/i;

/**
 * Called before running caller-supplied SQL: if it could change the connection's database,
 * forget what database the connection is on, so the next checkout selects it explicitly.
 */
function trackCallerSql(connection, sql) {
    const text = typeof sql === 'string' ? sql : sql && sql.sql;
    if (typeof text !== 'string' || MAY_SWITCH_DATABASE.test(text)) {
        connectionDatabases.set(connectionKey(connection), UNKNOWN_DATABASE);
    }
}

/**
 * Runs one query on a pooled connection and releases it immediately, so a MySQL connection
 * is never held while the caller waits on Redis (cache writes, SCAN-based invalidation).
 * A slow or unreachable Redis would otherwise keep connections busy and exhaust the pool.
 */
async function runQuery(database, sql, parameters, attempt = null) {
    if (attempt && attempt.timedOut) return undefined;
    const connection = await con.getConnection();
    try {
        // The caller already got its timeout while this call waited for a connection:
        // running the query now would only add load (typically to a saturated pool)
        if (attempt && attempt.timedOut) return undefined;
        await selectDatabase(connection, database);
        trackCallerSql(connection, sql);
        if (attempt) attempt.connection = connection;
        const [data] = await connection.query(sql, parameters);
        return data;
    } finally {
        if (attempt) attempt.connection = null;
        connection.release();
    }
}

/**
 * Stops the statement running on a pooled connection (KILL QUERY). Uses its own short-lived
 * connection, because the pool may be exhausted exactly when queries time out.
 */
async function killRunningQuery(connection) {
    const threadId = connection && connection.threadId;
    if (!threadId) return;
    let killer;
    try {
        killer = await db.createConnection({
            host: poolConfig.host,
            port: poolConfig.port,
            user: poolConfig.user,
            password: poolConfig.password,
            connectTimeout: poolConfig.connectTimeout
        });
        await killer.query('KILL QUERY ?', [threadId]);
    } catch (err) {
        console.error('Could not cancel timed-out query:', err.message);
    } finally {
        if (killer) killer.end().catch(() => {});
    }
}

/**
 * Deletes cached keys for the given prefix patterns. Patterns that can share a SCAN pass
 * (such as the default auto-invalidation pair 'table_*' and 'table:*') are merged first.
 */
function invalidate(patterns) {
    return Promise.all(mergeInvalidationPatterns(patterns).map(pattern => delPrefixKeyItem(pattern)));
}

/**
 * Auto-generated cache key. The same SQL returns different rows in different databases
 * (e.g. one database per tenant), so a call with `database` gets its own key; the suffix keeps
 * the 'table:' prefix that auto-invalidation patterns match. Keys without `database` are unchanged.
 */
function autoCacheKey(sql, parameters, database) {
    const key = generateCacheKey(sql, parameters);
    return database ? `${key}@${database}` : key;
}

/**
 * Identifies one paginated query (database, SQL and parameters) for DB_PAGINATION_REUSE_TOTAL.
 */
function paginationTotalHash(database, sql, parameters) {
    let params;
    try {
        params = JSON.stringify(parameters === undefined ? null : parameters);
    } catch (_) {
        params = String(parameters);
    }
    return crypto.createHash('md5').update(`${database || ''}\u0000${sql}\u0000${params}`).digest('hex').substring(0, 16);
}

// ── Request coalescing ──────────────────────────────────────────
// Concurrent cache misses for the same cache key, database, SQL and parameters share one
// database query (and one cache write) instead of each running it. Every caller still gets
// its own copy of the result, with the same types a query of its own would have returned.
const COALESCING = env.DB_COALESCE_QUERIES !== 'false';
// Opt-in: reuse a page's COUNT(*) total for the other pages of the same query (until the cache
// name is invalidated), instead of counting again on every page miss
const REUSE_PAGINATION_TOTAL = env.DB_PAGINATION_REUSE_TOTAL === 'true';
const inflightLoads = new Map();

// Only single, plain SELECT statements are shared; anything that might write runs per caller
const PLAIN_SELECT = /^\s*\(?\s*SELECT\b/i;

function isPlainRead(sql) {
    if (typeof sql !== 'string') return false;
    const body = sql.replace(/[\s;]+$/, '');
    return PLAIN_SELECT.test(body) && body.indexOf(';') === -1;
}

/**
 * Called after any statement that may have written: reads started from now on must not join
 * a load that began before the write (so a caller always sees its own writes).
 */
function forgetInflightReads() {
    inflightLoads.clear();
}

/**
 * Builds the coalescing key, or null when the call must not be coalesced.
 * Dates and Buffers are tagged so that, e.g., a Date and its ISO string never share a key.
 */
function coalescingKey(cacheKey, database, sql, parameters) {
    if (!COALESCING || !isPlainRead(sql)) return null;
    try {
        const params = JSON.stringify(parameters === undefined ? null : parameters, function (name, value) {
            const raw = this[name];
            if (raw instanceof Date) return { $date: raw.getTime() };
            if (Buffer.isBuffer(raw)) return { $buffer: raw.toString('base64') };
            return value;
        });
        return `${cacheKey}\u0000${database || ''}\u0000${sql}\u0000${params}`;
    } catch (_) {
        return null; // e.g. BigInt or circular parameters
    }
}

/**
 * Deep copy that keeps what mysql2 returns: plain objects/arrays, Date and Buffer values,
 * and prototypes (e.g. ResultSetHeader).
 */
function cloneResult(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(cloneResult);
    if (value instanceof Date) return new Date(value.getTime());
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    const copy = Object.create(Object.getPrototypeOf(value));
    for (const key of Object.keys(value)) {
        copy[key] = cloneResult(value[key]);
    }
    return copy;
}

/**
 * Runs `load` once per key at a time. Callers that arrive while it runs wait for it and get
 * their own copy; if it fails they run `load` themselves, exactly as they would have before.
 */
async function loadOnce(key, load) {
    if (key === null) return load();

    const inflight = inflightLoads.get(key);
    if (inflight) {
        let shared;
        try {
            shared = await inflight;
        } catch (_) {
            return load();
        }
        return cloneResult(shared);
    }

    const pending = load();
    inflightLoads.set(key, pending);
    try {
        return await pending;
    } finally {
        if (inflightLoads.get(key) === pending) inflightLoads.delete(key);
    }
}

// Errors MySQL raises because of the COUNT(*) wrapper itself (the same SQL just ran as the page
// query): duplicate column names in a derived table, statement options or INTO that are not
// allowed in a subquery, ... Such SQL is counted the legacy way from then on. Any other error
// (KILL QUERY, max_execution_time, lock waits, ...) is raised as is.
const WRAPPER_ERRORS = new Set([
    'ER_DUP_FIELDNAME', 'ER_PARSE_ERROR', 'ER_CANT_USE_OPTION_HERE', 'ER_MISPLACED_INTO',
    'ER_WRONG_USAGE', 'ER_NOT_SUPPORTED_YET'
]);
const UNCOUNTABLE_SQL_LIMIT = 500;
const uncountableSql = new Set();

// A MAX_EXECUTION_TIME optimizer hint only applies to a top-level SELECT, so it is copied onto
// the COUNT query to keep the caller's time limit
const MAX_EXECUTION_TIME_HINT = /^\s*\(?\s*SELECT\s*\/\*\+(?:(?!\*\/)[\s\S])*?\bMAX_EXECUTION_TIME\s*\(\s*(\d+)\s*\)/i;

function countSql(cleanSql) {
    const hint = cleanSql.match(MAX_EXECUTION_TIME_HINT);
    const hintComment = hint ? `/*+ MAX_EXECUTION_TIME(${hint[1]}) */ ` : '';
    return `SELECT ${hintComment}COUNT(*) AS total FROM (\n${cleanSql}\n) AS _pagination_count`;
}

/**
 * Total row count for pagination. Counts with SELECT COUNT(*) over the query as a derived
 * table, so a single number crosses the wire instead of every row of the result. When MySQL
 * cannot wrap the query (duplicate column names, non-SELECT statements, ...) it falls back to
 * fetching the full result and counting it, exactly as earlier versions always did.
 */
async function countRows(connection, cleanSql, parameters) {
    if (!uncountableSql.has(cleanSql)) {
        try {
            const [rows] = await connection.query(countSql(cleanSql), parameters);
            return Number(rows[0].total);
        } catch (err) {
            if (!WRAPPER_ERRORS.has(err.code)) throw err;
            if (uncountableSql.size >= UNCOUNTABLE_SQL_LIMIT) {
                uncountableSql.delete(uncountableSql.values().next().value);
            }
            uncountableSql.add(cleanSql);
        }
    }

    const [allData] = await connection.query(cleanSql, parameters);
    return allData.length;
}

function stopIdleReaper() {
    if (con.pool && con.pool._removeIdleTimeoutConnectionsTimer) {
        clearTimeout(con.pool._removeIdleTimeoutConnectionsTimer);
    }
}

// Graceful shutdown flag
let isShuttingDown = false;

// Retry helper function with optional database switching and timeout protection
// Fixed: Properly cleanup timeout promises to prevent memory leaks
async function executeWithRetry(fn, retries = 3, delay = 1000, database = null, timeout = null, onTimeout = null) {
    for (let i = 0; i < retries; i++) {
        try {
            if (isShuttingDown) {
                throw new Error('Server is shutting down, cannot process new queries');
            }

            if (timeout) {
                let timeoutHandle;
                const timeoutPromise = new Promise((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        if (onTimeout) onTimeout();
                        reject(new Error('Query timeout exceeded'));
                    }, timeout);
                });

                try {
                    const result = await Promise.race([fn(database), timeoutPromise]);
                    clearTimeout(timeoutHandle);  // Clean up timeout on success
                    return result;
                } catch (error) {
                    clearTimeout(timeoutHandle);  // Clean up timeout on error
                    throw error;
                }
            }

            return await fn(database);
        } catch (error) {
            if (i === retries - 1) throw error;

            // Retry only on connection errors
            if (error.code === 'ECONNREFUSED' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'ENOTFOUND' ||
                error.code === 'PROTOCOL_CONNECTION_LOST' ||
                error.code === 'ER_CON_COUNT_ERROR') {
                // Exponential backoff plus up to 20% jitter, so callers that failed together
                // (e.g. a MySQL restart) do not all retry in the same instant
                const backoff = delay * Math.pow(2, i);
                await new Promise(resolve => setTimeout(resolve, backoff + Math.floor(Math.random() * backoff * 0.2)));
            } else {
                throw error;
            }
        }
    }
}

module.exports = {
    /**
     * Executes a SQL query and returns the result from the cache or the database.
     * If a resetCacheName is provided, it deletes the cache item before executing the query.
     *
     * v2.6.0: resetCacheName is now optional. If not provided and CORE_AUTO_INVALIDATION=true,
     * cache will be auto-invalidated based on the affected table.
     *
     * @param {string} sql - The SQL query to execute.
     * @param {Array} parameters - The parameters to be passed to the SQL query.
     * @param {string|null} resetCacheName - The name of the cache item to reset (optional).
     * @param {string|null} database - The database name to switch to (optional).
     * @returns {Promise<any>} - A promise that resolves with the result of the query.
     * @throws {Error} - If an error occurs during the query execution.
     */
    async QuaryCache(sql, parameters, resetCacheName = null, database = null) {
        return executeWithRetry(async (db) => {
            const data = await runQuery(db, sql, parameters);
            if (!isPlainRead(sql)) forgetInflightReads();

            // Determine which cache patterns to invalidate
            if (REDIS_ENABLED) {
                const patterns = determineInvalidationPatterns(sql, resetCacheName);

                if (patterns.length > 0) {
                    await invalidate(patterns);
                }
            }

            return data;
        }, 3, 1000, database);
    },
    /**
     * Retrieves data from cache or database based on the provided SQL query and parameters.
     * If the data is found in the cache, it is returned. Otherwise, the data is fetched from the database,
     * stored in the cache, and then returned.
     *
     * v2.6.0: cacheName is now optional. If not provided and CORE_AUTO_FEATURES=true,
     * a cache key will be auto-generated from the SQL query and parameters.
     *
     * @param {string} sql - The SQL query to be executed.
     * @param {Array} parameters - The parameters to be passed to the SQL query.
     * @param {string|null} cacheName - The name of the cache to store the data (optional if auto-key enabled).
     * @param {string|null} database - The database name to switch to (optional).
     * @returns {Promise<Array>} - A promise that resolves to the retrieved data.
     * @throws {Error} - If there is an error while retrieving the data.
     */
    async getCacheQuery(sql, parameters, cacheName = null, database = null) {
        // Auto-generate cache key if not provided and feature is enabled
        let finalCacheName = cacheName;

        if (!finalCacheName) {
            if (isAutoKeyEnabled()) {
                finalCacheName = autoCacheKey(sql, parameters, database);
            } else {
                throw new Error(
                    'cacheName is required. To enable auto key generation, set CORE_AUTO_FEATURES=true in .env'
                );
            }
        }

        return executeWithRetry(async (db) => {
            if (REDIS_ENABLED) {
                const cachedData = await getArrayItem(finalCacheName);
                if (cachedData.length > 0) {
                    return cachedData;
                }
            }

            return loadOnce(coalescingKey(finalCacheName, db, sql, parameters), async () => {
                const data = await runQuery(db, sql, parameters);

                if (REDIS_ENABLED) {
                    await addArrayItem(finalCacheName, data);
                }

                return data;
            });
        }, 3, 1000, database);
    },

    /**
     * Retrieves paginated data from cache or database based on the provided SQL query and parameters.
     * If the data is available in cache, it is returned directly. Otherwise, the data is fetched from the database,
     * paginated, and then stored in the cache for future use.
     *
     * Uses server-side pagination (SQL LIMIT) for better performance.
     * The total count is computed with SELECT COUNT(*) over the query instead of fetching every row.
     * Handles semicolons at the end of SQL queries properly.
     *
     * @param {string} sql - The SQL query to execute.
     * @param {Array} parameters - The parameters to be used in the SQL query.
     * @param {string} cacheName - The name of the cache to store the data.
     * @param {number} page - The page number of the data to retrieve.
     * @param {number} [pageSize=30] - The number of records per page. Defaults to 30 if not provided.
     * @param {string|null} database - The database name to switch to (optional).
     * @returns {Promise<Object>} - A promise that resolves to an object containing the paginated data.
     * @throws {Error} - If an error occurs during the execution of the function.
     */
    async getCacheQueryPagination(sql, parameters, cacheName, page, pageSize = 30, database = null) {
        return executeWithRetry(async (db) => {
            // Validate and normalize pageSize parameter
            let validPageSize = parseInt(pageSize);
            if (isNaN(validPageSize) || validPageSize <= 0) {
                throw new Error('Page size must be greater than 0');
            }

            // Validate and normalize page parameter
            let validPage = parseInt(page);
            if (isNaN(validPage) || validPage < 0) {
                validPage = 0;
            }

            // Create unique cache key including page and pageSize
            const uniqueCacheKey = `${cacheName}:page${validPage}:size${validPageSize}`;

            if (REDIS_ENABLED) {
                const cachedData = await getArrayItem(uniqueCacheKey);
                if (typeof cachedData === 'object' && !Array.isArray(cachedData) && cachedData !== null) {
                    return cachedData;
                }
            }

            // Prepare SQL: remove trailing semicolon(s) and whitespace
            const cleanSql = sql.trim().replace(/;+\s*$/, '');

            // Calculate offset for pagination
            const offset = validPage * validPageSize;

            return loadOnce(coalescingKey(uniqueCacheKey, db, cleanSql, parameters), async () => {
                // DB_PAGINATION_REUSE_TOTAL: total stored under the cache name, so invalidating
                // the cache name clears it together with the pages
                const totalKey = REDIS_ENABLED && REUSE_PAGINATION_TOTAL
                    ? `${cacheName}:total:${paginationTotalHash(db, cleanSql, parameters)}`
                    : null;
                let storedTotal = null;
                if (totalKey) {
                    const stored = await getArrayItem(totalKey);
                    if (Array.isArray(stored) && stored.length === 1 && Number.isInteger(stored[0])) {
                        storedTotal = stored[0];
                    }
                }

                let totalCount;
                let data;
                const connection = await con.getConnection();
                try {
                    await selectDatabase(connection, db);
                    trackCallerSql(connection, cleanSql);

                    // Get paginated data with parameterized LIMIT to prevent SQL injection
                    const paginatedSql = `${cleanSql} LIMIT ?, ?`;
                    [data] = await connection.query(paginatedSql, [...parameters, offset, validPageSize]);

                    // A short page is the last one, so it already gives the exact total and the
                    // COUNT query can be skipped (small result sets need a single query)
                    if (Array.isArray(data) && data.length < validPageSize && (data.length > 0 || offset === 0)) {
                        totalCount = offset + data.length;
                    } else if (storedTotal !== null && data.length > 0 && storedTotal >= offset + data.length) {
                        totalCount = storedTotal;
                    } else {
                        totalCount = await countRows(connection, cleanSql, parameters);
                    }
                } finally {
                    connection.release();
                }

                // Prepare result
                const result = {
                    totalCount,
                    pageCount: Math.ceil(totalCount / validPageSize),
                    detail: data
                };

                if (REDIS_ENABLED) {
                    await addArrayItem(uniqueCacheKey, result);
                    if (totalKey && totalCount !== storedTotal) {
                        await addArrayItem(totalKey, [totalCount]);
                    }
                }

                return result;
            });
        }, 3, 1000, database);
    },

    /**
     * Executes a bulk insert operation with chunking for large datasets.
     * Automatically splits large datasets into chunks to prevent memory issues.
     * If a connection error interrupts the insert, the retry resumes at the first chunk that
     * was not acknowledged instead of inserting the already committed chunks again.
     * With `transaction: true` all chunks are committed together (all or nothing), which is also
     * faster for large inserts; a retry then starts over, as the failed attempt was rolled back.
     *
     * @param {string} table - The table name to insert into.
     * @param {Array} records - Array of objects with column-value pairs.
     * @param {Object} options - Optional settings: { database, chunkSize, resetCacheName, transaction }
     * @returns {Promise<Object>} - A promise that resolves with insert statistics.
     * @throws {Error} - If an error occurs during the bulk insert.
     */
    async bulkInsert(table, records, options = {}) {
        const { database = null, chunkSize = 1000, resetCacheName = null, transaction = false } = options;

        if (!records || records.length === 0) {
            return { insertedRows: 0, chunks: 0 };
        }

        const columns = Object.keys(records[0]);
        const rowPlaceholder = `(${columns.map(() => '?').join(',')})`;
        const insertPrefix = `INSERT INTO ${table} (${columns.join(',')}) VALUES `;

        // Progress survives retries: only chunks whose INSERT was acknowledged are skipped
        let nextIndex = 0;
        let totalInserted = 0;
        let chunks = 0;

        await executeWithRetry(async (db) => {
            const connection = await con.getConnection();
            try {
                await selectDatabase(connection, db);
                trackCallerSql(connection, insertPrefix);
                if (transaction) {
                    nextIndex = 0;
                    totalInserted = 0;
                    chunks = 0;
                    await connection.beginTransaction();
                }

                // Process in chunks
                for (; nextIndex < records.length; nextIndex += chunkSize) {
                    const chunk = records.slice(nextIndex, nextIndex + chunkSize);
                    const flatValues = [];
                    for (const record of chunk) {
                        for (const col of columns) {
                            flatValues.push(record[col]);
                        }
                    }

                    const sql = insertPrefix + chunk.map(() => rowPlaceholder).join(',');

                    const [result] = await connection.query(sql, flatValues);
                    totalInserted += result.affectedRows;
                    chunks++;
                }

                if (transaction) await connection.commit();
            } catch (err) {
                if (transaction) {
                    try {
                        await connection.rollback();
                    } catch (_) {
                        // the connection is gone; the server rolls the transaction back itself
                    }
                }
                throw err;
            } finally {
                connection.release();
            }
        }, 3, 1000, database);
        forgetInflightReads();

        if (resetCacheName && REDIS_ENABLED) {
            await delPrefixKeyItem(resetCacheName);
        }

        return { insertedRows: totalInserted, chunks };
    },

    /**
     * Executes a query with timeout protection.
     * Prevents long-running queries from blocking the application.
     *
     * @param {string} sql - The SQL query to execute.
     * @param {Array} parameters - The parameters to be passed to the SQL query.
     * @param {string} cacheName - The name of the cache.
     * @param {Object} options - Optional settings: { timeout, database }
     * @returns {Promise<any>} - A promise that resolves with the result of the query.
     * @throws {Error} - If timeout is exceeded or query fails.
     */
    async getCacheQueryWithTimeout(sql, parameters, cacheName, options = {}) {
        const { timeout = 30000, database = null, cancelOnTimeout = false } = options;
        let attempt = null;
        const onTimeout = () => {
            attempt.timedOut = true;
            if (cancelOnTimeout && attempt.connection) {
                killRunningQuery(attempt.connection);
            }
        };
        return executeWithRetry(async (db) => {
            attempt = { timedOut: false, connection: null };
            const current = attempt;

            if (REDIS_ENABLED) {
                const cachedData = await getArrayItem(cacheName);
                if (cachedData.length > 0) {
                    return cachedData;
                }
            }

            const data = await runQuery(db, sql, parameters, current);

            // A query skipped after the timeout has nothing to cache; a cancelled one either
            if (REDIS_ENABLED && data !== undefined && !(current.timedOut && cancelOnTimeout)) {
                await addArrayItem(cacheName, data);
            }

            return data;
        }, 3, 1000, database, timeout, onTimeout);
    },

    /**
     * Gracefully closes all database connections.
     * Should be called during application shutdown to prevent connection leaks.
     *
     * @returns {Promise<void>}
     */
    async closeConnections() {
        isShuttingDown = true;
        console.log('Closing database connections gracefully...');
        // mysql2 3.3.x keeps re-arming its idle-connection reaper after end(): the timer keeps
        // the process alive, and once closed connections pass idleTimeout it spins in a
        // synchronous loop (they are never removed from the free list), even while end() is
        // still waiting for running statements. So it is stopped before end() as well as after.
        stopIdleReaper();
        await con.end();
        stopIdleReaper();
        console.log('Database pool closed');
    },

    /**
     * Gets current pool statistics for monitoring.
     *
     * @returns {Object} - Pool statistics including active connections.
     */
    getPoolStats() {
        return {
            totalConnections: con.pool._allConnections.length,
            activeConnections: con.pool._allConnections.length - con.pool._freeConnections.length,
            freeConnections: con.pool._freeConnections.length,
            queuedRequests: con.pool._connectionQueue.length
        };
    },

    /**
     * Executes queries within a database transaction.
     * Automatically commits on success or rolls back on error.
     * Cache invalidation is buffered and applied only on successful commit.
     *
     * @param {Function} callback - Async function that receives transaction context (tx)
     * @param {Object} options - Transaction options
     * @param {string|null} options.database - Database to switch to (optional)
     * @returns {Promise<any>} - Result of the callback function
     * @throws {Error} - If transaction fails or is rolled back
     *
     * @example
     * await withTransaction(async (tx) => {
     *     await tx.query('INSERT INTO users...', [data]);
     *     await tx.query('UPDATE orders...', [data]);
     *     // Auto commit on success, auto rollback on error
     * });
     */
    async withTransaction(callback, options = {}) {
        const { database = null } = options;
        let connection;
        let result;
        const invalidationBuffer = []; // Buffer cache patterns for commit

        try {
            if (isShuttingDown) {
                throw new Error('Server is shutting down, cannot process new transactions');
            }

            connection = await con.getConnection();

            // Switch database if specified (or back to the default one)
            await selectDatabase(connection, database);

            // Begin transaction
            await connection.beginTransaction();

            // Create transaction context
            const tx = {
                /**
                 * Execute a query within the transaction
                 * @param {string} sql - SQL query
                 * @param {Array} parameters - Query parameters
                 * @param {string|string[]|null} resetCacheName - Cache patterns to invalidate on commit
                 * @returns {Promise<any>} - Query result
                 */
                query: async (sql, parameters, resetCacheName = null) => {
                    trackCallerSql(connection, sql);
                    const [data] = await connection.query(sql, parameters);

                    // Buffer cache invalidation patterns
                    if (REDIS_ENABLED) {
                        const patterns = determineInvalidationPatterns(sql, resetCacheName);
                        if (patterns.length > 0) {
                            invalidationBuffer.push(...patterns);
                        }
                    }

                    return data;
                },

                /**
                 * Execute a cached read query within the transaction
                 * Note: Reads from cache, but doesn't guarantee transaction isolation
                 * @param {string} sql - SQL query
                 * @param {Array} parameters - Query parameters
                 * @param {string|null} cacheName - Cache key (optional if auto-key enabled)
                 * @returns {Promise<any>} - Query result
                 */
                getCacheQuery: async (sql, parameters, cacheName = null) => {
                    // Auto-generate cache key if needed
                    let finalCacheName = cacheName;
                    if (!finalCacheName) {
                        if (isAutoKeyEnabled()) {
                            finalCacheName = autoCacheKey(sql, parameters, database);
                        } else {
                            throw new Error(
                                'cacheName is required in transaction. To enable auto key generation, set CORE_AUTO_FEATURES=true'
                            );
                        }
                    }

                    // Check cache first
                    if (REDIS_ENABLED) {
                        const cachedData = await getArrayItem(finalCacheName);
                        if (cachedData.length > 0) {
                            return cachedData;
                        }
                    }

                    // Execute in transaction and cache result
                    trackCallerSql(connection, sql);
                    const [data] = await connection.query(sql, parameters);
                    if (REDIS_ENABLED) {
                        await addArrayItem(finalCacheName, data);
                    }

                    return data;
                },

                /**
                 * Get the underlying connection object
                 * For advanced use cases that need direct connection access
                 * @returns {Object} - MySQL connection object
                 */
                getConnection: () => {
                    // Anything may run on the raw connection, including USE
                    connectionDatabases.set(connectionKey(connection), UNKNOWN_DATABASE);
                    return connection;
                }
            };

            // Execute user callback
            result = await callback(tx);

            // Commit transaction
            await connection.commit();
            forgetInflightReads();
        } catch (error) {
            // Rollback on error
            if (connection) {
                try {
                    await connection.rollback();
                } catch (rollbackError) {
                    console.error('Rollback error:', rollbackError);
                }
            }
            throw error;
        } finally {
            if (connection) {
                connection.release();
            }
        }

        // Apply buffered cache invalidations on successful commit, after the connection is
        // back in the pool (a SCAN-based invalidation can take a while on large keyspaces)
        if (REDIS_ENABLED && invalidationBuffer.length > 0) {
            // Remove duplicates
            const uniquePatterns = [...new Set(invalidationBuffer)];
            await invalidate(uniquePatterns);
        }

        return result;
    }
};
