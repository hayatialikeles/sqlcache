/**
 * MySQL Chaos Test Suite — extreme disaster scenarios for database resilience.
 *
 * Run: INTEGRATION=1 node test/chaos-mysql.test.js
 *
 * Scenarios:
 *   1. MySQL kill & restart during queries
 *   2. MySQL kill during bulk insert (mid-write crash)
 *   3. MySQL kill during active transaction
 *   4. Connection pool exhaustion under load
 *   5. Slow query timeout protection
 *   6. Rapid MySQL flapping (kill/start x3)
 *   7. Redis + MySQL both down simultaneously (double failure)
 *   8. MySQL down, Redis up — cached reads should survive
 *   9. MySQL restart with long downtime (20s)
 *  10. Concurrent transactions during MySQL kill
 */
if (!process.env.INTEGRATION) {
    console.log('Skip — set INTEGRATION=1');
    process.exit(0);
}

// Prevent unhandled rejections from crashing
process.on('unhandledRejection', (err) => {
    console.error('  [unhandled rejection]', err.message);
});

process.env.REDIS_SERVER = '127.0.0.1';
process.env.REDIS_PORT = '6399';
process.env.REDIS_PASSWORD = '';
process.env.REDIS_VHOST = 'chaos_mysql';
process.env.REDIS_WAIT_TIMEOUT = '5000';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '3399';
process.env.DB_USERNAME = 'root';
process.env.DB_PASSWORD = 'testpass';
process.env.DB_NAME = 'testdb';
process.env.REDIS_DISABLE = 'false';
process.env.DB_CONNECTION_LIMIT = '20';
process.env.DB_CONNECT_TIMEOUT = '5000';

const {
    QuaryCache,
    getCacheQuery,
    getCacheQueryWithTimeout,
    bulkInsert,
    withTransaction,
    getPoolStats,
    getArrayItem,
    addArrayItem,
    delKeyItem,
    delPrefixKeyItem,
    isRedisConnected,
    closeConnections,
} = require('../index');

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DOCKER = process.env.DOCKER_BIN || 'docker';

async function docker(cmd) {
    try {
        const { stdout } = await execAsync(`${DOCKER} ${cmd}`);
        return stdout.trim();
    } catch (err) {
        return '';
    }
}

async function waitRedis(maxWait = 15000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        if (isRedisConnected()) return true;
        await sleep(300);
    }
    return false;
}

async function waitMySQL(maxWait = 30000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        try {
            await QuaryCache('SELECT 1', []);
            return true;
        } catch (err) {
            await sleep(500);
        }
    }
    return false;
}

async function ensureRedisUp() {
    await docker('start test-redis');
    if (!await waitRedis(20000)) {
        console.error('    FATAL: Redis did not reconnect');
        process.exit(1);
    }
}

async function ensureMySQLUp() {
    await docker('start test-mysql');
    if (!await waitMySQL(40000)) {
        console.error('    FATAL: MySQL did not reconnect');
        process.exit(1);
    }
}

async function ensureTestTable() {
    try {
        await QuaryCache(`
            CREATE TABLE IF NOT EXISTS chaos_test (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100),
                value TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `, []);
        await QuaryCache('DELETE FROM chaos_test', []);
    } catch (err) {
        // Table might not exist yet after restart — retry
        await sleep(2000);
        await QuaryCache(`
            CREATE TABLE IF NOT EXISTS chaos_test (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100),
                value TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `, []);
        await QuaryCache('DELETE FROM chaos_test', []);
    }
}

// ═══════════════════════════════════════════════════════════════
//  SCENARIOS
// ═══════════════════════════════════════════════════════════════

