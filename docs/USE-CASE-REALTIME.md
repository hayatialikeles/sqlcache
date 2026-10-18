# Real-Time Apps Use Case

## Chat Messages

```javascript
const { getCacheQuery, QuaryCache } = require('sqlcache');

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
// Update last seen
app.post('/heartbeat', async (req, res) => {
    await QuaryCache(
        'UPDATE users SET last_seen = NOW() WHERE id = ?',
        [req.userId]
    );
    res.json({ ok: true });
});

// Get online users (cached 30s)
app.get('/online', async (req, res) => {
    const users = await getCacheQuery(
        'SELECT id, name FROM users WHERE last_seen > DATE_SUB(NOW(), INTERVAL 5 MINUTE)'
    );
    res.json(users);
});
```
