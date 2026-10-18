const crypto = require('crypto');

/**
 * Auto Key Generation Module (v2.6.0)
 *
 * Automatically generates cache keys from SQL queries and parameters.
 * Disabled by default for backward compatibility.
 */

let autoKeyEnabled = false;

/**
 * Enables auto key generation feature
 * @param {Object} config - Configuration options
 */
function enableAutoKey(config = {}) {
    autoKeyEnabled = config.enabled !== false;
}

/**
 * Checks if auto key generation is enabled
 */
function isAutoKeyEnabled() {
    return autoKeyEnabled || process.env.CORE_AUTO_FEATURES === 'true';
}

/**
 * Creates a short hash from parameters
 * @param {Array} parameters - Query parameters
 * @returns {string} - 8-character hash
 */
function createParameterHash(parameters) {
    if (!parameters || parameters.length === 0) {
        return 'all';
    }

    return crypto
        .createHash('md5')
        .update(JSON.stringify(parameters))
        .digest('hex')
        .substring(0, 8);
}

/**
 * Extracts table name from SQL query
 * @param {string} sql - SQL query
 * @returns {string|null} - Table name or null
 */
function extractTableName(sql) {
    // SELECT FROM
    const selectMatch = sql.match(/FROM\s+`?(\w+)`?/i);
    if (selectMatch) return selectMatch[1];

    // INSERT INTO
    const insertMatch = sql.match(/INSERT\s+INTO\s+`?(\w+)`?/i);
    if (insertMatch) return insertMatch[1];

    // UPDATE
    const updateMatch = sql.match(/UPDATE\s+`?(\w+)`?/i);
    if (updateMatch) return updateMatch[1];

    // DELETE FROM
    const deleteMatch = sql.match(/DELETE\s+FROM\s+`?(\w+)`?/i);
    if (deleteMatch) return deleteMatch[1];

    return null;
}

/**
 * Extracts WHERE conditions from SQL
 * @param {string} sql - SQL query
 * @returns {Array<string>} - Array of conditions
 */
function extractWhereConditions(sql) {
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:ORDER\s+BY|LIMIT|GROUP\s+BY|HAVING|$)/is);

    if (!whereMatch) {
        return [];
    }

    const whereClause = whereMatch[1].trim();

    // Split by AND/OR but preserve the column names
    const conditions = whereClause.split(/\s+(AND|OR)\s+/i)
        .filter(part => !/^(AND|OR)$/i.test(part.trim()));

    return conditions.map(c => c.trim());
}

/**
 * Extracts column names from WHERE conditions
 * @param {Array<string>} conditions - WHERE conditions
 * @returns {Array<string>} - Sorted column names
 */
function extractColumnNames(conditions) {
    const columns = [];

    for (const condition of conditions) {
        // Match: column_name = ?
        // Match: column_name > ?
        // Match: column_name IN (?)
        // Match: column_name LIKE ?
        const columnMatch = condition.match(/(\w+)\s*(?:=|>|<|>=|<=|!=|<>|IN|LIKE|NOT\s+IN|NOT\s+LIKE)/i);

        if (columnMatch) {
            columns.push(columnMatch[1].toLowerCase());
        }
    }

    // Sort for stable key generation
    return columns.sort();
}

// SQL text is usually a constant template while parameters change per call, so everything
// derived from the SQL alone is memoized. Bounded: the oldest entry is evicted when full.
const SQL_ANALYSIS_CACHE_LIMIT = 1000;
const SQL_ANALYSIS_MAX_LENGTH = 10000;
const sqlAnalysisCache = new Map();

/**
 * Parses the SQL-only parts of a cache key (memoized)
 * @param {string} sql - SQL query
 * @returns {{tableName: string|null, hasConditions: boolean, columnPart: string, queryKey: string|null}}
 */
function analyzeSql(sql) {
    const cacheable = typeof sql === 'string' && sql.length <= SQL_ANALYSIS_MAX_LENGTH;
    if (cacheable) {
        const cached = sqlAnalysisCache.get(sql);
        if (cached) return cached;
    }

    const tableName = extractTableName(sql);
    let analysis;

    if (!tableName) {
        // Fallback for complex queries
        const queryHash = crypto
            .createHash('md5')
            .update(sql)
            .digest('hex')
            .substring(0, 8);
        analysis = { tableName, hasConditions: false, columnPart: '', queryKey: `query:${queryHash}` };
    } else {
        const conditions = extractWhereConditions(sql);
        const columns = conditions.length > 0 ? extractColumnNames(conditions) : [];
        analysis = { tableName, hasConditions: conditions.length > 0, columnPart: columns.join(':'), queryKey: null };
    }

    if (cacheable) {
        if (sqlAnalysisCache.size >= SQL_ANALYSIS_CACHE_LIMIT) {
            sqlAnalysisCache.delete(sqlAnalysisCache.keys().next().value);
        }
        sqlAnalysisCache.set(sql, analysis);
    }
    return analysis;
}

/**
 * Generates cache key with detailed column information
 * @param {string} sql - SQL query
 * @param {Array} parameters - Query parameters
 * @returns {string} - Generated cache key
 */
function generateDetailedKey(sql, parameters) {
    const { tableName, hasConditions, columnPart, queryKey } = analyzeSql(sql);

    if (!tableName) {
        return queryKey;
    }

    if (!hasConditions) {
        // No WHERE clause - generic cache key
        return `${tableName}:all`;
    }

    if (!columnPart) {
        // Complex WHERE clause without extractable columns
        const paramHash = createParameterHash(parameters);
        return `${tableName}:${paramHash}`;
    }

    // Build key with column names and parameter hash
    // Example: users:id:company_id:a7b3c2d1
    const paramHash = createParameterHash(parameters);

    return `${tableName}:${columnPart}:${paramHash}`;
}

/**
 * Generates cache key with simple parameter hash
 * @param {string} sql - SQL query
 * @param {Array} parameters - Query parameters
 * @returns {string} - Generated cache key
 */
function generateSimpleKey(sql, parameters) {
    const { tableName, queryKey } = analyzeSql(sql);

    if (!tableName) {
        return queryKey;
    }

    const paramHash = createParameterHash(parameters);
    return `${tableName}:${paramHash}`;
}

/**
 * Main function: Generates cache key from SQL and parameters
 *
 * Strategy:
 * - Simple queries (1-3 params): Detailed key with column names
 * - Complex queries (4+ params): Simple hash-based key
 *
 * @param {string} sql - SQL query
 * @param {Array} parameters - Query parameters
 * @param {Object} options - Options { strategy: 'detailed'|'simple' }
 * @returns {string} - Generated cache key
 */
function generateCacheKey(sql, parameters, options = {}) {
    const strategy = options.strategy || 'auto';

    if (strategy === 'simple') {
        return generateSimpleKey(sql, parameters);
    }

    if (strategy === 'detailed') {
        return generateDetailedKey(sql, parameters);
    }

    // Auto strategy: choose based on parameter count
    if (!parameters || parameters.length <= 3) {
        return generateDetailedKey(sql, parameters);
    }

    return generateSimpleKey(sql, parameters);
}

module.exports = {
    enableAutoKey,
    isAutoKeyEnabled,
    generateCacheKey,
    createParameterHash,
    extractTableName,
    extractWhereConditions,
    extractColumnNames,

    // For testing
    _generateDetailedKey: generateDetailedKey,
    _generateSimpleKey: generateSimpleKey
};