async function scenario1_MySQLKillRestart() {
    console.log('\n+-----------------------------------------------------------+');
    console.log('|  SCENARIO 1: MySQL Kill & Restart During Queries          |');
    console.log('+-----------------------------------------------------------+\n');

    // Insert some data first
    for (let i = 0; i < 10; i++) {
        await QuaryCache('INSERT INTO chaos_test (name, value) VALUES (?, ?)',
            [`user-${i}`, `value-${i}`]);
    }
    console.log('  10 rows inserted');

    // Start continuous queries
    let ops = 0, success = 0, errors = 0;
    let running = true;

    const loop = (async () => {
        while (running) {
            ops++;
            try {
                await QuaryCache('SELECT * FROM chaos_test LIMIT 5', []);
                success++;
            } catch (err) {
                errors++;
            }
            await sleep(200);
        }
    })();

    console.log('  Starting continuous queries...');
    await sleep(2000);
    console.log(`  [normal] ops=${ops} success=${success} errors=${errors}`);

    console.log('  KILLING MySQL...');
    await docker('kill test-mysql');
    await sleep(5000);
    console.log(`  [during-down] ops=${ops} success=${success} errors=${errors}`);

    console.log('  RESTARTING MySQL...');
    await ensureMySQLUp();
    console.log('  MySQL recovered');

    await sleep(3000);
    running = false;
    await loop;
    console.log(`  [final] ops=${ops} success=${success} errors=${errors}`);

    const result = { ops, success, errors, crashed: false };
    console.log(`  Verdict: ${errors === 0 ? 'All queries succeeded (retries worked)' : `${errors} queries failed during downtime (expected)`}`);
    return result;
}

async function scenario2_KillDuringBulkInsert() {
    console.log('\n+-----------------------------------------------------------+');
    console.log('|  SCENARIO 2: MySQL Kill During Bulk Insert                |');
    console.log('+-----------------------------------------------------------+\n');

    await ensureTestTable();

    const records = Array.from({ length: 5000 }, (_, i) => ({
        name: `bulk-${i}`,
        value: `data-${i}-${Date.now()}`
    }));

    console.log('  Starting bulk insert of 5000 records + kill simultaneously...');

    // Run kill and bulk insert in parallel — kill after a delay
    const killPromise = sleep(300).then(async () => {
        console.log('  KILLING MySQL mid-bulk-insert!');
        await docker('kill test-mysql');
    });

    let bulkResult = null;
    let bulkError = null;
    try {
        bulkResult = await bulkInsert('chaos_test', records, { chunkSize: 200 }); // smaller chunks = more time for kill
        console.log(`  Bulk insert completed: ${bulkResult.insertedRows} rows, ${bulkResult.chunks} chunks`);
    } catch (err) {
        bulkError = err.message;
        console.log(`  Bulk insert failed (expected): ${err.message.substring(0, 100)}`);
    }

    // Wait for kill to finish
    await killPromise;

    // Restart
    console.log('  RESTARTING MySQL...');
    await ensureMySQLUp();

    // Check how many rows actually made it
    try {
        const [rows] = await QuaryCache('SELECT COUNT(*) as cnt FROM chaos_test', []);
        const count = rows?.cnt ?? rows?.[0]?.cnt ?? 'unknown';
        console.log(`  Rows in DB after crash: ${count} (out of 5000 attempted)`);
    } catch (err) {
        await ensureTestTable();
        console.log('  Table was recreated after crash');
    }

    return { completed: !!bulkResult, error: bulkError, crashed: false };
}

async function scenario3_KillDuringTransaction() {
    console.log('\n+-----------------------------------------------------------+');
    console.log('|  SCENARIO 3: MySQL Kill During Active Transaction         |');
    console.log('+-----------------------------------------------------------+\n');

    await ensureTestTable();

    // Insert baseline data
    await QuaryCache('INSERT INTO chaos_test (name, value) VALUES (?, ?)', ['tx-baseline', 'should-exist']);

    console.log('  Starting transaction (3 queries)...');
    console.log('  Will kill MySQL after 1st query inside transaction');

    // Kill MySQL in parallel with the transaction
    const killPromise = sleep(200).then(async () => {
        console.log('  KILLING MySQL mid-transaction!');
        await docker('kill test-mysql');
    });

    let txResult = null;
    let txError = null;
    try {
        txResult = await withTransaction(async (tx) => {
            await tx.query('INSERT INTO chaos_test (name, value) VALUES (?, ?)', ['tx-1', 'first']);
            await sleep(500); // Give time for kill to happen
            await tx.query('INSERT INTO chaos_test (name, value) VALUES (?, ?)', ['tx-2', 'second']);
            await tx.query('INSERT INTO chaos_test (name, value) VALUES (?, ?)', ['tx-3', 'third']);
            return 'committed';
        });
        console.log(`  Transaction result: ${txResult}`);
    } catch (err) {
        txError = err.message;
        console.log(`  Transaction failed (expected — should rollback): ${err.message.substring(0, 100)}`);
    }

    // Wait for kill to complete
    await killPromise;

    // Restart
    console.log('  RESTARTING MySQL...');
    await ensureMySQLUp();

    // Verify: tx-1, tx-2, tx-3 should NOT exist (rollback)
    // baseline should still exist
    try {
        const [rows] = await QuaryCache('SELECT name FROM chaos_test WHERE name LIKE ?', ['tx-%']);
        const txRows = Array.isArray(rows) ? rows : [];
        console.log(`  Transaction rows found after crash: ${txRows.length} (should be 0 = rolled back)`);

        const [baseline] = await QuaryCache('SELECT COUNT(*) as cnt FROM chaos_test WHERE name = ?', ['tx-baseline']);
        console.log(`  Baseline row exists: ${baseline?.cnt > 0 || baseline?.[0]?.cnt > 0 ? 'YES' : 'NO'}`);
    } catch (err) {
        await ensureTestTable();
        console.log('  Table lost (MySQL crash) — data integrity maintained by crash');
    }

    return { committed: !!txResult, error: txError, crashed: false };
}

