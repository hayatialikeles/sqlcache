# Bulk Operations Use Case

`bulkInsert` takes its columns from the keys of the first record and puts the table and column
names into the SQL as-is (since v2.9.1 an invalid name is rejected with a `TypeError` before anything
is sent). Never pass untrusted keys: map request or CSV input onto a fixed list of columns, as below.

Without `transaction: true`, each chunk commits on its own and a connection error retries from the
first unacknowledged chunk, so a chunk can be inserted twice. With `transaction: true`, all chunks
commit together; an error from `COMMIT` is not retried and carries `err.commitOutcomeUnknown = true`.

## Import Large Dataset

```javascript
const { bulkInsert } = require('sqlcache');

app.post('/import/products', async (req, res) => {
    // Copy only the known columns: bulkInsert uses the first record's keys as column names
    const products = req.body.products.map(p => ({ // 100K+ records
        sku: String(p.sku),
        name: String(p.name),
        price: Number(p.price)
    }));

    const result = await bulkInsert('products', products, {
        chunkSize: 1000,           // Insert 1000 at a time
        resetCacheName: 'products' // Clear product cache after (every key starting with "products")
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

    try {
        await bulkInsert('analytics_events', events, {
            chunkSize: 5000
        });
    } catch (err) {
        // An unhandled rejection would stop the process; log without err.sql (it holds the values)
        console.error('Event flush failed:', err.code, err.message);
    }
}, 10000);

// Track event (the record has fixed keys; only the values come from the request)
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

// The only columns written. The keys of a parsed CSV row come from the uploaded file's
// header line, so they must never reach bulkInsert as they are.
const IMPORT_COLUMNS = ['name', 'email', 'city'];

app.post('/import/csv', async (req, res) => {
    const records = [];

    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (row) => {
            const record = {};
            for (const column of IMPORT_COLUMNS) record[column] = row[column] ?? null;
            records.push(record);
        })
        .on('end', async () => {
            try {
                const result = await bulkInsert('imports', records, {
                    chunkSize: 2000
                });
                res.json(result);
            } catch (err) {
                res.status(500).json({ error: 'Import failed' });
            }
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
// For very large imports, insert in batches to report progress
// (each bulkInsert call is retried and invalidated on its own)
const batchSize = 5000;
for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    await bulkInsert('table', batch);
    console.log(`Processed ${i + batch.length}/${records.length}`);
}
```
