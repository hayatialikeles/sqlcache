# Multi-Tenant SaaS Use Case

## Database per Tenant

```javascript
const { getCacheQuery, QuaryCache } = require('sqlcache');

// Middleware: Extract tenant
app.use((req, res, next) => {
    req.tenantDb = `tenant_${req.headers['x-tenant-id']}`;
    next();
});

// Read from tenant database
app.get('/users', async (req, res) => {
    const users = await getCacheQuery(
        'SELECT * FROM users WHERE active = 1',
        [],
        null,
        req.tenantDb  // 4th param = database
    );
    res.json(users);
});

// Write to tenant database
app.post('/users', async (req, res) => {
    await QuaryCache(
        'INSERT INTO users (name, email) VALUES (?, ?)',
        [req.body.name, req.body.email],
        null,
        req.tenantDb
    );
    res.json({ success: true });
});
```

## Namespace per Tenant

```bash
# .env
REDIS_VHOST=tenant_123
```

Or dynamically:

```javascript
// Each tenant gets isolated cache namespace
process.env.REDIS_VHOST = `tenant_${tenantId}`;
```

## Cross-Tenant Admin Query

```javascript
app.get('/admin/all-users', async (req, res) => {
    const tenants = ['tenant_1', 'tenant_2', 'tenant_3'];

    const results = await Promise.all(
        tenants.map(db =>
            getCacheQuery('SELECT * FROM users', [], null, db)
        )
    );

    res.json(results.flat());
});
```