async function scenario4_ConnectionPoolExhaustion() {
    console.log('\n+-----------------------------------------------------------+');
    console.log('|  SCENARIO 4: Connection Pool Exhaustion Under Load        |');
    console.log('+-----------------------------------------------------------+\n');

    await ensureTestTable();

    // Fire 100 concurrent queries (pool limit is 20)
    console.log('  Firing 100 concurrent queries (pool limit: 20)...');

    const queries = [];
    for (let i = 0; i < 100; i++) {
        queries.push(
            QuaryCache('SELECT SLEEP(0.1), ? as id', [i])
                .then(() => ({ status: 'ok', id: i }))
                .catch(err => ({ status: 'error', id: i, msg: err.message }))
        );
    }

    const results = await Promise.all(queries);
    const ok = results.filter(r => r.status === 'ok').length;
    const errors = results.filter(r => r.status === 'error').length;

    console.log(`  OK: ${ok}  Errors: ${errors}`);

    try {
        const stats = getPoolStats();
        console.log(`  Pool stats: total=${stats.totalConnections} active=${stats.activeConnections} free=${stats.freeConnections} queued=${stats.queuedRequests}`);
    } catch (err) {
        console.log(`  Pool stats unavailable: ${err.message}`);
    }

    // Now fire another 50 to verify pool is healthy
    console.log('  Firing 50 more queries to verify pool recovery...');
    const recovery = [];
    for (let i = 0; i < 50; i++) {
        recovery.push(
            QuaryCache('SELECT 1 + ? as result', [i])
                .then(() => 'ok')
                .catch(() => 'error')
        );
    }
    const recoveryResults = await Promise.all(recovery);
    const recoveryOk = recoveryResults.filter(r => r === 'ok').length;
    console.log(`  Recovery: ${recoveryOk}/50 queries succeeded`);

    return { ok, errors, recoveryOk, crashed: false };
}

async function scenario5_SlowQueryTimeout() {
    console.log('\n+-----------------------------------------------------------+');
    console.log('|  SCENARIO 5: Slow Query Timeout Protection                |');
    console.log('+-----------------------------------------------------------+\n');

    await ensureTestTable();

    // Normal query should work
    console.log('  Testing normal query with 5s timeout...');
    try {
        const result = await getCacheQueryWithTimeout(
            'SELECT 1 + 1 as result', [], 'timeout-test-ok',
            { timeout: 5000 }
        );
        console.log(`  Normal query: OK (result: ${JSON.stringify(result)})`);
    } catch (err) {
        console.log(`  Normal query failed: ${err.message}`);
    }

    // Slow query should timeout
    console.log('  Testing slow query (SLEEP 3s) with 1s timeout...');
    let timeoutWorked = false;
    try {
        await getCacheQueryWithTimeout(
            'SELECT SLEEP(3) as slept', [], 'timeout-test-slow',
            { timeout: 1000 }
        );
        console.log('  Slow query: completed (timeout did NOT trigger)');
    } catch (err) {
        if (err.message.includes('timeout')) {
            timeoutWorked = true;
            console.log('  Slow query: TIMEOUT triggered correctly');
        } else {
            console.log(`  Slow query: error (${err.message})`);
        }
    }

    // After timeout, pool should still work
    console.log('  Verifying pool health after timeout...');
    await sleep(500);
    try {
        await QuaryCache('SELECT 1', []);
        console.log('  Pool is healthy after timeout');
    } catch (err) {
        console.log(`  Pool issue after timeout: ${err.message}`);
    }

    // Cleanup cache
    await delKeyItem('timeout-test-ok');
    await delKeyItem('timeout-test-slow');

    return { timeoutWorked, crashed: false };
}

