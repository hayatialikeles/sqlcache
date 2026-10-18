# Real-Time Apps Use Case

These examples omit cache names and invalidation prefixes, so they need both
`CORE_AUTO_FEATURES=true` (automatic keys) and `CORE_AUTO_INVALIDATION=true` (automatic
invalidation). Without the second, new messages would not show up until the cached list expires
(40000 s).

## Chat Messages

```javascript
const { getCacheQuery, QuaryCache, getArrayItem, addArrayItem } = require('sqlcache');

// Get messages (cached)
app.get('/chat/:roomId/messages', async (req, res) => {
    const messages = await getCacheQuery(
        `SELECT m.*, u.name, u.avatar
         FROM messages m
         JOIN users u ON m.user_id = u.id
         WHERE m.room_id = ?
         ORDER BY m.created_at DESC
         LIMIT 100`,
        [req.params.roomId]
    );
    res.json(messages);
});

// Send message (invalidates cache)
app.post('/chat/:roomId/messages', async (req, res) => {
    await QuaryCache(
        'INSERT INTO messages (room_id, user_id, text) VALUES (?, ?, ?)',
        [req.params.roomId, req.userId, req.body.text]
    );

    // Emit to websocket
    io.to(req.params.roomId).emit('new-message', req.body);

    res.json({ success: true });
});
```

## Notifications

```javascript
// Get unread notifications (cached)
app.get('/notifications', async (req, res) => {
    const notifications = await getCacheQuery(
        'SELECT * FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY created_at DESC',
        [req.userId]
    );
    res.json(notifications);
});

// Mark as read
app.post('/notifications/:id/read', async (req, res) => {
    await QuaryCache(
        'UPDATE notifications SET read_at = NOW() WHERE id = ?',
        [req.params.id]
    );
    res.json({ success: true });
});
```

## Online Status

```javascript
// Update last seen. With automatic invalidation every heartbeat clears all users:* and users_*
// keys; if you cache other user queries, keep presence in a table of its own.
app.post('/heartbeat', async (req, res) => {
    await QuaryCache(
        'UPDATE users SET last_seen = NOW() WHERE id = ?',
        [req.userId]
    );
    res.json({ ok: true });
});

// Get online users, cached for 30 s. getCacheQuery has no per-call TTL (it caches for 40000 s),
// so read with QuaryCache, which does not use the cache, and cache the rows by hand.
app.get('/online', async (req, res) => {
    let users = await getArrayItem('online-users');
    if (users.length === 0) {
        users = await QuaryCache(
            'SELECT id, name FROM users WHERE last_seen > DATE_SUB(NOW(), INTERVAL 5 MINUTE)',
            []
        );
        await addArrayItem('online-users', users, 30); // TTL in seconds
    }
    res.json(users);
});
```
