/**
 * Chaos test suite — extreme disaster scenarios for Redis resilience.
 *
 * Run: INTEGRATION=1 node test/chaos.test.js
 *
 * Scenarios:
 *   1. Basic kill & restart (single outage)
 *   2. Rapid flapping (kill → start → kill → start x5)
 *   3. Long outage (30 seconds down)
 *   4. Kill during bulk write burst (1000 concurrent ops)
 *   5. Kill during SCAN-based prefix delete (mid-operation crash)
 *   6. Thundering herd after recovery (200 concurrent ops hit at once)
 *   7. Multiple kills with increasing downtime (1s, 5s, 15s)
 *   8. Network partition simulation (pause/unpause container)
 */
if (!process.env.INTEGRATION) {
    console.log('Skip — set INTEGRATION=1');
    process.exit(0);
}

process.env.REDIS_SERVER = '127.0.0.1';
process.env.REDIS_PORT = '6399';
process.env.REDIS_PASSWORD = '';
process.env.REDIS_VHOST = 'chaos';
process.env.REDIS_WAIT_TIMEOUT = '5000';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '3399';
process.env.DB_USERNAME = 'root';
process.env.DB_PASSWORD = 'testpass';
process.env.DB_NAME = 'testdb';
process.env.REDIS_DISABLE = 'false';