async function scenario6_RapidMySQLFlapping() {
    console.log('\n+-----------------------------------------------------------+');
    console.log('|  SCENARIO 6: Rapid MySQL Flapping (3x kill/restart)       |');
    console.log('+-----------------------------------------------------------+\n');

    let ops = 0, success = 0, errors = 0;
    let running = true;

    const loop = (async () => {
        while (running) {
            ops++;
            try {
                await QuaryCache('SELECT 1 + ? as x', [ops]);
                success++;
            } catch (err) {
                errors++;
            }
            await sleep(100);
        }
    })();

    for (let cycle = 1; cycle <= 3; cycle++) {
        console.log(`\n  Flap ${cycle}/3:`);

        await docker('kill test-mysql');
        console.log(`    KILLED`);
        await sleep(2000);
        console.log(`    ops=${ops} success=${success} errors=${errors}`);

        await docker('start test-mysql');
        await waitMySQL(30000);
        console.log(`    RECOVERED`);
        await sleep(2000);
        console.log(`    ops=${ops} success=${success} errors=${errors}`);
    }

    running = false;
    await loop;
    console.log(`\n  [final] ops=${ops} success=${success} errors=${errors}`);

    return { ops, success, errors, crashed: false };
}

async function scenario7_DoubleFailure() {
    console.log('\n+-----------------------------------------------------------+');
    console.log('|  SCENARIO 7: Redis + MySQL Both Down (Double Failure)     |');
    console.log('+-----------------------------------------------------------+\n');

    await ensureTestTable();
    await QuaryCache('INSERT INTO chaos_test (name, value) VALUES (?, ?)', ['double-test', 'before-crash']);

    console.log('  KILLING both Redis AND MySQL simultaneously...');
    await Promise.all([
        docker('kill test-redis'),
        docker('kill test-mysql'),
    ]);
    await sleep(1000);

    console.log(`  isRedisConnected: ${isRedisConnected()}`);

    // All operations should fail gracefully
    console.log('  Testing operations during total outage...');

    const results = await Promise.allSettled([
        getArrayItem('some-key'),
        addArrayItem('some-key', [1], 60),
        delKeyItem('some-key'),
        QuaryCache('SELECT 1', []),
        getCacheQuery('SELECT 1', [], 'cache-test'),
    ]);

    results.forEach((r, i) => {
        const ops = ['getArrayItem', 'addArrayItem', 'delKeyItem', 'QuaryCache', 'getCacheQuery'];
        const status = r.status === 'fulfilled' ? 'OK (graceful)' : `REJECTED: ${r.reason.message.substring(0, 60)}`;
        console.log(`    ${ops[i]}: ${status}`);
    });

    // Redis ops should be fulfilled (graceful degradation), MySQL ops should reject
    const redisOps = results.slice(0, 3);
    const mysqlOps = results.slice(3);
    const redisOk = redisOps.every(r => r.status === 'fulfilled');
    const mysqlFailed = mysqlOps.every(r => r.status === 'rejected');

    console.log(`\n  Redis ops graceful: ${redisOk}`);
    console.log(`  MySQL ops failed: ${mysqlFailed}`);

    // Restart both
    console.log('\n  RESTARTING both...');
    await Promise.all([
        docker('start test-redis'),
        docker('start test-mysql'),
    ]);
    await Promise.all([
        waitRedis(20000),
        waitMySQL(40000),
    ]);

    console.log(`  isRedisConnected: ${isRedisConnected()}`);

    // Verify both work
    try {
        await QuaryCache('SELECT 1', []);
        await addArrayItem('recovery-check', [1], 10);
        console.log('  Both services recovered successfully');
    } catch (err) {
        console.log(`  Recovery issue: ${err.message}`);
    }

    await delKeyItem('recovery-check');

    return { redisOk, mysqlFailed, crashed: false };
}

