const dbConnector = require('./dbConnector');
const redisConnector = require('./redis.Connector');
const { enableAutoKey } = require('./core/autoKey');
const { enableAutoInvalidation } = require('./core/autoInvalidate');

// Exported below as shorthand properties, which lets Node detect every name for ES module
// named imports (import { getCacheQuery } from 'sqlcache')
const {
    QuaryCache,
    getCacheQuery,
    getCacheQueryPagination,
    bulkInsert,
    getCacheQueryWithTimeout,
    closeConnections,
    getPoolStats,
    withTransaction
} = dbConnector;
const {
    getArrayItem,
    addArrayItem,
    delKeyItem,
    delPrefixKeyItem,
    isRedisConnected,
    getRedisClient
} = redisConnector;

// All-in-one configuration helper
function configure(config = {}) {
    if (config.autoKey !== undefined) {
        enableAutoKey(config.autoKey);
    }
    if (config.autoInvalidation !== undefined) {
        enableAutoInvalidation(config.autoInvalidation);
    }
}

module.exports = {
    // Database functions
    QuaryCache,
    getCacheQuery,
    getCacheQueryPagination,

    // Production-grade features (v2.5.3+)
    bulkInsert,
    getCacheQueryWithTimeout,
    closeConnections,
    getPoolStats,

    // Transaction support (v2.7.0+)
    withTransaction,

    // Redis functions
    getArrayItem,
    addArrayItem,
    delKeyItem,
    delPrefixKeyItem,
    isRedisConnected,
    getRedisClient,

    // v2.6.0 Core Features (Opt-in)
    enableAutoKey,
    enableAutoInvalidation,

    // All-in-one configuration helper
    configure
};

// import sqlcache from 'sqlcache' and require('sqlcache').default give the same object
Object.defineProperty(module.exports, 'default', { value: module.exports, enumerable: false });
