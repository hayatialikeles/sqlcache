# E-Commerce Use Case

## Order Creation with Transaction

```javascript
const { withTransaction, QuaryCache } = require('sqlcache');

app.post('/orders', async (req, res) => {
    const { userId, items } = req.body;

    const orderId = await withTransaction(async (tx) => {
        // Create order
        const order = await tx.query(
            'INSERT INTO orders (user_id, status) VALUES (?, ?)',
            [userId, 'pending']
        );

        // Add items + update stock
        for (const item of items) {
            await tx.query(
                'INSERT INTO order_items (order_id, product_id, qty) VALUES (?, ?, ?)',
                [order.insertId, item.productId, item.qty]
            );

            await tx.query(
                'UPDATE products SET stock = stock - ? WHERE id = ?',
                [item.qty, item.productId]
            );
        }

        return order.insertId;
    });

    res.json({ orderId });
});
```

## Product Listing (Cached)

```javascript
const { getCacheQuery } = require('sqlcache');

app.get('/products', async (req, res) => {
    const products = await getCacheQuery(
        'SELECT * FROM products WHERE active = 1 ORDER BY created_at DESC'
    );
    res.json(products);
});
```

## Cart Update

```javascript
app.post('/cart/add', async (req, res) => {
    await QuaryCache(
        'INSERT INTO cart (user_id, product_id, qty) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE qty = qty + ?',
        [req.userId, req.body.productId, req.body.qty, req.body.qty]
    );
    res.json({ success: true });
});
```

## Why This Works

- **Transaction**: Order + items + stock update all succeed or all fail
- **Cache**: Product listings served from Redis
- **Auto-invalidation**: Cart/product changes clear related cache
