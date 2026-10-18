/**
 * Auto Invalidation Module (v2.6.0)
 *
 * Automatically invalidates cache when write operations (INSERT/UPDATE/DELETE) occur.
 * Disabled by default for backward compatibility.
 */

let autoInvalidationEnabled = false;
let invalidationRules = {};

/**
 * Enables auto invalidation feature
 * @param {Object|boolean} config - Configuration options, or true/false to enable/disable
 * @param {boolean} config.enabled - Enable/disable auto invalidation
 * @param {Object} config.tables - Table-specific invalidation patterns
 */
function enableAutoInvalidation(config = {}) {
    autoInvalidationEnabled = typeof config === 'boolean' ? config : config.enabled !== false;
    invalidationRules = config.tables || {};
}

/**
 * Checks if auto invalidation is enabled
 */
function isAutoInvalidationEnabled() {
    return autoInvalidationEnabled || process.env.CORE_AUTO_INVALIDATION === 'true';
}

// Statement-anchored table patterns. They are tried first so that modifiers (INSERT IGNORE,
// UPDATE LOW_PRIORITY, ...) are understood and keywords inside the statement body
// (e.g. "ON DUPLICATE KEY UPDATE col = ...", or 'UPDATE' inside a string literal) are never
// mistaken for the target table. Each match stops after the table name, so large bulk
// INSERT strings are not scanned end to end.
const ANCHORED_TABLE_PATTERNS = [
    /^\s*(?:INSERT|REPLACE)\s+(?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE)\s+)*INTO\s+`?(\w+)`?/i,
    /^\s*UPDATE\s+(?:(?:LOW_PRIORITY|IGNORE)\s+)*`?(\w+)`?/i,
    /^\s*DELETE\s+(?:(?:LOW_PRIORITY|QUICK|IGNORE)\s+)*FROM\s+`?(\w+)`?/i
];

/**
 * Extracts table name from SQL query
 * @param {string} sql - SQL query
 * @returns {string|null} - Table name or null
 */
function extractTableName(sql) {
    for (const pattern of ANCHORED_TABLE_PATTERNS) {
        const anchoredMatch = sql.match(pattern);
        if (anchoredMatch) return anchoredMatch[1];
    }

    // INSERT INTO users...
    const insertMatch = sql.match(/INSERT\s+INTO\s+`?(\w+)`?/i);
    if (insertMatch) return insertMatch[1];

    // UPDATE users SET...
    const updateMatch = sql.match(/UPDATE\s+`?(\w+)`?/i);
    if (updateMatch) return updateMatch[1];

    // DELETE FROM users...
    const deleteMatch = sql.match(/DELETE\s+FROM\s+`?(\w+)`?/i);
    if (deleteMatch) return deleteMatch[1];

    // REPLACE INTO users...
    const replaceMatch = sql.match(/REPLACE\s+INTO\s+`?(\w+)`?/i);
    if (replaceMatch) return replaceMatch[1];

    return null;
}

/**
 * Checks if SQL is a write operation
 * @param {string} sql - SQL query
 * @returns {boolean}
 */
function isWriteOperation(sql) {
    return /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql.trim());
}

/**
 * Gets invalidation patterns for a table
 * @param {string} tableName - Table name
 * @returns {Array<string>} - Array of cache key patterns to invalidate
 */
function getInvalidationPatterns(tableName) {
    if (!tableName) return [];

    // User-defined rules take priority
    if (invalidationRules[tableName]) {
        const rules = invalidationRules[tableName];
        return Array.isArray(rules) ? rules : [rules];
    }

    // Default patterns: tableName_* and tableName:*
    return [`${tableName}_*`, `${tableName}:*`];
}

/**
 * Determines which cache patterns should be invalidated for a query
 * @param {string} sql - SQL query
 * @param {string|null} manualPattern - Manual invalidation pattern (takes priority)
 * @returns {Array<string>} - Array of patterns to invalidate
 */
function determineInvalidationPatterns(sql, manualPattern = null) {
    // Manual pattern takes priority
    if (manualPattern) {
        return Array.isArray(manualPattern) ? manualPattern : [manualPattern];
    }

    // Auto invalidation only if enabled
    if (!isAutoInvalidationEnabled()) {
        return [];
    }

    // Check if this is a write operation
    if (!isWriteOperation(sql)) {
        return [];
    }

    // Extract table name and get patterns
    const tableName = extractTableName(sql);
    return getInvalidationPatterns(tableName);
}

const GLOB_SPECIAL_CHARS = /[*?[\]\\]/;

/**
 * The pattern without its trailing '*' characters (a loop: /\*+$/ is quadratic on long runs of
 * '*' inside the pattern)
 */
function stripTrailingStars(pattern) {
    let end = pattern.length;
    while (end > 0 && pattern.charCodeAt(end - 1) === 42 /* '*' */) end--;
    return end === pattern.length ? pattern : pattern.slice(0, end);
}

/**
 * Reduces a list of prefix patterns to fewer Redis SCAN passes, without changing which keys
 * they match. Patterns are prefixes (delPrefixKeyItem appends '*'), so trailing '*' do not
 * matter. For patterns that are plain literals:
 * - a prefix already covered by a shorter one in the list is dropped ('users', 'users:1' -> 'users')
 * - prefixes that differ only in their last ASCII character are merged into one character
 *   class, e.g. the default auto-invalidation pair ['users_*', 'users:*'] -> ['users[_:]*']
 * Patterns containing other glob syntax are passed through unchanged.
 *
 * @param {Array<string>} patterns - Prefix patterns
 * @returns {Array<string>} - Equivalent, usually shorter, list of prefix patterns
 */
function mergeInvalidationPatterns(patterns) {
    const literals = [];
    for (const pattern of patterns) {
        if (typeof pattern !== 'string') continue;
        const literal = stripTrailingStars(pattern);
        if (literal && !GLOB_SPECIAL_CHARS.test(literal)) literals.push(literal);
    }

    const result = [];
    const groups = new Map();
    const seen = new Set();

    for (const pattern of patterns) {
        const literal = typeof pattern === 'string' ? stripTrailingStars(pattern) : null;
        if (!literal || GLOB_SPECIAL_CHARS.test(literal)) {
            result.push(pattern);
            continue;
        }
        if (seen.has(literal)) continue;
        seen.add(literal);
        if (literals.some(other => other.length < literal.length && literal.startsWith(other))) continue;

        const last = literal.slice(-1);
        const stem = literal.slice(0, -1);
        const group = stem && last.charCodeAt(0) < 128 ? groups.get(stem) : undefined;
        if (group) {
            group.chars.push(last);
        } else {
            if (stem && last.charCodeAt(0) < 128) {
                groups.set(stem, { index: result.length, chars: [last] });
            }
            result.push(pattern);
        }
    }

    for (const [stem, group] of groups) {
        if (group.chars.length > 1) {
            const charClass = group.chars.map(c => (c === '^' || c === '-' ? `\\${c}` : c)).join('');
            result[group.index] = `${stem}[${charClass}]*`;
        }
    }

    return result;
}

module.exports = {
    enableAutoInvalidation,
    isAutoInvalidationEnabled,
    extractTableName,
    isWriteOperation,
    getInvalidationPatterns,
    determineInvalidationPatterns,
    mergeInvalidationPatterns
};
