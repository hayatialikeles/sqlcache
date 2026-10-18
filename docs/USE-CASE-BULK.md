# Bulk Operations Use Case

## Import Large Dataset

```javascript
const { bulkInsert } = require('sqlcache');

app.post('/import/products', async (req, res) => {
    const products = req.body.products; // 100K+ records

    const result = await bulkInsert('products', products, {
        chunkSize: 1000,           // Insert 1000 at a time
        resetCacheName: 'products' // Clear product cache after
    });

    res.json({
        inserted: result.insertedRows,
        chunks: result.chunks
    });
});
```

## Analytics Events

```javascript
// Collect events in memory
let eventBuffer = [];

// Flush every 10 seconds
setInterval(async () => {
    if (eventBuffer.length === 0) return;

    const events = eventBuffer;
    eventBuffer = [];

    await bulkInsert('analytics_events', events, {
        chunkSize: 5000
    });
}, 10000);

// Track event
app.post('/track', (req, res) => {
    eventBuffer.push({
        event_type: req.body.type,
        user_id: req.userId,
        data: JSON.stringify(req.body.data),
        created_at: new Date()
    });
    res.json({ ok: true });
});
```

## CSV Import

```javascript
const csv = require('csv-parser');
const fs = require('fs');

app.post('/import/csv', async (req, res) => {
    const records = [];

    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (row) => records.push(row))
        .on('end', async () => {
            const result = await bulkInsert('imports', records, {
                chunkSize: 2000
            });
            res.json(result);
        });
});
```

## Performance Tips

| Records | Chunk Size | Memory |
|---------|------------|--------|
| < 10K | 1000 | Low |
| 10K - 100K | 2000 | Medium |
| 100K+ | 5000 | High |

```javascript
// For very large imports, process in streams
const chunkSize = 5000;
for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    await bulkInsert('table', chunk);
    console.log(`Processed ${i + chunk.length}/${records.length}`);
}
```
