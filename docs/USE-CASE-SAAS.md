# Multi-Tenant SaaS Use Case

## Database per Tenant

```javascript
const { getCacheQuery, QuaryCache } = require('sqlcache');

// Middleware: take the tenant from the authenticated session (set by your auth middleware)
// and check it against an allowlist. Never build the database name from a raw request header.
const TENANT_DATABASES = new Set(['tenant_1', 'tenant_2', 'tenant_3']);

app.use((req, res, next) => {
    const tenantDb = req.user && `tenant_${req.user.tenantId}`;
    if (!tenantDb || !TENANT_DATABASES.has(tenantDb)) {
        return res.status(403).json({ error: 'Unknown tenant' });
    }
    req.tenantDb = tenantDb;
    next();
});

// Read from tenant database, cached under a tenant-prefixed name
app.get('/users', async (req, res) => {
    const users = await getCacheQuery(
        'SELECT * FROM users WHERE active = 1',
        [],
        `${req.tenantDb}:users:active`,
        req.tenantDb  // 4th param = database
    );
    res.json(users);
});

// Write to tenant database and clear only this tenant's user caches
app.post('/users', async (req, res) => {
    await QuaryCache(
        'INSERT INTO users (name, email) VALUES (?, ?)',
        [req.body.name, req.body.email],
        `${req.tenantDb}:users`,
        req.tenantDb
    );
    res.json({ success: true });
});
```

With automatic keys (`null` as the cache name and `CORE_AUTO_FEATURES=true`), keys end with
`@<database>`, for example `users:active:all@tenant_1`, so tenants never share an entry; automatic
invalidation then clears `users:*` of every tenant.

## Namespace per Tenant

```bash
# .env, only when each tenant runs in its own process
REDIS_VHOST=tenant_123
```

`REDIS_VHOST` applies to the whole process. Never change it per request
(`process.env.REDIS_VHOST = ...`): concurrent requests share it, so one tenant's request can read or
write another tenant's entries. v2.9.1 logs a warning when it changes at runtime. Within one process,
use the `database` argument and tenant-prefixed cache names as shown above.

## Cross-Tenant Admin Query

```javascript
app.get('/admin/all-users', async (req, res) => {
    const tenants = [...TENANT_DATABASES];

    const results = await Promise.all(
        tenants.map(db =>
            getCacheQuery('SELECT * FROM users', [], `${db}:users:all`, db)
        )
    );

    res.json(results.flat());
});
```