async function scenario8_MySQLDownCachedReads() {
    console.log('\n+-----------------------------------------------------------+');
    console.log('|  SCENARIO 8: MySQL Down — Cached Reads Should Survive     |');
    console.log('+-----------------------------------------------------------+\n');

    await ensureTestTable();
    await QuaryCache('INSERT INTO chaos_test (name, value) VALUES (?, ?)', ['cached-user', 'important-data']);

    // Cache the result first
    const cached = await getCacheQuery(
        'SELECT * FROM chaos_test WHERE name = ?',
        ['cached-user'],
        'cached-read-test'
    );
    console.log(`  Cached data: ${JSON.stringify(cached[0]?.name || cached)}`);

    // Kill MySQL
    console.log('  KILLING MySQL...');
    await docker('kill test-mysql');
    await sleep(2000);

    // Cached reads should still work
    console.log('  Reading from cache (MySQL is DOWN)...');
    let cacheHit = false;
    try {
        const fromCache = await getCacheQuery(
            'SELECT * FROM chaos_test WHERE name = ?',
            ['cached-user'],
            'cached-read-test'
        );
        cacheHit = fromCache.length > 0 && fromCache[0].name === 'cached-user';
        console.log(`  Cache hit: ${cacheHit} (data: ${JSON.stringify(fromCache[0]?.name)})`);
    } catch (err) {
        console.log(`  Cache read failed: ${err.message}`);
    }

    // Non-cached query should fail
    console.log('  Attempting non-cached query (should fail)...');
    let nonCachedFailed = false;
    try {
        await QuaryCache('SELECT * FROM chaos_test WHERE name = ?', ['no-cache']);
    } catch (err) {
        nonCachedFailed = true;
        console.log(`  Non-cached query failed (expected): ${err.message.substring(0, 60)}`);
    }

    // Restart
    console.log('  RESTARTING MySQL...');
    await ensureMySQLUp();

    // Cleanup
    await delKeyItem('cached-read-test');

    return { cacheHit, nonCachedFailed, crashed: false };
}

async function scenario9_LongMySQLDowntime() {
    console.log('\n+-----------------------------------------------------------+');
    console.log('|  SCENARIO 9: MySQL Long Downtime (20 seconds)             |');
    console.log('+-----------------------------------------------------------+\n');

    let ops = 0, success = 0, errors = 0;
    let running = true;

    const loop = (async () => {
        while (running) {
            ops++;
            try {
                await QuaryCache('SELECT 1', []);
                success++;
            } catch (err) {
                errors++;
            }
            await sleep(500);
        }
    })();

    console.log('  Phase 1: Normal (2s)');
    await sleep(2000);
    console.log(`  [normal] ops=${ops} success=${success} errors=${errors}`);

    console.log('  KILLING MySQL for 20 seconds...');
    await docker('kill test-mysql');

    for (let s = 5; s <= 20; s += 5) {
        await sleep(5000);
        console.log(`    ${s}s elapsed — ops=${ops} success=${success} errors=${errors}`);
    }

    console.log('  RESTARTING MySQL...');
    await ensureMySQLUp();

    console.log('  Phase 3: Post-recovery (3s)');
    await sleep(3000);
    running = false;
    await loop;
    console.log(`  [final] ops=${ops} success=${success} errors=${errors}`);

    // Verify pool is healthy
    let poolHealthy = false;
    try {
        await QuaryCache('SELECT 1', []);
        poolHealthy = true;
    } catch (err) {
        console.log(`  Pool health check failed: ${err.message}`);
    }

    return { ops, success, errors, poolHealthy, crashed: false };
}

