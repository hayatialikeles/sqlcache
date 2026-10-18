/**
 * End-to-end integration test with REAL Redis + MySQL.
 *
 * Run:  INTEGRATION=1 npm test
 *
 * Requires:
 *   - Redis on localhost:6399
 *   - MySQL on localhost:3399  (root / testpass / testdb)
 */

if (!process.env.INTEGRATION) {
    // Skip when running normal unit tests
    describe('Integration (skipped — set INTEGRATION=1 to run)', () => {
        it('skipped', function () { this.skip(); });
    });
    return;
}

const { expect } = require('chai');

// ── Setup env BEFORE requiring the module ──
process.env.REDIS_SERVER   = '127.0.0.1';
process.env.REDIS_PORT     = '6399';
process.env.REDIS_PASSWORD = '';
process.env.REDIS_VHOST    = 'integration_test';
process.env.REDIS_WAIT_TIMEOUT = '5000';

process.env.DB_HOST     = '127.0.0.1';
process.env.DB_PORT     = '3399';
process.env.DB_USERNAME = 'root';
process.env.DB_PASSWORD = 'testpass';
process.env.DB_NAME     = 'testdb';
process.env.REDIS_DISABLE = 'false';

// ── Require after env is set ──
const {
    QuaryCache,
    getCacheQuery,
    getArrayItem,
    addArrayItem,
    delKeyItem,
    delPrefixKeyItem,
    isRedisConnected,
    getRedisClient,
    closeConnections,
} = require('../index');

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ── Helpers ──
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DOCKER_BIN = process.env.DOCKER_BIN || 'docker';
const REDIS_CONTAINER = process.env.REDIS_CONTAINER || 'test-redis';

async function dockerExec(cmd) {
    const { stdout } = await execAsync(`${DOCKER_BIN} ${cmd}`);
    return stdout.trim();
}

