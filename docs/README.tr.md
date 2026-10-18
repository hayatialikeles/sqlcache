# sqlcache

[![npm version](https://img.shields.io/npm/v/sqlcache.svg)](https://www.npmjs.com/package/sqlcache)
[![TypeScript](https://img.shields.io/badge/TypeScript-Full%20Support-blue.svg)](https://github.com/hayatialikeles/sqlcache)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)

> **Eski adı `node-caching-mysql-connector-with-redis`.** Paket v2.9.0 ile `sqlcache` adını aldı; API
> aynı. Eski adla kurulu projeler çalışmaya devam eder: eski adın 2.9.0 sürümü `sqlcache`'e yönlendirir.
> Geçiş için: `npm uninstall node-caching-mysql-connector-with-redis && npm install sqlcache`, ardından
> `require('node-caching-mysql-connector-with-redis')` yerine `require('sqlcache')`.

Üretim ortamına hazır, **otomatik Redis önbellekleme**, **akıllı cache temizleme** ve **transaction desteği** içeren MySQL connector paketi.

---

## ✨ Neden Bu Paket?

```javascript
// ❌ Geleneksel yöntem – Manuel cache yönetimi
const cachedUsers = await redis.get('users-active');
if (!cachedUsers) {
    const users = await db.query('SELECT * FROM users WHERE status = ?', ['active']);
    await redis.set('users-active', JSON.stringify(users), 3600);
}
// Güncellemede cache silmeyi unutmayın!
await db.query('UPDATE users SET status = ? WHERE id = ?', ['inactive', 123]);
await redis.del('users-active'); // Unutmak çok kolay!

// ✅ Bu paketle – CORE_AUTO_FEATURES=true ve CORE_AUTO_INVALIDATION=true ile
const users = await getCacheQuery('SELECT * FROM users WHERE status = ?', ['active']);
await QuaryCache('UPDATE users SET status = ? WHERE id = ?', ['inactive', 123]);
// Cache otomatik temizlenir! ✨
````

---

## 🚀 Hızlı Başlangıç

### Kurulum

```bash
npm install sqlcache
```

### Gereksinimler

- Node.js 14 veya üzeri (Node 18–26 üzerinde test edildi)
- mysql2 3.23.1 veya üzeri (bağımlılık olarak kurulur; eski sürümlerde kritik olanlar dahil güvenlik
  açıkları var)
- MySQL 5.7 veya 8.x; Redis 2.8 veya üzeri (opsiyonel, bkz. `REDIS_ENABLED`)

### Temel Kullanım

```bash
# .env
DB_HOST=localhost
DB_USERNAME=root
DB_PASSWORD=secret
DB_NAME=mydb
REDIS_SERVER=localhost
REDIS_PORT=6379
CORE_AUTO_FEATURES=true      # Otomatik cache anahtarları 🎯
CORE_AUTO_INVALIDATION=true  # Yazmalardan sonra otomatik cache temizleme
```

`CORE_AUTO_FEATURES` yalnızca otomatik cache anahtarlarını açar; otomatik temizleme için
`CORE_AUTO_INVALIDATION=true` gerekir. Paket yalnızca çalışma dizinindeki `.env` dosyasını okur
(`${VAR}` ifadeleri açılmaz); tüm ayarların açıklamalı şablonu `node_modules/sqlcache/.env.example`
dosyasındadır.

```javascript
const { getCacheQuery, QuaryCache, withTransaction } = require('sqlcache');

// Otomatik cache ile veri okuma
const users = await getCacheQuery('SELECT * FROM users WHERE id = ?', [123]);

// Yazma işlemlerinde otomatik cache temizleme
await QuaryCache('INSERT INTO users (name, email) VALUES (?, ?)', ['Ahmet', 'ahmet@example.com']);

// Transaction yönetimi (otomatik commit/rollback)
await withTransaction(async (tx) => {
    await tx.query('INSERT INTO users...', [data]);
    await tx.query('INSERT INTO orders...', [order]);
});
```

**Hepsi bu kadar!**
Basit sorgular için manuel cache key veya manuel invalidation, transaction için de manuel
BEGIN/COMMIT gerekmez. Join, aggregate (`COUNT(*)` vb.), `LIMIT`/`ORDER BY` varyantları ve kullanıcıya
özel veya hassas veriler için açık cache adı verin: otomatik anahtar yalnızca tabloyu, `WHERE`
sütunlarını ve parametrelerin 32 bitlik özetini içerir.

---

## 🧠 Akıllı Özellikler (v2.6.0)

| Özellik                | Önce                                     | Şimdi                            | Açıklama                      |
| ---------------------- | ---------------------------------------- | -------------------------------- | ----------------------------- |
| **Cache Key**          | `getCacheQuery(sql, params, 'user-123')` | `getCacheQuery(sql, params)` ✨   | Otomatik anahtar üretimi      |
| **Cache Invalidation** | `QuaryCache(sql, params, 'users_*')`     | `QuaryCache(sql, params)` ✨      | Otomatik cache temizleme      |
| **Transaction**        | Manuel BEGIN/COMMIT                      | `withTransaction(tx => {...})` ✨ | Otomatik transaction yönetimi |

---

## ⚡ Üretim Düzeyi Özellikler

* ✅ **Otomatik Yeniden Bağlantı** – Bağlantı hatalarında backoff ile tekrar deneme
* ✅ **Bulk İşlemler** – 100K+ kayıt için otomatik parçalara bölme
* ✅ **Timeout Koruması** – Uzun süren sorguların sistemi bloklamasını önler
* ✅ **Connection Pool İzleme** – Aktif bağlantı sayısı ve durum takibi
* ✅ **Graceful Shutdown** – `closeConnections()` MySQL havuzunu kapatır; Redis açıksa ardından
  `getRedisClient().quit()` çağırın, yoksa açık Redis bağlantısı süreci ayakta tutar
* ✅ **TypeScript Desteği** – Tam IntelliSense ve tip tanımları
* ✅ **API Uyumluluğu** – API değişmedi; sürümler arası davranış farkları [MIGRATION.md](MIGRATION.md) dosyasında

---

## 💡 Yaygın Kullanım Senaryoları

### 🛒 E-Ticaret Sipariş Oluşturma

```javascript
await withTransaction(async (tx) => {
    const order = await tx.query(
        'INSERT INTO orders (user_id, status) VALUES (?, ?)',
        [userId, 'pending']
    );

    for (const item of items) {
        await tx.query(
            'INSERT INTO order_items (order_id, product_id, qty) VALUES (?, ?, ?)',
            [order.insertId, item.id, item.qty]
        );
        await tx.query(
            'UPDATE products SET stock = stock - ? WHERE id = ?',
            [item.qty, item.id]
        );
    }

    return order.insertId;
});
```

### 📱 Sosyal Medya Akışı (Auto Cache)

```javascript
// Otomatik cache ile feed çekme
const posts = await getCacheQuery(
  `SELECT p.*, u.name FROM posts p
   JOIN users u ON p.user_id = u.id
   WHERE p.user_id IN (SELECT following_id FROM followers WHERE follower_id = ?)
   ORDER BY p.created_at DESC LIMIT 20`,
  [userId]
);

// Yeni gönderi oluştur – posts:* cache'i otomatik temizlenir (CORE_AUTO_INVALIDATION=true)
await QuaryCache('INSERT INTO posts (user_id, content) VALUES (?, ?)', [userId, content]);
```

---

## 🧰 API Hızlı Referans

```javascript
// Ana fonksiyonlar
getCacheQuery(sql, params?, cacheName?, database?)
QuaryCache(sql, params?, resetCacheName?, database?)   // cache okumaz; başarılı yazmadan sonra prefix ile temizler
withTransaction(callback, options?)

// Yardımcılar
bulkInsert(table, records, options?)
getCacheQueryWithTimeout(sql, params?, cacheName?, options?)
getCacheQueryPagination(sql, params, cacheName, page, pageSize?, database?)  // page 0'dan başlar → { totalCount, pageCount, detail }
closeConnections()
getPoolStats()

// Redis fonksiyonları
getArrayItem(key)
addArrayItem(key, data, expiry?)
delKeyItem(keys)
delPrefixKeyItem(patterns)
isRedisConnected()
getRedisClient()

// Otomatik özellikler
configure({ autoKey, autoInvalidation })
enableAutoKey(config?)
enableAutoInvalidation(config?)
```

📚 **[Detaylı API Dokümantasyonu →](API.md)**

---

## ⚙️ Konfigürasyon

### Zorunlu Değişkenler

```bash
DB_HOST=localhost
DB_USERNAME=root
DB_NAME=mydb

REDIS_SERVER=localhost   # REDIS_ENABLED=false değilse zorunlu
```

### Opsiyonel Akıllı Özellikler

```bash
CORE_AUTO_FEATURES=true      # Otomatik cache anahtarları (temizlemeyi açmaz)
CORE_AUTO_INVALIDATION=true  # Yazmalardan sonra otomatik cache temizleme
```

### Gelişmiş Ayarlar

```bash
DB_PASSWORD=secret              # Varsayılan: boş
DB_PORT=3306
DB_CONNECTION_LIMIT=10          # Süreç başına (varsayılan: 151); örnek × worker × limit + diğer istemciler, MySQL max_connections (varsayılan 151) altında kalmalı
DB_QUEUE_LIMIT=0
DB_CONNECT_TIMEOUT=10000
DB_MULTIPLE_STATEMENTS=false    # Varsayılan: true (geriye uyumluluk); yeni projelerde false önerilir
TIMEZONE=+00:00
REDIS_PORT=6379
REDIS_PASSWORD=secret
REDIS_VHOST=my_app              # Tüm anahtarların öneki; süreç başına bir kez ayarlayın, istek başına değiştirmeyin
REDIS_ENABLED=true
```

### Performans ve Dayanıklılık Ayarları (v2.9.0)

```bash
DB_COALESCE_QUERIES=true          # Aynı anda gelen aynı cache-miss'ler tek sorguyu paylaşır (varsayılan: true)
DB_COALESCE_MAX_WAIT=10000        # Paylaşılan sorgu için en fazla bekleme, sonra yeni sorgu başlar, ms (varsayılan: 10000, v2.9.1)
DB_PAGINATION_REUSE_TOTAL=false   # Sayfalama toplamını aynı sorgunun diğer sayfalarında yeniden kullan (varsayılan: false)
REDIS_WAIT_TIMEOUT=10000          # Redis'in (yeniden) bağlanması için en fazla bekleme, ms (varsayılan: 10000)
REDIS_FAIL_FAST=true              # Bu süre kadar kesintiden sonra cache okuma/yazma beklemeden devam eder (varsayılan: true)
REDIS_COMMAND_TIMEOUT=10000       # Tek bir komutun yanıtsız kalabileceği süre, ms (varsayılan: en az 10000, 0 = kapalı)
REDIS_RECONNECT_MAX_DELAY=5000    # Yeniden bağlanma denemeleri arası en fazla bekleme, ms (varsayılan: 5000; önceden 30000)
REDIS_SCAN_COUNT=1000             # Prefix silmede SCAN başına incelenen anahtar sayısı (varsayılan: 1000; önceden 100)
```

v2.8.x davranışına dönmek ve değişikliklerin listesi için: [MIGRATION.md](MIGRATION.md#v28x--v290-performance--resilience)

v2.9.1 değişiklikleri (Node.js 14+, mysql2 3.23.1+, ESM/TypeScript import düzeltmeleri, cache
ayrıntıları): [MIGRATION.md](MIGRATION.md#v290--v291)

---

## 🔄 Geriye Dönük Uyumluluk

v2.5.3 kodunuz **hiçbir değişiklik olmadan** çalışmaya devam eder:

```javascript
await getCacheQuery('SELECT * FROM users', [], 'users_all');
await QuaryCache('INSERT INTO users...', [data], 'users_*');
```

Yeni sürümde `CORE_AUTO_FEATURES=true` ve `CORE_AUTO_INVALIDATION=true` yaparsanız:

```javascript
await getCacheQuery('SELECT * FROM users', []);  // Otomatik cache key (users:all) ✨
await QuaryCache('INSERT INTO users...', [data]); // Otomatik invalidation (users:* ve users_*) ✨
```

Bir yazmaya `resetCacheName` verirseniz o çağrıda otomatik desenlerin yerine geçer: yalnızca
`'users_*'` temizleyen eski yazmalar yeni `users:...` anahtarlarını silmez.

---

## 🧪 Test

```bash
npm ci
npm test
npm run coverage
```

---

## 📝 TypeScript Desteği

```typescript
import { getCacheQuery, withTransaction, type TransactionContext } from 'sqlcache';

interface User {
  id: number;
  name: string;
  email: string;
}

const users = await getCacheQuery<User>('SELECT * FROM users WHERE id = ?', [123], 'user:123'); // User[]

await withTransaction(async (tx: TransactionContext) => {
  const result = await tx.query<{ insertId: number }>('INSERT INTO users...', [data]);
  return result.insertId;
});
```

v2.9.1'den itibaren isimli import'lar native ESM'de de çalışır (`import { getCacheQuery } from
'sqlcache'`) ve `import sqlcache from 'sqlcache'` için `esModuleInterop` gerekmez. 2.9.0 ve öncesinde
native ESM'de varsayılan import'u (`import sqlcache from 'sqlcache'`) kullanın.

---

## ⚠️ Önemli Notlar

* Okuma ağırlıklı sistemler için idealdir
* Varsayılan TTL: 40.000 saniye (~11 saat); çağrı başına TTL yoktur
* Cache isabetleri JSON'dan döner: `Date` ISO metne, `Buffer` `{ type, data }` nesnesine dönüşür;
  cache'te bulunmayıp MySQL'den okunan sonuçlar ise mysql2 tiplerini taşır
* `REDIS_ENABLED=false` ile cache devre dışı bırakılabilir
* Transaction içinde kararı etkileyen okumalar için `tx.query()` kullanın: `tx.getCacheQuery()` önce
  cache'e bakar (v2.9.1'den itibaren okuduğunu yalnızca commit'ten sonra cache'e yazar)
* `bulkInsert` tablo adını ve ilk kaydın anahtarlarını (sütun adları) SQL'e olduğu gibi koyar:
  istek veya CSV verisini sabit bir sütun listesine eşleyin
* Çok kiracılı uygulamalarda kiracıyı oturumdan alıp izin listesiyle doğrulayın, `database`
  parametresini çağrı başına verin; `REDIS_VHOST` değerini istek başına değiştirmeyin
* Redis güvenilen bir depodur: AUTH ve özel ağ kullanın. `resetCacheName` / `delPrefixKeyItem`
  önekleri Redis glob desenidir; kullanıcı girdisindeki `* ? [ ] \` karakterlerini kaçırın
* mysql2 hataları parametre değerleri doldurulmuş `err.sql` içerir; hata nesnelerini güvenmediğiniz
  log'lara veya istemcilere göndermeyin

---

## 🤝 Katkıda Bulunma

Katkılar memnuniyetle karşılanır!
Ayrıntılar için [CONTRIBUTING.md](CONTRIBUTING.md) dosyasına göz atın.

---

## 📄 Lisans

MIT © [Hayati Ali Keleş](https://github.com/hayatialikeles)

---

**Node.js topluluğu için ❤️ ile üretildi.**

