# Configuration Guide

Complete configuration reference for MySQL Redis Cache Connector.

---

## Environment Variables

### Required Configuration

```bash
# MySQL Database
DB_HOST=localhost              # MySQL host
DB_USERNAME=root               # MySQL username
DB_PASSWORD=secret             # MySQL password
DB_NAME=mydb                   # Database name

# Redis Cache
REDIS_SERVER=localhost         # Redis host
REDIS_PORT=6379               # Redis port
```

### Optional Configuration

#### Database Settings

```bash
DB_PORT=3306                          # MySQL port (default: 3306)
DB_CONNECTION_LIMIT=10                # Max connections in pool (default: 151)
DB_QUEUE_LIMIT=0                      # Max queued requests (default: 0 = unlimited)
DB_CONNECT_TIMEOUT=10000              # Connection timeout in ms (default: 10000)
DB_MULTIPLE_STATEMENTS=false          # Allow multiple statements (default: true, for backward compatibility)
DB_COALESCE_QUERIES=true              # Concurrent identical cache misses share one query (default: true)
DB_PAGINATION_REUSE_TOTAL=false       # Reuse a query's pagination total across pages (default: false)
DB_MAX_IDLE=10                        # Idle connections kept in the pool (default: 10)
DB_IDLE_TIMEOUT=60000                 # Idle time (ms) before connections above DB_MAX_IDLE close (default: 60000)
TIMEZONE=+00:00                       # Timezone offset (default: +00:00)
```

#### Redis Settings

```bash
REDIS_PASSWORD=secret                 # Redis password (if required)
REDIS_VHOST=my_app                    # Redis key namespace/prefix
REDIS_ENABLED=true                    # Enable/disable Redis (default: true)
```

#### Redis Resilience & Performance

```bash
REDIS_WAIT_TIMEOUT=10000              # Max wait (ms) for Redis to (re)connect before falling back (default: 10000)
REDIS_FAIL_FAST=true                  # After REDIS_WAIT_TIMEOUT of downtime, cache reads/writes stop waiting (default: true)
REDIS_COMMAND_TIMEOUT=10000           # Max time (ms) a cache read/write may stay unanswered (default: max(REDIS_WAIT_TIMEOUT, 10000), 0 = off)
REDIS_RECONNECT_MAX_DELAY=5000        # Max delay (ms) between reconnect attempts (default: 5000; 30000 before v2.9.0)
REDIS_SCAN_COUNT=1000                 # Keys examined per SCAN round trip in prefix deletes (default: 1000; 100 before v2.9.0)
```