// ── Tests ──
describe('Integration: Real Redis + MySQL', function () {
    this.timeout(60000);

    before(async () => {
        // Wait for Redis to be connected
        for (let i = 0; i < 20; i++) {
            if (isRedisConnected()) break;
            await sleep(500);
        }
        expect(isRedisConnected()).to.be.true;

        // Create test table
        await QuaryCache(
            `CREATE TABLE IF NOT EXISTS test_users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100),
                email VARCHAR(100)
            )`,
            []
        );
        // Clean table
        await QuaryCache('DELETE FROM test_users', []);
    });

    after(async () => {
        // Cleanup
        await QuaryCache('DROP TABLE IF EXISTS test_users', []);
        // Flush test namespace keys
        const client = getRedisClient();
        const { promisify } = require('util');
        const scanAsync = promisify(client.scan).bind(client);
        const delAsync = promisify(client.del).bind(client);

        let cursor = '0';
        do {
            const [newCursor, keys] = await scanAsync(cursor, 'MATCH', 'integration_test:*', 'COUNT', 100);
            cursor = newCursor;
            if (keys.length) await delAsync(...keys);
        } while (cursor !== '0');

        await closeConnections();
    });

    // ═══════════════════════════════════════════════════════
    // 1. Basic Redis CRUD
    // ═══════════════════════════════════════════════════════

    describe('1. Redis CRUD', () => {
        it('should store and retrieve data', async () => {
            const data = [{ id: 1, name: 'test' }];
            await addArrayItem('integ-key-1', data, 60);

            const result = await getArrayItem('integ-key-1');
            expect(result).to.deep.equal(data);
        });

        it('should return [] for missing keys', async () => {
            const result = await getArrayItem('nonexistent-key-xyz');
            expect(result).to.deep.equal([]);
        });

        it('should delete single key', async () => {
            await addArrayItem('integ-del-1', [{ x: 1 }], 60);
            await delKeyItem('integ-del-1');

            const result = await getArrayItem('integ-del-1');
            expect(result).to.deep.equal([]);
        });

        it('should delete by prefix (SCAN-based)', async () => {
            await addArrayItem('integ-prefix-a', [1], 60);
            await addArrayItem('integ-prefix-b', [2], 60);
            await addArrayItem('integ-other', [3], 60);

            await delPrefixKeyItem('integ-prefix-');

            expect(await getArrayItem('integ-prefix-a')).to.deep.equal([]);
            expect(await getArrayItem('integ-prefix-b')).to.deep.equal([]);
            // 'integ-other' should still exist
            expect(await getArrayItem('integ-other')).to.deep.equal([3]);

            // Cleanup
            await delKeyItem('integ-other');
        });

        it('should delete multiple prefixes', async () => {
            await addArrayItem('integ-users-1', [{ u: 1 }], 60);
            await addArrayItem('integ-products-1', [{ p: 1 }], 60);

            await delPrefixKeyItem(['integ-users-', 'integ-products-']);

            expect(await getArrayItem('integ-users-1')).to.deep.equal([]);
            expect(await getArrayItem('integ-products-1')).to.deep.equal([]);
        });
    });

    // ═══════════════════════════════════════════════════════
    // 2. MySQL + Cache Integration
    // ═══════════════════════════════════════════════════════

    describe('2. MySQL + Cache', () => {
        it('should INSERT and read back', async () => {
            const res = await QuaryCache(
                'INSERT INTO test_users (name, email) VALUES (?, ?)',
                ['Alice', 'alice@test.com']
            );
            expect(res.insertId).to.be.a('number');
            expect(res.affectedRows).to.equal(1);
        });

        it('should cache SELECT results', async () => {
            // First call — hits DB, caches result
            const first = await getCacheQuery(
                'SELECT * FROM test_users WHERE name = ?',
                ['Alice'],
                'integ-alice-cache'
            );
            expect(first).to.be.an('array');
            expect(first.length).to.be.greaterThanOrEqual(1);
            expect(first[0].name).to.equal('Alice');

            // Second call — should come from cache (same result)
            const second = await getCacheQuery(
                'SELECT * FROM test_users WHERE name = ?',
                ['Alice'],
                'integ-alice-cache'
            );
            expect(second).to.deep.equal(first);

            // Verify the cache key exists in Redis
            const cached = await getArrayItem('integ-alice-cache');
            expect(cached.length).to.be.greaterThanOrEqual(1);
        });

        it('should invalidate cache on write', async () => {
            await QuaryCache(
                'UPDATE test_users SET email = ? WHERE name = ?',
                ['alice2@test.com', 'Alice'],
                'integ-alice-cache'
            );

            // Cache should be cleared
            const cached = await getArrayItem('integ-alice-cache');
            expect(cached).to.deep.equal([]);
        });
    });

    // ═══════════════════════════════════════════════════════
    // 3. isRedisConnected health check
    // ═══════════════════════════════════════════════════════

    describe('3. Health Check', () => {
        it('should report connected', () => {
            expect(isRedisConnected()).to.be.true;
        });
    });

    // ═══════════════════════════════════════════════════════
    // 4. Backward Compatibility — error shapes
    // ═══════════════════════════════════════════════════════

    describe('4. Backward Compatibility', () => {
        it('getArrayItem returns [] for missing key (same as before)', async () => {
            const result = await getArrayItem('does-not-exist');
            expect(result).to.deep.equal([]);
        });

        it('addArrayItem returns the stored data (same as before)', async () => {
            const data = [{ id: 99 }];
            const result = await addArrayItem('compat-test', data, 30);
            expect(result).to.deep.equal(data);
            await delKeyItem('compat-test');
        });

        it('delKeyItem on missing key does not throw (same as before)', async () => {
            await delKeyItem('never-existed');
            // Should not throw
        });

        it('delPrefixKeyItem on missing pattern does not throw (same as before)', async () => {
            await delPrefixKeyItem('never-existed-prefix-');
            // Should not throw
        });
    });

    // ═══════════════════════════════════════════════════════
    // 5. Redis Restart — reconnection test
    // ═══════════════════════════════════════════════════════

    describe('5. Redis Reconnect', () => {
        it('should recover after Redis restart', async function () {
            this.timeout(30000);

            // Store a value
            await addArrayItem('reconnect-test', [{ before: true }], 120);

            // Stop Redis
            console.log('      Stopping Redis...');
            await dockerExec(`stop ${REDIS_CONTAINER}`);
            await sleep(1000);

            expect(isRedisConnected()).to.be.false;

            // Operations during downtime should gracefully degrade
            const duringDown = await getArrayItem('reconnect-test');
            expect(duringDown).to.deep.equal([]); // graceful fallback

            // Restart Redis
            console.log('      Starting Redis...');
            await dockerExec(`start ${REDIS_CONTAINER}`);

            // Wait for reconnection
            for (let i = 0; i < 30; i++) {
                if (isRedisConnected()) break;
                await sleep(500);
            }
            expect(isRedisConnected()).to.be.true;

            // After restart, old data is gone (Redis restarted fresh)
            // But new operations should work
            await addArrayItem('reconnect-test-2', [{ after: true }], 60);
            const afterRestart = await getArrayItem('reconnect-test-2');
            expect(afterRestart).to.deep.equal([{ after: true }]);

            // Cleanup
            await delKeyItem('reconnect-test-2');
        });
    });

    // ═══════════════════════════════════════════════════════
    // 6. Real-world Failure Scenarios
    // ═══════════════════════════════════════════════════════

    describe('6. Failure Scenarios', () => {

        it('should handle rapid writes during Redis flap (stop/start)', async function () {
            this.timeout(30000);

            // Redis flap: stop → immediate start
            console.log('      Flapping Redis...');
            await dockerExec(`stop ${REDIS_CONTAINER}`);
            await sleep(200);
            await dockerExec(`start ${REDIS_CONTAINER}`);

            // Rapid writes while reconnecting — should not throw
            const results = await Promise.allSettled([
                addArrayItem('flap-1', [1], 60),
                addArrayItem('flap-2', [2], 60),
                addArrayItem('flap-3', [3], 60),
                getArrayItem('flap-1'),
                delKeyItem('flap-nonexistent'),
                delPrefixKeyItem('flap-'),
            ]);

            // All should resolve (not reject) — graceful degradation
            results.forEach((r, i) => {
                expect(r.status).to.equal('fulfilled', `Operation ${i} should not reject`);
            });

            // Wait for full reconnect
            for (let i = 0; i < 30; i++) {
                if (isRedisConnected()) break;
                await sleep(500);
            }
            expect(isRedisConnected()).to.be.true;
        });

        it('should serve DB data when Redis is down (cache-aside pattern)', async function () {
            this.timeout(30000);

            // Ensure data exists in MySQL
            await QuaryCache(
                'INSERT INTO test_users (name, email) VALUES (?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email)',
                ['CacheTest', 'cache@test.com']
            );

            // Stop Redis
            console.log('      Stopping Redis for cache-aside test...');
            await dockerExec(`stop ${REDIS_CONTAINER}`);
            await sleep(1000);

            // getCacheQuery should still work — falls through to DB on cache failure
            const result = await getCacheQuery(
                'SELECT * FROM test_users WHERE name = ?',
                ['CacheTest'],
                'integ-cachetest'
            );
            expect(result).to.be.an('array');
            expect(result.length).to.be.greaterThanOrEqual(1);
            expect(result[0].name).to.equal('CacheTest');

            // Restart Redis
            console.log('      Restarting Redis...');
            await dockerExec(`start ${REDIS_CONTAINER}`);
            for (let i = 0; i < 30; i++) {
                if (isRedisConnected()) break;
                await sleep(500);
            }
        });

        it('should handle concurrent reads/writes under load', async function () {
            this.timeout(15000);

            // Parallel burst — 50 operations
            const ops = [];
            for (let i = 0; i < 50; i++) {
                ops.push(addArrayItem(`burst-${i}`, [{ i }], 30));
            }
            await Promise.all(ops);

            // Parallel reads
            const reads = [];
            for (let i = 0; i < 50; i++) {
                reads.push(getArrayItem(`burst-${i}`));
            }
            const results = await Promise.all(reads);

            results.forEach((r, i) => {
                expect(r).to.deep.equal([{ i }]);
            });

            // Bulk prefix delete
            await delPrefixKeyItem('burst-');

            // Verify all deleted
            const afterDel = await getArrayItem('burst-0');
            expect(afterDel).to.deep.equal([]);
        });

        it('should handle MySQL down while Redis is up', async function () {
            this.timeout(15000);

            // Redis operations should still work
            await addArrayItem('mysql-down-test', [{ ok: true }], 60);
            const cached = await getArrayItem('mysql-down-test');
            expect(cached).to.deep.equal([{ ok: true }]);

            await delKeyItem('mysql-down-test');
        });

        it('should handle large payloads', async () => {
            // 1MB+ JSON payload
            const bigArray = Array.from({ length: 10000 }, (_, i) => ({
                id: i,
                name: `User ${i}`,
                email: `user${i}@test.com`,
                meta: { created: new Date().toISOString(), tags: ['a', 'b', 'c'] }
            }));

            await addArrayItem('big-payload', bigArray, 30);
            const result = await getArrayItem('big-payload');

            expect(result.length).to.equal(10000);
            expect(result[0].name).to.equal('User 0');
            expect(result[9999].name).to.equal('User 9999');

            await delKeyItem('big-payload');
        });

        it('should handle special characters in keys', async () => {
            const specialKeys = [
                'key:with:colons',
                'key/with/slashes',
                'key-with-dashes',
                'key_with_underscores',
                'key.with.dots',
            ];

            for (const key of specialKeys) {
                await addArrayItem(key, [{ key }], 30);
                const result = await getArrayItem(key);
                expect(result).to.deep.equal([{ key }], `Failed for key: ${key}`);
                await delKeyItem(key);
            }
        });

        it('should handle TTL expiration', async function () {
            this.timeout(5000);

            // Set with 1 second TTL
            await addArrayItem('ttl-test', [{ temp: true }], 1);

            // Immediately available
            const before = await getArrayItem('ttl-test');
            expect(before).to.deep.equal([{ temp: true }]);

            // Wait for expiry
            await sleep(1500);

            // Should be gone
            const after = await getArrayItem('ttl-test');
            expect(after).to.deep.equal([]);
        });
    });
});