const {
    getArrayItem,
    addArrayItem,
    delKeyItem,
    delPrefixKeyItem,
    isRedisConnected,
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
        // Docker command failed (container already stopped, etc.)
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

async function ensureRedisUp() {
    await docker('start test-redis');
    if (!await waitRedis(20000)) {
        console.error('    FATAL: Redis did not reconnect');
        process.exit(1);
    }
}

function stats(label, counters) {
    const { ops, success, fallback, errors } = counters;
    console.log(`      [${label}] ops=${ops} success=${success} fallback=${fallback} errors=${errors}`);
}

// ── Continuous ops engine ──
function createOpsEngine(prefix, delayMs = 50) {
    const counters = { ops: 0, success: 0, fallback: 0, errors: 0 };
    let running = true;

    const loop = (async () => {
        while (running) {
            counters.ops++;
            const id = counters.ops;
            try {
                const data = [{ op: id, ts: Date.now() }];
                await addArrayItem(`${prefix}-${id}`, data, 120);

                const result = await getArrayItem(`${prefix}-${id}`);
                if (result.length > 0 && result[0].op === id) {
                    counters.success++;
                } else {
                    counters.fallback++;
                }

                await delKeyItem(`${prefix}-${id}`);
            } catch (err) {
                counters.errors++;
                console.error(`    [ERROR] ${prefix} op ${id}: ${err.message}`);
            }
            await sleep(delayMs);
        }
    })();

    return {
        counters,
        stop: async () => { running = false; await loop; }
    };
}

// ═══════════════════════════════════════════════════════════════
//  SCENARIOS
// ═══════════════════════════════════════════════════════════════

async function scenario1_BasicKillRestart() {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║  SCENARIO 1: Basic Kill & Restart (5s downtime)          ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    const engine = createOpsEngine('s1', 100);

    console.log('  Phase 1: Normal (2s)');
    await sleep(2000);
    stats('normal', engine.counters);

    console.log('  Phase 2: KILL Redis');
    await docker('kill test-redis');
    await sleep(5000);
    stats('during-down', engine.counters);

    console.log('  Phase 3: RESTART Redis');
    await ensureRedisUp();
    console.log(`    isRedisConnected: ${isRedisConnected()}`);

    console.log('  Phase 4: Post-recovery (2s)');
    await sleep(2000);
    stats('recovered', engine.counters);

    await engine.stop();
    return engine.counters;
}

async function scenario2_RapidFlapping() {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║  SCENARIO 2: Rapid Flapping (5x kill/restart in 20s)     ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    const engine = createOpsEngine('s2', 30); // faster ops

    console.log('  Starting rapid flap cycle...');
    for (let cycle = 1; cycle <= 5; cycle++) {
        console.log(`\n  Flap ${cycle}/5:`);

        await docker('kill test-redis');
        console.log(`    KILLED  — isConnected: ${isRedisConnected()}`);
        await sleep(800 + Math.random() * 400); // 0.8-1.2s down

        await docker('start test-redis');
        await sleep(1500); // partial recovery time
        console.log(`    STARTED — isConnected: ${isRedisConnected()}`);

        stats(`flap-${cycle}`, engine.counters);
    }

    // Final recovery
    console.log('\n  Waiting for full recovery...');
    await ensureRedisUp();
    await sleep(2000);
    stats('final', engine.counters);

    await engine.stop();
    return engine.counters;
}

async function scenario3_LongOutage() {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║  SCENARIO 3: Long Outage (30 seconds down)               ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    const engine = createOpsEngine('s3', 200);

    console.log('  Phase 1: Normal (2s)');
    await sleep(2000);
    stats('normal', engine.counters);

    console.log('  Phase 2: KILL Redis — 30 second outage starting...');
    await docker('kill test-redis');

    for (let s = 5; s <= 30; s += 5) {
        await sleep(5000);
        console.log(`    ${s}s elapsed — isConnected: ${isRedisConnected()}`);
        stats(`${s}s-down`, engine.counters);
    }

    console.log('  Phase 3: RESTART after 30s outage');
    await ensureRedisUp();
    console.log(`    isRedisConnected: ${isRedisConnected()}`);

    console.log('  Phase 4: Post-recovery (3s)');
    await sleep(3000);
    stats('recovered', engine.counters);

    await engine.stop();
    return engine.counters;
}

async function scenario4_KillDuringBulkWrite() {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║  SCENARIO 4: Kill During Bulk Write (1000 concurrent)    ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    // Fire 1000 writes, kill Redis 50ms after launch
    console.log('  Launching 1000 concurrent writes...');

    const writePromises = [];
    for (let i = 0; i < 1000; i++) {
        writePromises.push(
            addArrayItem(`bulk-${i}`, [{ i, ts: Date.now() }], 120)
        );
    }

    // Kill Redis while writes are in-flight
    setTimeout(async () => {
        console.log('  KILLING Redis mid-bulk-write!');
        await docker('kill test-redis');
    }, 50);

    console.log('  Waiting for all 1000 writes to settle...');
    const results = await Promise.allSettled(writePromises);

    const fulfilled = results.filter(r => r.status === 'fulfilled').length;
    const rejected = results.filter(r => r.status === 'rejected').length;

    console.log(`    Fulfilled: ${fulfilled}`);
    console.log(`    Rejected:  ${rejected}`);

    // Restart
    console.log('  RESTART Redis');
    await ensureRedisUp();

    // Verify some reads work after recovery
    let readSuccess = 0;
    const readPromises = [];
    for (let i = 0; i < 100; i++) {
        readPromises.push(getArrayItem(`bulk-${i}`));
    }
    const readResults = await Promise.all(readPromises);
    readResults.forEach(r => { if (r.length > 0) readSuccess++; });

    console.log(`    Post-recovery reads (100 sample): ${readSuccess} hits`);

    // Cleanup
    await delPrefixKeyItem('bulk-');

    return { fulfilled, rejected, readSuccess };
}

async function scenario5_KillDuringScan() {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║  SCENARIO 5: Kill During SCAN-based Prefix Delete        ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    // Seed 500 keys
    console.log('  Seeding 500 keys...');
    const seedPromises = [];
    for (let i = 0; i < 500; i++) {
        seedPromises.push(addArrayItem(`scan-victim-${i}`, [{ i }], 300));
    }
    await Promise.all(seedPromises);
    console.log('  500 keys seeded');

    // Start prefix delete, kill Redis 100ms later
    console.log('  Starting prefix delete + killing Redis simultaneously...');

    const deletePromise = delPrefixKeyItem('scan-victim-');

    setTimeout(async () => {
        console.log('  KILLING Redis mid-SCAN!');
        await docker('kill test-redis');
    }, 100);

    // Should not crash
    try {
        await deletePromise;
        console.log('    delPrefixKeyItem resolved (graceful)');
    } catch (err) {
        console.log(`    delPrefixKeyItem caught: ${err.message}`);
    }

    // Restart
    console.log('  RESTART Redis');
    await ensureRedisUp();

    // Check how many keys remain (partial delete is fine, crash is not)
    let remaining = 0;
    for (let i = 0; i < 500; i += 50) { // Sample every 50th
        const r = await getArrayItem(`scan-victim-${i}`);
        if (r.length > 0) remaining++;
    }
    console.log(`    Remaining keys (sampled 10): ${remaining}/10`);

    // Cleanup
    await delPrefixKeyItem('scan-victim-');

    return { crashed: false, remaining };
}

async function scenario6_ThunderingHerd() {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║  SCENARIO 6: Thundering Herd After Recovery              ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    // Kill Redis
    console.log('  KILL Redis');
    await docker('kill test-redis');
    await sleep(2000);

    // Restart
    console.log('  RESTART Redis');
    await docker('start test-redis');

    // Immediately blast 200 concurrent operations (thundering herd)
    console.log('  Thundering herd: 200 concurrent ops immediately after restart...');

    const herdOps = [];
    for (let i = 0; i < 200; i++) {
        herdOps.push(
            addArrayItem(`herd-${i}`, [{ i }], 60)
                .then(() => getArrayItem(`herd-${i}`))
                .then(r => ({ status: 'ok', hit: r.length > 0 }))
                .catch(err => ({ status: 'error', msg: err.message }))
        );
    }

    const results = await Promise.all(herdOps);
    const ok = results.filter(r => r.status === 'ok').length;
    const hits = results.filter(r => r.status === 'ok' && r.hit).length;
    const errors = results.filter(r => r.status === 'error').length;

    console.log(`    OK: ${ok}  (cache hits: ${hits})`);
    console.log(`    Errors: ${errors}`);

    await ensureRedisUp();

    // Cleanup
    await delPrefixKeyItem('herd-');

    return { ok, hits, errors };
}

async function scenario7_EscalatingOutages() {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║  SCENARIO 7: Escalating Outages (1s, 5s, 15s, 1s, 1s)   ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    const engine = createOpsEngine('s7', 80);
    const downtimes = [1, 5, 15, 1, 1]; // seconds

    for (let i = 0; i < downtimes.length; i++) {
        const dt = downtimes[i];
        console.log(`\n  Outage ${i + 1}/${downtimes.length}: ${dt}s downtime`);

        await docker('kill test-redis');
        console.log(`    KILLED — waiting ${dt}s...`);
        await sleep(dt * 1000);
        stats(`during-${dt}s`, engine.counters);

        await docker('start test-redis');
        await waitRedis(20000);
        console.log(`    RECOVERED — isConnected: ${isRedisConnected()}`);

        // Brief normal period between outages
        await sleep(2000);
        stats(`after-recovery`, engine.counters);
    }

    await engine.stop();
    return engine.counters;
}

async function scenario8_NetworkPartition() {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║  SCENARIO 8: Network Partition (docker pause/unpause)    ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    // docker pause freezes the container — TCP connections hang (no RST)
    // This is worse than kill because the client doesn't know the server is gone

    const engine = createOpsEngine('s8', 150);

    console.log('  Phase 1: Normal (2s)');
    await sleep(2000);
    stats('normal', engine.counters);

    console.log('  Phase 2: PAUSE container (network partition)');
    await docker('pause test-redis');
    console.log(`    Container paused — TCP connections will hang`);
    console.log(`    isRedisConnected: ${isRedisConnected()} (stale — hasn't detected yet)`);

    await sleep(8000); // Operations will timeout
    stats('during-partition', engine.counters);
    console.log(`    isRedisConnected: ${isRedisConnected()}`);

    console.log('  Phase 3: UNPAUSE container (partition heals)');
    await docker('unpause test-redis');
    await sleep(3000);
    console.log(`    isRedisConnected: ${isRedisConnected()}`);

    // May need full restart if connection is broken
    if (!isRedisConnected()) {
        console.log('    Connection broken by pause — restarting container...');
        await docker('kill test-redis');
        await sleep(500);
        await docker('start test-redis');
        await waitRedis(20000);
    }

    console.log('  Phase 4: Post-recovery (2s)');
    await sleep(2000);
    stats('recovered', engine.counters);

    await engine.stop();
    return engine.counters;
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════

(async () => {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║        CHAOS TEST SUITE — EXTREME DISASTER SCENARIOS     ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log('║  8 scenarios, real Docker operations, zero tolerance      ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    // Wait for Redis
    await ensureRedisUp();
    console.log('Redis connected. Starting chaos...\n');

    const results = {};
    let totalErrors = 0;
    let failedScenarios = [];

    // ── Scenario 1 ──
    const s1 = await scenario1_BasicKillRestart();
    results['1-basic-kill'] = s1;
    if (s1.errors > 0) failedScenarios.push('1-basic-kill');
    totalErrors += s1.errors;
    await ensureRedisUp();
    await sleep(1000);

    // ── Scenario 2 ──
    const s2 = await scenario2_RapidFlapping();
    results['2-rapid-flap'] = s2;
    if (s2.errors > 0) failedScenarios.push('2-rapid-flap');
    totalErrors += s2.errors;
    await ensureRedisUp();
    await sleep(1000);

    // ── Scenario 3 ──
    const s3 = await scenario3_LongOutage();
    results['3-long-outage'] = s3;
    if (s3.errors > 0) failedScenarios.push('3-long-outage');
    totalErrors += s3.errors;
    await ensureRedisUp();
    await sleep(1000);

    // ── Scenario 4 ──
    const s4 = await scenario4_KillDuringBulkWrite();
    results['4-bulk-write'] = s4;
    if (s4.rejected > 0) failedScenarios.push('4-bulk-write');
    await ensureRedisUp();
    await sleep(1000);

    // ── Scenario 5 ──
    const s5 = await scenario5_KillDuringScan();
    results['5-kill-scan'] = s5;
    if (s5.crashed) failedScenarios.push('5-kill-scan');
    await ensureRedisUp();
    await sleep(1000);

    // ── Scenario 6 ──
    const s6 = await scenario6_ThunderingHerd();
    results['6-thundering-herd'] = s6;
    if (s6.errors > 0) failedScenarios.push('6-thundering-herd');
    await ensureRedisUp();
    await sleep(1000);

    // ── Scenario 7 ──
    const s7 = await scenario7_EscalatingOutages();
    results['7-escalating'] = s7;
    if (s7.errors > 0) failedScenarios.push('7-escalating');
    await ensureRedisUp();
    await sleep(1000);

    // ── Scenario 8 ──
    const s8 = await scenario8_NetworkPartition();
    results['8-net-partition'] = s8;
    if (s8.errors > 0) failedScenarios.push('8-net-partition');
    await ensureRedisUp();

    // ═══════════════════════════════════════════════════════════
    //  FINAL REPORT
    // ═══════════════════════════════════════════════════════════

    console.log('\n\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║                    FINAL REPORT                           ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');

    const scenarioNames = [
        ['1-basic-kill',      'Basic Kill & Restart'],
        ['2-rapid-flap',      'Rapid Flapping (5x)'],
        ['3-long-outage',     'Long Outage (30s)'],
        ['4-bulk-write',      'Kill During Bulk Write'],
        ['5-kill-scan',       'Kill During SCAN'],
        ['6-thundering-herd', 'Thundering Herd'],
        ['7-escalating',      'Escalating Outages'],
        ['8-net-partition',   'Network Partition'],
    ];

    for (const [key, name] of scenarioNames) {
        const r = results[key];
        const pass = !failedScenarios.includes(key);
        const icon = pass ? 'PASS' : 'FAIL';
        const detail = r.ops !== undefined
            ? `ops=${r.ops} ok=${r.success} fb=${r.fallback} err=${r.errors}`
            : r.fulfilled !== undefined
                ? `fulfilled=${r.fulfilled} rejected=${r.rejected}`
                : r.ok !== undefined
                    ? `ok=${r.ok} hits=${r.hits} errors=${r.errors}`
                    : `crashed=${r.crashed}`;
        console.log(`║  [${icon}] ${name.padEnd(30)} ${detail}`);
    }

    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log(`║  Redis connected: ${isRedisConnected()}`);
    console.log(`║  Failed scenarios: ${failedScenarios.length === 0 ? 'NONE' : failedScenarios.join(', ')}`);
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    if (failedScenarios.length === 0) {
        console.log('ALL SCENARIOS PASSED — Package is battle-tested!\n');
        process.exit(0);
    } else {
        console.log(`${failedScenarios.length} SCENARIO(S) FAILED\n`);
        process.exit(1);
    }
})();