Deletes (`delKeyItem`, `delPrefixKeyItem`, invalidation after writes) always wait for Redis and are
never cut short by `REDIS_COMMAND_TIMEOUT`; deletes that fail because Redis is unreachable are
replayed once it is ready again. See [MIGRATION.md](MIGRATION.md#v28x--v290-performance--resilience)
for the full list of v2.9.0 changes and how to restore v2.8.x behavior.

With `REDIS_ENABLED=false` no Redis connection is opened unless a Redis function
(`getArrayItem`, `getRedisClient`, ...) is called directly.

#### Smart Features (v2.6.0)

```bash
# Enable all smart features
CORE_AUTO_FEATURES=true              # Auto key + auto invalidation

# Or enable individually
CORE_AUTO_INVALIDATION=true          # Auto cache invalidation only
```

---

## Programmatic Configuration

### All-in-One Setup

```javascript
const { configure } = require('node-caching-mysql-connector-with-redis');

configure({
    autoKey: {
        enabled: true
    },
    autoInvalidation: {
        enabled: true,
        tables: {
            users: ['users_*', 'profiles_*', 'sessions_*'],
            orders: ['orders_*', 'cart_*', 'analytics_*'],
            products: ['products_*', 'catalog_*']
        }
    }
});
```

### Individual Feature Configuration

```javascript
const { enableAutoKey, enableAutoInvalidation } = require('node-caching-mysql-connector-with-redis');

// Enable auto key generation
enableAutoKey({ enabled: true });

// Enable auto invalidation with custom rules
enableAutoInvalidation({
    enabled: true,
    tables: {
        users: 'users_*',
        orders: ['orders_*', 'analytics_*']
    }
});
```

---

## Configuration by Environment

### Development

```bash
# .env.development
DB_HOST=localhost
DB_USERNAME=root
DB_PASSWORD=dev_password
DB_NAME=myapp_dev
DB_CONNECTION_LIMIT=5
REDIS_SERVER=localhost
REDIS_PORT=6379
CORE_AUTO_FEATURES=true
```

### Staging

```bash
# .env.staging
DB_HOST=staging-db.example.com
DB_USERNAME=app_user
DB_PASSWORD=${STAGING_DB_PASSWORD}
DB_NAME=myapp_staging
DB_CONNECTION_LIMIT=20
REDIS_SERVER=staging-redis.example.com
REDIS_PORT=6379
REDIS_PASSWORD=${STAGING_REDIS_PASSWORD}
CORE_AUTO_FEATURES=true
```

### Production

```bash
# .env.production
DB_HOST=prod-db.example.com
DB_USERNAME=app_user
DB_PASSWORD=${PROD_DB_PASSWORD}
DB_NAME=myapp_prod
DB_CONNECTION_LIMIT=50
DB_CONNECT_TIMEOUT=5000
REDIS_SERVER=prod-redis.example.com
REDIS_PORT=6379
REDIS_PASSWORD=${PROD_REDIS_PASSWORD}
REDIS_VHOST=myapp_prod
CORE_AUTO_FEATURES=true
```

---

## Connection Pool Tuning

### Small Application (< 100 concurrent users)

```bash
DB_CONNECTION_LIMIT=10
DB_QUEUE_LIMIT=0
DB_CONNECT_TIMEOUT=10000
```

### Medium Application (100-1000 concurrent users)

```bash
DB_CONNECTION_LIMIT=50
DB_QUEUE_LIMIT=100
DB_CONNECT_TIMEOUT=5000
```

### Large Application (1000+ concurrent users)

```bash
DB_CONNECTION_LIMIT=100
DB_QUEUE_LIMIT=500
DB_CONNECT_TIMEOUT=3000
```

### Bursty Traffic

Connections above `DB_MAX_IDLE` are closed once idle for `DB_IDLE_TIMEOUT` and opened again on the
next burst. If load comes in bursts further apart than that (e.g. scheduled jobs), every burst pays
for new connections; keep them warm by raising `DB_MAX_IDLE` towards `DB_CONNECTION_LIMIT` or by
raising `DB_IDLE_TIMEOUT`:

```bash
DB_CONNECTION_LIMIT=50
DB_MAX_IDLE=50
```

### Large Result Sets and Deep Pages

- Cached results are stored as JSON: about 10 ms to serialize and 4 ms to parse per 10,000 rows of
  a typical 10-column table, so prefer `getCacheQueryPagination` over caching very large results.
- Pagination uses `LIMIT offset, size`; MySQL reads and skips `offset` rows, so very deep pages cost
  more. For long lists, an indexed `WHERE id > ?` (keyset) condition in the SQL stays fast at any depth.
- `DB_PAGINATION_REUSE_TOTAL=true` avoids recounting the total on every page miss of large lists.

### Monitoring Pool Usage

```javascript
const { getPoolStats } = require('node-caching-mysql-connector-with-redis');

setInterval(() => {
    const stats = getPoolStats();
    console.log({
        total: stats.totalConnections,
        active: stats.activeConnections,
        free: stats.freeConnections,
        queued: stats.queuedRequests,
        utilization: (stats.activeConnections / stats.totalConnections * 100).toFixed(2) + '%'
    });

    if (stats.activeConnections === stats.totalConnections) {
        console.warn('⚠️ Connection pool exhausted!');
    }
}, 60000); // Check every minute
```

---

## Cache Configuration

### Default Cache TTL

```javascript
const { addArrayItem } = require('node-caching-mysql-connector-with-redis');

// Default TTL: 40000 seconds (~11 hours)
await addArrayItem('my-key', data);

// Custom TTL: 1 hour
await addArrayItem('my-key', data, 3600);

// Custom TTL: 5 minutes
await addArrayItem('my-key', data, 300);
```

### Cache Invalidation Patterns

#### Default Patterns

When auto-invalidation is enabled, default patterns are:
- `{table}_*` (underscore prefix)
- `{table}:*` (colon prefix)

```javascript
// INSERT INTO users triggers:
// - Clears: users_*
// - Clears: users:*
```

#### Custom Patterns

```javascript
enableAutoInvalidation({
    enabled: true,
    tables: {
        users: [
            'users_*',        // All user caches
            'profiles_*',     // User profiles
            'sessions_*',     // User sessions
            'feed:*'          // User feeds
        ],
        orders: [
            'orders_*',
            'cart_*',
            'analytics_orders_*'
        ]
    }
});
```

### Disable Redis

```bash
REDIS_ENABLED=false
```

```javascript
// Queries execute normally without caching
const users = await getCacheQuery('SELECT * FROM users', []); 
// No Redis involved
```

---

## Auto Key Generation Strategy

### Detailed Strategy (1-3 parameters)

```javascript
// Query
SELECT * FROM users WHERE id = ? AND status = ?

// Generated key
users:id:status:a7b3c2d1
```

### Simple Strategy (4+ parameters)

```javascript
// Query
SELECT * FROM orders WHERE a = ? AND b = ? AND c = ? AND d = ?

// Generated key
orders:9f2ac12b
```

### Manual Override

```javascript
// Auto key
const users = await getCacheQuery('SELECT * FROM users WHERE id = ?', [123]);

// Manual key (overrides auto)
const users = await getCacheQuery('SELECT * FROM users WHERE id = ?', [123], 'my-custom-key');
```

---

## Security Best Practices

### Environment Variables

```bash
# NEVER commit passwords to git
# Use environment variables or secrets management

# Good
DB_PASSWORD=${DATABASE_PASSWORD}
REDIS_PASSWORD=${REDIS_AUTH_TOKEN}

# Bad
DB_PASSWORD=mypassword123
```

### SQL Injection Protection

```javascript
// ✅ Good - Use parameterized queries
await getCacheQuery('SELECT * FROM users WHERE id = ?', [userId]);

// ❌ Bad - String interpolation
await getCacheQuery(`SELECT * FROM users WHERE id = ${userId}`);
```

### Connection Limits

```bash
# Prevent connection exhaustion attacks
DB_CONNECTION_LIMIT=50
DB_QUEUE_LIMIT=100
DB_CONNECT_TIMEOUT=5000
```

---

## Troubleshooting

### Connection Errors

```bash
# Error: connect ECONNREFUSED
# Solution: Check if MySQL/Redis is running

mysql -u root -p
redis-cli ping
```

### Pool Exhaustion

```bash
# Error: Too many connections
# Solution: Increase connection limit

DB_CONNECTION_LIMIT=100
```

### Timeout Issues

```bash
# Error: Query timeout exceeded
# Solution: Increase timeout or optimize query

DB_CONNECT_TIMEOUT=30000
```

### Redis Outage Log Lines

```bash
# "Redis operation failed: Redis unavailable for 10234ms — serving cache misses without waiting until it recovers"
#   Redis has been unreachable for REDIS_WAIT_TIMEOUT: cache reads/writes fall back immediately
#   (once per outage). Restore the old wait-on-every-call behavior with REDIS_FAIL_FAST=false.
# "Redis operation failed: Redis get timed out after 10000ms"
#   A command got no reply within REDIS_COMMAND_TIMEOUT. Raise it for slow links, or 0 to disable.
# "Redis gave no reply for 10000ms — reconnecting"
#   The connection was silent while commands waited (e.g. dropped after a failover); it is reopened.
# "Redis: replaying 3 invalidation(s) missed while it was unavailable"
#   Deletes that failed during the outage are being applied now that Redis is back.
```

### Cache Issues

```bash
# Clear all cache
redis-cli FLUSHALL

# Clear specific pattern
redis-cli --scan --pattern "users_*" | xargs redis-cli DEL
```

---

**[← Back to Main README](../README.md)**