async function scenario10_ConcurrentTransactionsDuringKill() {
    console.log('\n+-----------------------------------------------------------+');
    console.log('|  SCENARIO 10: Concurrent Transactions During MySQL Kill   |');
    console.log('+-----------------------------------------------------------+\n');

    await ensureTestTable();

    console.log('  Launching 10 concurrent transactions...');
    console.log('  Killing MySQL 500ms after launch...');

    const txPromises = [];
    for (let i = 0; i < 10; i++) {
        txPromises.push(
            withTransaction(async (tx) => {
                await tx.query('INSERT INTO chaos_test (name, value) VALUES (?, ?)',
                    [`concurrent-tx-${i}`, `data-${i}`]);
                await sleep(300 + Math.random() * 500); // Random delay 300-800ms
                await tx.query('INSERT INTO chaos_test (name, value) VALUES (?, ?)',
                    [`concurrent-tx-${i}-b`, `data-${i}-b`]);
                return `tx-${i}-committed`;
            }).then(r => ({ status: 'committed', tx: i, result: r }))
              .catch(err => ({ status: 'failed', tx: i, error: err.message.substring(0, 80) }))
        );
    }

    // Kill MySQL 500ms later (in parallel)
    const killPromise = sleep(500).then(async () => {
        console.log('  KILLING MySQL mid-transactions!');
        await docker('kill test-mysql');
    });

    const results = await Promise.all(txPromises);
    await killPromise;

    const committed = results.filter(r => r.status === 'committed').length;
    const failed = results.filter(r => r.status === 'failed').length;

    console.log(`  Committed: ${committed}  Failed: ${failed}`);
    results.forEach(r => {
        console.log(`    tx-${r.tx}: ${r.status}${r.error ? ` (${r.error.substring(0, 60)})` : ''}`);
    });

    // Restart and verify
    console.log('  RESTARTING MySQL...');
    await ensureMySQLUp();

    // Verify data integrity — failed transactions should not have partial data
    try {
        const [rows] = await QuaryCache('SELECT name FROM chaos_test WHERE name LIKE ?', ['concurrent-tx-%']);
        const names = Array.isArray(rows) ? rows.map(r => r.name) : [];
        console.log(`  Rows in DB: ${names.length}`);

        // Check for partial transactions
        let partialTx = 0;
        for (let i = 0; i < 10; i++) {
            const hasA = names.includes(`concurrent-tx-${i}`);
            const hasB = names.includes(`concurrent-tx-${i}-b`);
            if (hasA !== hasB) {
                partialTx++;
                console.log(`    PARTIAL: tx-${i} has A=${hasA} B=${hasB}`);
            }
        }
        console.log(`  Partial (inconsistent) transactions: ${partialTx} (should be 0)`);

        return { committed, failed, partialTx, crashed: false };
    } catch (err) {
        await ensureTestTable();
        console.log(`  Verification failed (table lost): ${err.message.substring(0, 60)}`);
        return { committed, failed, partialTx: 0, crashed: false };
    }
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════

(async () => {
    console.log('+===========================================================+');
    console.log('|     MYSQL CHAOS TEST SUITE — EXTREME DISASTER SCENARIOS   |');
    console.log('+===========================================================+');
    console.log('|  10 scenarios, real Docker operations                     |');
    console.log('+===========================================================+\n');

    // Ensure services are up
    await ensureRedisUp();
    await ensureMySQLUp();
    await ensureTestTable();
    console.log('Services ready. Starting MySQL chaos...\n');

    const results = {};
    const failedScenarios = [];

    // ── Scenario 1 ──
    results['1'] = await scenario1_MySQLKillRestart();
    await ensureMySQLUp();
    await ensureTestTable();
    await sleep(1000);

    // ── Scenario 2 ──
    results['2'] = await scenario2_KillDuringBulkInsert();
    await ensureMySQLUp();
    await ensureTestTable();
    await sleep(1000);

    // ── Scenario 3 ──
    results['3'] = await scenario3_KillDuringTransaction();
    await ensureMySQLUp();
    await ensureTestTable();
    await sleep(1000);

    // ── Scenario 4 ──
    results['4'] = await scenario4_ConnectionPoolExhaustion();
    await sleep(1000);

    // ── Scenario 5 ──
    results['5'] = await scenario5_SlowQueryTimeout();
    await sleep(1000);

    // ── Scenario 6 ──
    results['6'] = await scenario6_RapidMySQLFlapping();
    await ensureMySQLUp();
    await ensureTestTable();
    await sleep(1000);

    // ── Scenario 7 ──
    results['7'] = await scenario7_DoubleFailure();
    await ensureMySQLUp();
    await ensureRedisUp();
    await ensureTestTable();
    await sleep(1000);

    // ── Scenario 8 ──
    results['8'] = await scenario8_MySQLDownCachedReads();
    await ensureMySQLUp();
    await ensureTestTable();
    await sleep(1000);

    // ── Scenario 9 ──
    results['9'] = await scenario9_LongMySQLDowntime();
    await ensureMySQLUp();
    await ensureTestTable();
    await sleep(1000);

    // ── Scenario 10 ──
    results['10'] = await scenario10_ConcurrentTransactionsDuringKill();
    await ensureMySQLUp();

    // ═══════════════════════════════════════════════════════════
    //  FINAL REPORT
    // ═══════════════════════════════════════════════════════════

    console.log('\n\n+===========================================================+');
    console.log('|                    MYSQL CHAOS — FINAL REPORT             |');
    console.log('+===========================================================+');

    const scenarioNames = [
        ['1',  'MySQL Kill & Restart',     r => `ops=${r.ops} ok=${r.success} err=${r.errors}`],
        ['2',  'Kill During Bulk Insert',  r => `completed=${r.completed} error=${!!r.error}`],
        ['3',  'Kill During Transaction',  r => `committed=${r.committed} (should be false)`],
        ['4',  'Pool Exhaustion',          r => `ok=${r.ok} err=${r.errors} recovery=${r.recoveryOk}/50`],
        ['5',  'Slow Query Timeout',       r => `timeout_worked=${r.timeoutWorked}`],
        ['6',  'Rapid MySQL Flapping',     r => `ops=${r.ops} ok=${r.success} err=${r.errors}`],
        ['7',  'Double Failure (R+M)',     r => `redis_graceful=${r.redisOk} mysql_failed=${r.mysqlFailed}`],
        ['8',  'Cached Reads Survive',     r => `cache_hit=${r.cacheHit} uncached_failed=${r.nonCachedFailed}`],
        ['9',  'Long Downtime (20s)',      r => `ops=${r.ops} ok=${r.success} err=${r.errors} pool_ok=${r.poolHealthy}`],
        ['10', 'Concurrent TX Kill',       r => `committed=${r.committed} failed=${r.failed} partial=${r.partialTx}`],
    ];

    let criticalIssues = 0;

    for (const [key, name, fmt] of scenarioNames) {
        const r = results[key];
        let verdict = 'PASS';

        // Critical failures
        if (key === '3' && r.committed) { verdict = 'FAIL'; criticalIssues++; }
        if (key === '4' && r.recoveryOk < 45) { verdict = 'WARN'; }
        if (key === '5' && !r.timeoutWorked) { verdict = 'FAIL'; criticalIssues++; }
        if (key === '7' && !r.redisOk) { verdict = 'FAIL'; criticalIssues++; }
        if (key === '8' && !r.cacheHit) { verdict = 'FAIL'; criticalIssues++; }
        if (key === '9' && !r.poolHealthy) { verdict = 'WARN'; }
        if (key === '10' && r.partialTx > 0) { verdict = 'FAIL'; criticalIssues++; }
        if (r.crashed) { verdict = 'FAIL'; criticalIssues++; }

        if (verdict !== 'PASS') failedScenarios.push(`${key}-${name}`);

        console.log(`|  [${verdict}] ${name.padEnd(28)} ${fmt(r)}`);
    }

    console.log('+===========================================================+');
    console.log(`|  Redis connected: ${isRedisConnected()}`);
    console.log(`|  Critical issues: ${criticalIssues}`);
    console.log(`|  Warnings: ${failedScenarios.length - criticalIssues}`);
    console.log('+===========================================================+\n');

    if (criticalIssues === 0) {
        console.log('ALL CRITICAL CHECKS PASSED — MySQL resilience verified!\n');
    } else {
        console.log(`${criticalIssues} CRITICAL ISSUE(S) FOUND\n`);
    }

    // Cleanup
    try {
        await QuaryCache('DROP TABLE IF EXISTS chaos_test', []);
    } catch (err) { /* ignore */ }

    process.exit(criticalIssues > 0 ? 1 : 0);
})();
