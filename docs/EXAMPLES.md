# Real-World Examples

Comprehensive examples for common use cases.

---

## Table of Contents

- [E-Commerce](#e-commerce)
- [Social Media](#social-media)
- [Multi-Tenant SaaS](#multi-tenant-saas)
- [Analytics & Reporting](#analytics--reporting)
- [Real-Time Chat](#real-time-chat)
- [Authentication & Sessions](#authentication--sessions)
- [Content Management](#content-management)
- [Inventory Management](#inventory-management)

---

## E-Commerce

### Complete Order Flow with Transactions

```javascript
const { withTransaction, getCacheQuery, QuaryCache } = require('sqlcache');

// Create order with stock management
app.post('/orders', async (req, res) => {
    const { userId, items, shippingAddress } = req.body;

    try {
        const result = await withTransaction(async (tx) => {
            // 1. Create order
            const orderResult = await tx.query(
                'INSERT INTO orders (user_id, status, shipping_address, created_at) VALUES (?, ?, ?, NOW())',
                [userId, 'pending', JSON.stringify(shippingAddress)]
            );
            const orderId = orderResult.insertId;

            let totalAmount = 0;

            // 2. Process each item
            for (const item of items) {
                // Check stock
                const [product] = await tx.getCacheQuery(
                    'SELECT id, name, price, stock FROM products WHERE id = ?',
                    [item.productId],
                    `product-${item.productId}`
                );

                if (!product || product.stock < item.quantity) {
                    throw new Error(`Insufficient stock for product ${item.productId}`);
                }

                // Add order item
                await tx.query(
                    'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)',
                    [orderId, item.productId, item.quantity, product.price]
                );

                // Update stock
                await tx.query(
                    'UPDATE products SET stock = stock - ? WHERE id = ?',
                    [item.quantity, item.productId]
                );

                totalAmount += product.price * item.quantity;
            }

            // 3. Update order total
            await tx.query(
                'UPDATE orders SET total_amount = ? WHERE id = ?',
                [totalAmount, orderId]
            );

            // 4. Create payment record
            await tx.query(
                'INSERT INTO payments (order_id, amount, status) VALUES (?, ?, ?)',
                [orderId, totalAmount, 'pending']
            );

            return { orderId, totalAmount };
            // ✅ Everything commits together
            // ⚠️ If anything fails, everything rolls back
        });

        res.json({ success: true, ...result });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});
```

### Product Catalog with Caching

```javascript
// Get products by category (cached)
app.get('/products/category/:categoryId', async (req, res) => {
    const { categoryId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const products = await getCacheQuery(
        `SELECT p.*, c.name as category_name
         FROM products p
         JOIN categories c ON p.category_id = c.id
         WHERE p.category_id = ? AND p.status = 'active'
         ORDER BY p.created_at DESC
         LIMIT ? OFFSET ?`,
        [categoryId, parseInt(limit), (page - 1) * limit]
    );

    res.json(products);
});

// Update product (auto-invalidates cache)
app.put('/products/:id', async (req, res) => {
    const { id } = req.params;
    const { name, price, stock, category_id } = req.body;

    await QuaryCache(
        'UPDATE products SET name = ?, price = ?, stock = ?, category_id = ? WHERE id = ?',
        [name, price, stock, category_id, id]
    );
    // ✅ All product caches automatically cleared

    res.json({ success: true });
});
```

---

## Social Media

### News Feed with Smart Caching

```javascript
// Get personalized feed
app.get('/feed', async (req, res) => {
    const userId = req.user.id;

    const posts = await getCacheQuery(
        `SELECT p.*, u.name, u.avatar, u.verified,
                COUNT(l.id) as likes_count,
                COUNT(c.id) as comments_count
         FROM posts p
         JOIN users u ON p.user_id = u.id
         LEFT JOIN likes l ON p.id = l.post_id
         LEFT JOIN comments c ON p.id = c.post_id
         WHERE p.user_id IN (
             SELECT following_id FROM followers WHERE follower_id = ?
         )
         GROUP BY p.id
         ORDER BY p.created_at DESC
         LIMIT 50`,
        [userId]
    );

    res.json(posts);
});

// Create post with media
app.post('/posts', async (req, res) => {
    const { userId, content, mediaUrls } = req.body;

    const postId = await withTransaction(async (tx) => {
        // Create post
        const postResult = await tx.query(
            'INSERT INTO posts (user_id, content, created_at) VALUES (?, ?, NOW())',
            [userId, content]
        );

        // Attach media
        if (mediaUrls && mediaUrls.length > 0) {
            for (const url of mediaUrls) {
                await tx.query(
                    'INSERT INTO post_media (post_id, media_url) VALUES (?, ?)',
                    [postResult.insertId, url]
                );
            }
        }

        // Update user post count
        await tx.query(
            'UPDATE users SET posts_count = posts_count + 1 WHERE id = ?',
            [userId]
        );

        return postResult.insertId;
    });

    res.json({ success: true, postId });
});

// Like/Unlike post
app.post('/posts/:id/like', async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    await withTransaction(async (tx) => {
        // Check if already liked
        const [existing] = await tx.query(
            'SELECT id FROM likes WHERE post_id = ? AND user_id = ?',
            [id, userId]
        );

        if (existing) {
            // Unlike
            await tx.query(
                'DELETE FROM likes WHERE post_id = ? AND user_id = ?',
                [id, userId]
            );
            await tx.query(
                'UPDATE posts SET likes_count = likes_count - 1 WHERE id = ?',
                [id]
            );
        } else {
            // Like
            await tx.query(
                'INSERT INTO likes (post_id, user_id, created_at) VALUES (?, ?, NOW())',
                [id, userId]
            );
            await tx.query(
                'UPDATE posts SET likes_count = likes_count + 1 WHERE id = ?',
                [id]
            );
        }
    });

    res.json({ success: true });
});
```

---

## Multi-Tenant SaaS

### Tenant Database Switching

```javascript
// Middleware to get tenant database
const getTenantDb = (req, res, next) => {
    const tenantId = req.headers['x-tenant-id'];
    if (!tenantId) {
        return res.status(400).json({ error: 'Tenant ID required' });
    }
    req.tenantDb = `tenant_${tenantId}`;
    next();
};

// Get tenant users
app.get('/users', getTenantDb, async (req, res) => {
    const users = await getCacheQuery(
        'SELECT id, name, email, role, created_at FROM users WHERE status = ?',
        ['active'],
        null,  // Auto-generated cache key
        req.tenantDb  // Tenant-specific database
    );

    res.json(users);
});

// Create user in tenant database
app.post('/users', getTenantDb, async (req, res) => {
    const { name, email, password, role } = req.body;

    const result = await QuaryCache(
        'INSERT INTO users (name, email, password, role, created_at) VALUES (?, ?, ?, ?, NOW())',
        [name, email, password, role],
        null,  // Auto-invalidation
        req.tenantDb
    );

    res.json({ success: true, userId: result.insertId });
});
```

### Tenant Statistics Dashboard

```javascript
app.get('/dashboard/stats', getTenantDb, async (req, res) => {
    const stats = await withTransaction(async (tx) => {
        // Get multiple stats in parallel
        const [userStats] = await tx.getCacheQuery(
            'SELECT COUNT(*) as total, SUM(CASE WHEN status="active" THEN 1 ELSE 0 END) as active FROM users',
            []
        );

        const [orderStats] = await tx.getCacheQuery(
            'SELECT COUNT(*) as total, SUM(total_amount) as revenue FROM orders WHERE DATE(created_at) = CURDATE()',
            []
        );

        const [productStats] = await tx.getCacheQuery(
            'SELECT COUNT(*) as total, SUM(CASE WHEN stock < 10 THEN 1 ELSE 0 END) as low_stock FROM products',
            []
        );

        return {
            users: userStats,
            orders: orderStats,
            products: productStats
        };
    }, { database: req.tenantDb });

    res.json(stats);
});
```

---

## Analytics & Reporting

### Bulk Event Logging

```javascript
const { bulkInsert } = require('sqlcache');

// Log events in bulk
app.post('/analytics/events/bulk', async (req, res) => {
    const events = req.body.events; // Array of events

    // Add timestamps
    const enrichedEvents = events.map(event => ({
        ...event,
        created_at: new Date(),
        ip_address: req.ip
    }));

    const result = await bulkInsert('analytics_events', enrichedEvents, {
        chunkSize: 1000,  // Process 1000 at a time
        resetCacheName: 'analytics_*',  // Clear analytics cache
        database: 'analytics_db'  // Separate analytics database
    });

    res.json({
        success: true,
        inserted: result.insertedRows,
        chunks: result.chunks
    });
});
```

### Real-Time Analytics Report

```javascript
const { getCacheQueryWithTimeout } = require('sqlcache');

app.get('/analytics/report/daily', async (req, res) => {
    try {
        const report = await getCacheQueryWithTimeout(
            `SELECT 
                DATE(created_at) as date,
                COUNT(*) as total_events,
                COUNT(DISTINCT user_id) as unique_users,
                AVG(session_duration) as avg_session_duration
             FROM analytics_events
             WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
             GROUP BY DATE(created_at)
             ORDER BY date DESC`,
            [],
            'analytics-daily-30d',
            {
                timeout: 10000,  // 10 second timeout
                database: 'analytics_db'
            }
        );

        res.json(report);
    } catch (error) {
        if (error.message.includes('timeout')) {
            res.status(504).json({ error: 'Report generation timeout' });
        } else {
            throw error;
        }
    }
});
```

---

## Real-Time Chat

### Chat Rooms and Messages

```javascript
// Get chat room messages
app.get('/chat/rooms/:roomId/messages', async (req, res) => {
    const { roomId } = req.params;
    const { before, limit = 50 } = req.query;

    let sql = `
        SELECT m.*, u.name, u.avatar
        FROM messages m
        JOIN users u ON m.user_id = u.id
        WHERE m.room_id = ?
    `;
    const params = [roomId];

    if (before) {
        sql += ' AND m.id < ?';
        params.push(before);
    }

    sql += ' ORDER BY m.created_at DESC LIMIT ?';
    params.push(parseInt(limit));

    const messages = await getCacheQuery(sql, params);
    res.json(messages);
});

// Send message
app.post('/chat/rooms/:roomId/messages', async (req, res) => {
    const { roomId } = req.params;
    const { userId, text } = req.body;

    const messageId = await withTransaction(async (tx) => {
        // Insert message
        const msgResult = await tx.query(
            'INSERT INTO messages (room_id, user_id, text, created_at) VALUES (?, ?, ?, NOW())',
            [roomId, userId, text]
        );

        // Update room last message
        await tx.query(
            'UPDATE chat_rooms SET last_message_at = NOW(), message_count = message_count + 1 WHERE id = ?',
            [roomId]
        );

        // Update unread counts for other users
        await tx.query(
            'UPDATE room_members SET unread_count = unread_count + 1 WHERE room_id = ? AND user_id != ?',
            [roomId, userId]
        );

        return msgResult.insertId;
    });

    res.json({ success: true, messageId });
});

// Mark messages as read
app.post('/chat/rooms/:roomId/read', async (req, res) => {
    const { roomId } = req.params;
    const userId = req.user.id;

    await QuaryCache(
        'UPDATE room_members SET unread_count = 0, last_read_at = NOW() WHERE room_id = ? AND user_id = ?',
        [roomId, userId]
    );

    res.json({ success: true });
});
```

---

## Authentication & Sessions

### User Registration with Transaction

```javascript
app.post('/auth/register', async (req, res) => {
    const { email, password, name } = req.body;

    try {
        const userId = await withTransaction(async (tx) => {
            // Check if email exists
            const [existing] = await tx.query(
                'SELECT id FROM users WHERE email = ?',
                [email]
            );

            if (existing) {
                throw new Error('Email already exists');
            }

            // Hash password
            const hashedPassword = await bcrypt.hash(password, 10);

            // Create user
            const userResult = await tx.query(
                'INSERT INTO users (email, password, name, created_at) VALUES (?, ?, ?, NOW())',
                [email, hashedPassword, name]
            );

            // Create default profile
            await tx.query(
                'INSERT INTO profiles (user_id, bio, avatar) VALUES (?, ?, ?)',
                [userResult.insertId, '', '/default-avatar.png']
            );

            // Create welcome notification
            await tx.query(
                'INSERT INTO notifications (user_id, type, message) VALUES (?, ?, ?)',
                [userResult.insertId, 'welcome', 'Welcome to our platform!']
            );

            return userResult.insertId;
        });

        res.json({ success: true, userId });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});
```

### Session Management

```javascript
const { addArrayItem, getArrayItem, delKeyItem } = require('sqlcache');

// Create session
app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;

    const [user] = await getCacheQuery(
        'SELECT id, email, password, name FROM users WHERE email = ?',
        [email],
        `user-email-${email}`
    );

    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create session
    const sessionId = crypto.randomUUID();
    const sessionData = {
        userId: user.id,
        email: user.email,
        name: user.name,
        createdAt: new Date()
    };

    await addArrayItem(`session-${sessionId}`, [sessionData], 3600); // 1 hour

    res.json({ sessionId, user: { id: user.id, name: user.name, email: user.email } });
});

// Verify session middleware
const requireAuth = async (req, res, next) => {
    const sessionId = req.headers['authorization']?.replace('Bearer ', '');

    if (!sessionId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const [session] = await getArrayItem(`session-${sessionId}`);

    if (!session) {
        return res.status(401).json({ error: 'Session expired' });
    }

    req.user = session;
    next();
};

// Logout
app.post('/auth/logout', requireAuth, async (req, res) => {
    const sessionId = req.headers['authorization']?.replace('Bearer ', '');
    await delKeyItem(`session-${sessionId}`);
    res.json({ success: true });
});
```

---

## Content Management

### Article Publishing Workflow

```javascript
// Publish article with SEO
app.post('/articles/publish', async (req, res) => {
    const { title, content, authorId, categoryId, tags, seoData } = req.body;

    const articleId = await withTransaction(async (tx) => {
        // Create article
        const articleResult = await tx.query(
            'INSERT INTO articles (title, content, author_id, category_id, status, published_at) VALUES (?, ?, ?, ?, ?, NOW())',
            [title, content, authorId, categoryId, 'published']
        );

        const artId = articleResult.insertId;

        // Add tags
        for (const tag of tags) {
            await tx.query(
                'INSERT INTO article_tags (article_id, tag_id) VALUES (?, ?)',
                [artId, tag]
            );
        }

        // Add SEO data
        await tx.query(
            'INSERT INTO article_seo (article_id, meta_title, meta_description, keywords) VALUES (?, ?, ?, ?)',
            [artId, seoData.title, seoData.description, seoData.keywords]
        );

        // Update author stats
        await tx.query(
            'UPDATE users SET articles_count = articles_count + 1 WHERE id = ?',
            [authorId]
        );

        return artId;
    });

    res.json({ success: true, articleId });
});
```

---

## Inventory Management

### Stock Management with Transactions

```javascript
// Transfer stock between warehouses
app.post('/inventory/transfer', async (req, res) => {
    const { productId, fromWarehouse, toWarehouse, quantity } = req.body;

    await withTransaction(async (tx) => {
        // Check source stock
        const [source] = await tx.query(
            'SELECT stock FROM warehouse_inventory WHERE product_id = ? AND warehouse_id = ? FOR UPDATE',
            [productId, fromWarehouse]
        );

        if (!source || source.stock < quantity) {
            throw new Error('Insufficient stock in source warehouse');
        }

        // Decrease source
        await tx.query(
            'UPDATE warehouse_inventory SET stock = stock - ? WHERE product_id = ? AND warehouse_id = ?',
            [quantity, productId, fromWarehouse]
        );

        // Increase destination
        await tx.query(
            'INSERT INTO warehouse_inventory (product_id, warehouse_id, stock) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE stock = stock + ?',
            [productId, toWarehouse, quantity, quantity]
        );

        // Log transfer
        await tx.query(
            'INSERT INTO stock_transfers (product_id, from_warehouse, to_warehouse, quantity, transferred_at) VALUES (?, ?, ?, ?, NOW())',
            [productId, fromWarehouse, toWarehouse, quantity]
        );
    });

    res.json({ success: true });
});
```

---

**[← Back to Main README](../README.md)**
