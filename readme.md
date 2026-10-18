# MySQL Redis Cache Connector

[![npm](https://img.shields.io/npm/v/node-caching-mysql-connector-with-redis.svg)](https://www.npmjs.com/package/node-caching-mysql-connector-with-redis)

MySQL + Redis caching with production-grade resilience. Zero config.

## Install

```bash
npm install node-caching-mysql-connector-with-redis
```

## Setup

```bash
# .env
DB_HOST=localhost
DB_USERNAME=root
DB_PASSWORD=secret
DB_NAME=mydb
REDIS_SERVER=localhost
REDIS_PORT=6379
CORE_AUTO_FEATURES=true
```

## Usage

```javascript
const { getCacheQuery, QuaryCache, withTransaction, isRedisConnected } = require('node-caching-mysql-connector-with-redis');

// Read (auto-cached)
const users = await getCacheQuery('SELECT * FROM users WHERE id = ?', [123]);

// Write (auto cache invalidation)
await QuaryCache('INSERT INTO users (name) VALUES (?)', ['Ali']);

// Transaction (auto commit/rollback)
await withTransaction(async (tx) => {
    await tx.query('INSERT INTO orders...', [data]);
    await tx.query('UPDATE products...', [data]);
});

// Health check
app.get('/health', (req, res) => {
    res.json({ redis: isRedisConnected() });
});
```

## API

| Function | Description |
|----------|-------------|
| `getCacheQuery(sql, params)` | Cached read |
| `QuaryCache(sql, params)` | Write + invalidate cache |
| `withTransaction(fn)` | Auto commit/rollback |
| `getCacheQueryPagination(sql, params, key, page, size)` | Paginated query |
| `bulkInsert(table, records, options)` | Bulk insert |
| `getCacheQueryWithTimeout(sql, params, key, options)` | Query with timeout protection |
| `isRedisConnected()` | Redis health check |
| `getPoolStats()` | MySQL pool statistics |
| `closeConnections()` | Graceful shutdown |

## Resilience

The package is designed for production environments where failures are expected:

**Redis**
- Unlimited reconnection with exponential backoff + jitter
- Graceful degradation — reads return `[]`, writes return data without caching
- Fail-fast during long outages: after `REDIS_WAIT_TIMEOUT`, cache reads/writes stop waiting
- Per-command timeout for cache reads/writes, so a hung connection cannot hang requests
- Invalidations missed during an outage are replayed when Redis is back
- No crashes, no unhandled errors during Redis outages
- `SCAN` instead of `KEYS` (cluster-safe), with deletes streamed while scanning

**MySQL**
- Connection pool with auto-reconnection (mysql2)
- Connections are returned to the pool before any Redis I/O (outside transactions)
- Concurrent cache misses for the same query share one database query
- `USE db` only when a pooled connection is on another database (no leaking between callers)
- Retry with exponential backoff + jitter on connection errors
- Transaction atomicity preserved during crashes (auto-rollback)
- Query timeout protection
- Pagination counts with `COUNT(*)` instead of fetching every row

**Tested against 18 chaos scenarios** including: Redis/MySQL kill during operations, rapid flapping, 30s outages, network partitions, connection pool exhaustion, thundering herd (200 concurrent), bulk write crashes, concurrent transaction kills, and double failure (Redis + MySQL both down).

## Config

```bash
# Required
DB_HOST, DB_USERNAME, DB_NAME, REDIS_SERVER

# Optional
DB_PASSWORD, DB_PORT=3306, REDIS_PORT=6379, REDIS_PASSWORD
DB_CONNECTION_LIMIT=151, REDIS_VHOST=namespace
CORE_AUTO_FEATURES=true, REDIS_ENABLED=true
REDIS_WAIT_TIMEOUT=10000, DB_CONNECT_TIMEOUT=10000
REDIS_FAIL_FAST=true, REDIS_COMMAND_TIMEOUT=10000
REDIS_RECONNECT_MAX_DELAY=5000, REDIS_SCAN_COUNT=1000
DB_COALESCE_QUERIES=true, DB_PAGINATION_REUSE_TOTAL=false
```

## Use Cases

| Scenario | Guide |
|----------|-------|
| E-Commerce | [docs/USE-CASE-ECOMMERCE.md](docs/USE-CASE-ECOMMERCE.md) |
| Multi-Tenant SaaS | [docs/USE-CASE-SAAS.md](docs/USE-CASE-SAAS.md) |
| Real-Time Apps | [docs/USE-CASE-REALTIME.md](docs/USE-CASE-REALTIME.md) |
| Bulk Operations | [docs/USE-CASE-BULK.md](docs/USE-CASE-BULK.md) |

## Docs

- [API Reference](docs/API.md)
- [Configuration](docs/CONFIGURATION.md)
- [Examples](docs/EXAMPLES.md)
- [Migration Guide](docs/MIGRATION.md)
- [Türkçe](docs/README.tr.md)

## License

MIT
