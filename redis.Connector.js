const redis = require('redis');
const { performance } = require('perf_hooks');
const { mergeInvalidationPatterns } = require('./core/autoInvalidate');
require('dotenv').config();

/**
 * Parses a non-negative integer env value; 0 is a valid value (used to disable a feature).
 */
function readMs(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
}

/**
 * Parses a positive integer env value.
 */
function readPositive(value, fallback) {
    const parsed = parseInt(value, 10);
    return parsed > 0 ? parsed : fallback;
}

// ── Configuration ──────────────────────────────────────────────
const RECONNECT_BASE_DELAY = 500;   // Initial retry delay (ms)
// Max delay between reconnect attempts. It also bounds how long the app keeps running without
// cache after Redis is back (default 5000; 30000 before v2.9.0).
const RECONNECT_MAX_DELAY  = readPositive(process.env.REDIS_RECONNECT_MAX_DELAY, 5000);
const WAIT_TIMEOUT = parseInt(process.env.REDIS_WAIT_TIMEOUT, 10) || 10000;
// Max time a cache read/write command may stay unanswered (network partition, failover to a
// new IP, blocked server) before it falls back. Deletes are never cut short. 0 = off.
const COMMAND_TIMEOUT = readMs(process.env.REDIS_COMMAND_TIMEOUT, Math.max(WAIT_TIMEOUT, 10000));
// Once Redis has been unavailable for WAIT_TIMEOUT, cache reads/writes return their fallback
// right away instead of each one waiting WAIT_TIMEOUT. Deletes keep waiting (consistency).
const FAIL_FAST = process.env.REDIS_FAIL_FAST !== 'false';
// While failing fast on an open connection, one cache read/write per interval still goes to
// Redis, so recovery is noticed even if no reconnect ('ready') happens
const PROBE_INTERVAL = Math.min(WAIT_TIMEOUT, 1000);
const SCAN_COUNT = readPositive(process.env.REDIS_SCAN_COUNT, 1000);
const REDIS_ENABLED = process.env.REDIS_ENABLED !== 'false';

// ── Connection State ───────────────────────────────────────────
// Monotonic clock for timeouts and outage tracking (immune to wall-clock adjustments)
const monotonicNow = () => performance.now();
let isRedisReady = false;
// Since when Redis has been unusable (disconnected, a wait for it timed out, or a command got
// no reply in time); null while healthy.
let unavailableSince = null;
let failFastLogged = false;
let lastProbeAt = -Infinity;
let lastReplyAt = monotonicNow();

function markUnavailable(since) {
    if (unavailableSince === null || since < unavailableSince) {
        unavailableSince = since;
    }
}

function markAvailable() {
    unavailableSince = null;
    failFastLogged = false;
}

// ── Redis Client ───────────────────────────────────────────────
let client = null;

function createClient() {
    const newClient = redis.createClient({
        host: process.env.REDIS_SERVER,
        port: process.env.REDIS_PORT,
        // An empty password would send AUTH "" (and warn) on every connect
        password: process.env.REDIS_PASSWORD || undefined,
        // node-redis stops reconnecting for good once the retries of one outage add up to
        // connect_timeout (default 1 hour), even with a retry_strategy. Use the largest
        // timer value (~24.8 days) so the retry below really does not give up.
        connect_timeout: 2147483647,
        // Unlimited retry — exponential backoff with jitter, never gives up
        retry_strategy: (options) => {
            const exp = Math.min(
                RECONNECT_BASE_DELAY * Math.pow(2, options.attempt - 1),
                RECONNECT_MAX_DELAY
            );
            const jitter = Math.floor(Math.random() * exp * 0.2);
            const delay = exp + jitter;
            console.log(`Redis reconnecting in ${delay}ms (attempt ${options.attempt})`);
            return delay;
        }
    });

    // Allow many listeners on the shared client without warning
    newClient.setMaxListeners(0);

    newClient.on('error', (err) => {
        // node-redis also emits 'error' for a failed command sent without a callback while the
        // connection stays usable; only a client that is no longer ready means Redis is down.
        isRedisReady = newClient.ready === true;
        if (!isRedisReady) markUnavailable(monotonicNow());
        console.error('Redis Error:', err.message);
    });

    newClient.on('connect', () => {
        console.log('Redis connected');
    });

    newClient.on('ready', () => {
        isRedisReady = true;
        lastReplyAt = monotonicNow();
        markAvailable();
        console.log('Redis ready');
        replayInvalidations();
        releaseReadyWaiters();
    });

    newClient.on('reconnecting', (params) => {
        console.log(`Redis reconnecting... (attempt ${params.attempt}, delay ${params.delay}ms)`);
    });

    newClient.on('end', () => {
        isRedisReady = false;
        markUnavailable(monotonicNow());
        console.log('Redis connection closed');
    });

    return newClient;
}

/**
 * Returns the client, creating it on first use. With REDIS_ENABLED=false no connection
 * is opened (and no reconnect loop runs) unless a Redis function is called directly.
 */
function getClient() {
    if (!client) {
        client = createClient();
    }
    return client;
}

const noop = () => {};

// ── Command Timeouts ───────────────────────────────────────────
// Timed commands awaiting a reply, oldest first. A single interval ages them in ticks and
// expires them, so the per-command cost is a Set insert/delete: no timer and no clock read.
const WATCHDOG_INTERVAL = Math.max(50, Math.min(1000, Math.floor(COMMAND_TIMEOUT / 4)));
// +1 so a command sent just before a tick still gets at least COMMAND_TIMEOUT
const TIMEOUT_TICKS = Math.ceil(COMMAND_TIMEOUT / WATCHDOG_INTERVAL) + 1;
const pendingCommands = new Set();
let watchdog = null;
let watchdogTick = 0;

function expireCommands() {
    watchdogTick++;
    let expired = false;
    for (const pending of pendingCommands) {
        if (watchdogTick - pending.tick < TIMEOUT_TICKS) break; // the rest are newer
        pendingCommands.delete(pending);
        expired = true;
        pending.reject(new Error(`Redis ${pending.name} timed out after ${COMMAND_TIMEOUT}ms`));
    }
    if (expired) {
        markUnavailable(monotonicNow() - COMMAND_TIMEOUT);
        lastProbeAt = monotonicNow(); // the next probe comes one PROBE_INTERVAL later
        recycleSilentConnection();
    }
    if (pendingCommands.size === 0) {
        clearInterval(watchdog);
        watchdog = null;
    }
}

/**
 * A connection that delivered no reply at all for COMMAND_TIMEOUT while commands were waiting
 * is treated as dead (e.g. silently dropped after a failover to a new IP). Closing the socket
 * makes node-redis reconnect now instead of when the OS gives up on it (~15 min on Linux).
 */
function recycleSilentConnection() {
    const now = monotonicNow();
    if (now - lastReplyAt < COMMAND_TIMEOUT) return;
    const stream = client && client.stream;
    if (!stream || typeof stream.destroy !== 'function') return;
    lastReplyAt = now;
    console.error(`Redis gave no reply for ${COMMAND_TIMEOUT}ms — reconnecting`);
    stream.destroy();
}

/**
 * Runs one Redis command. A `timed` command that gets no reply within REDIS_COMMAND_TIMEOUT
 * rejects and marks Redis unavailable since it was sent. Any reply from the server, even a late
 * one or an error reply (OOM, BUSY, ...), proves the connection works again.
 */
function runCommand(name, args, timed = true) {
    const redisClient = getClient();
    return new Promise((resolve, reject) => {
        let pending = null;
        if (timed && COMMAND_TIMEOUT) {
            pending = { tick: watchdogTick, name, reject };
            pendingCommands.add(pending);
            if (!watchdog) {
                watchdog = setInterval(expireCommands, WATCHDOG_INTERVAL);
                if (watchdog.unref) watchdog.unref();
            }
        }

        const onReply = (err, reply) => {
            if (!err || err.name === 'ReplyError') {
                lastReplyAt = monotonicNow();
                if (unavailableSince !== null) markAvailable();
            }
            if (pending && !pendingCommands.delete(pending)) {
                return; // already rejected by the watchdog
            }
            if (err) {
                reject(err);
            } else {
                resolve(reply);
            }
        };

        try {
            redisClient[name](...args, onReply);
        } catch (err) {
            // Thrown synchronously: no reply will come, so do not leave it to the watchdog
            if (pending) pendingCommands.delete(pending);
            reject(err);
        }
    });
}

// ── Connection Guard ───────────────────────────────────────────

// Callers waiting for the connection, released together by the 'ready' handler.
// One shared set instead of one 'ready' listener per caller: removing a listener is O(n),
// which made timeouts and the reconnect burst quadratic with thousands of waiters.
const readyWaiters = new Set();

function releaseReadyWaiters() {
    for (const waiter of readyWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
    }
    readyWaiters.clear();
}

/**
 * Wait for Redis connection to be ready.
 * Event driven (not polling); every waiter is removed on ready or on its own timeout.
 * @param {number} [timeout] - Max wait time in ms (default: WAIT_TIMEOUT)
 */
function waitForConnection(timeout) {
    timeout = timeout || WAIT_TIMEOUT;

    if (isRedisReady) return Promise.resolve();

    getClient();
    if (isRedisReady) return Promise.resolve();

    return new Promise((resolve, reject) => {
        const waiter = {
            resolve,
            timer: setTimeout(() => {
                readyWaiters.delete(waiter);
                markUnavailable(monotonicNow() - timeout);
                reject(new Error(`Redis connection timeout (${timeout}ms)`));
            }, timeout)
        };
        readyWaiters.add(waiter);
    });
}

/**
 * True once Redis has been unusable for at least WAIT_TIMEOUT: waiting again would only
 * add WAIT_TIMEOUT of latency to every call before returning the same fallback.
 */
function shouldFailFast() {
    return FAIL_FAST && unavailableSince !== null && monotonicNow() - unavailableSince >= WAIT_TIMEOUT;
}

/**
 * While failing fast on an open connection, lets one operation per PROBE_INTERVAL through.
 */
function takeProbeSlot() {
    if (!isRedisReady) return false; // a reconnect will announce recovery with 'ready'
    const now = monotonicNow();
    if (now - lastProbeAt < PROBE_INTERVAL) return false;
    lastProbeAt = now;
    return true;
}

/**
 * Execute a Redis operation with connection guard + graceful fallback.
 * - Waits for connection before executing
 * - Cache reads/writes (`skippable`) return the fallback immediately during a prolonged
 *   outage instead of waiting (see REDIS_FAIL_FAST); deletes always wait
 * - On failure returns fallback (reads) or logs warning (writes)
 *
 * @param {Function} fn         - Async function to execute
 * @param {*}        [fallback] - Value to return on failure (omit to throw)
 * @param {Object}   [options]  - { skippable, onFailure }
 */
async function safeExec(fn, fallback, options = {}) {
    const hasFallback = arguments.length > 1;
    if (options.skippable && hasFallback && shouldFailFast() && !takeProbeSlot()) {
        if (!failFastLogged) {
            failFastLogged = true;
            console.error(`Redis operation failed: Redis unavailable for ${Math.round(monotonicNow() - unavailableSince)}ms — serving cache misses without waiting until it recovers`);
        }
        return fallback;
    }
    try {
        if (!isRedisReady) await waitForConnection();
        return await fn();
    } catch (err) {
        console.error('Redis operation failed:', err.message);
        if (options.onFailure) options.onFailure(err);
        if (hasFallback) return fallback;
        throw err;
    }
}

// ── SCAN-based delete (replaces KEYS — production-safe) ────────

const DEL_BATCH_SIZE = 100;
const MAX_PENDING_DELETES = 50;

/**
 * Deletes every key matching `pattern`. Keys are deleted while the scan is still running
 * (pipelined on the same connection) instead of being collected for the whole keyspace first.
 * Its commands are not subject to the command timeout: an invalidation is never abandoned.
 */
async function deleteMatching(pattern) {
    let cursor = '0';
    let batch = [];
    let pending = [];

    const flush = () => {
        const deletion = runCommand('del', batch, false);
        deletion.catch(noop); // awaited below; avoids an unhandled rejection in between
        pending.push(deletion);
        batch = [];
    };

    do {
        const [newCursor, foundKeys] = await runCommand('scan', [cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT], false);
        cursor = newCursor;
        for (const key of foundKeys) {
            batch.push(key);
            if (batch.length === DEL_BATCH_SIZE) flush();
        }
        if (pending.length >= MAX_PENDING_DELETES) {
            await Promise.all(pending);
            pending = [];
        }
    } while (cursor !== '0');

    if (batch.length) flush();
    await Promise.all(pending);
}

// ── Missed invalidations ───────────────────────────────────────
// Deletes that failed because Redis was unreachable are replayed once it is ready again, so a
// write made during an outage does not leave stale entries behind for the rest of their TTL.
// Bounded: beyond the limit the oldest entries are dropped (as every entry was before).
const MAX_MISSED_INVALIDATIONS = 1000;
const missedInvalidations = new Map();

function rememberInvalidations(type, values) {
    for (const value of values) {
        const id = `${type}\u0000${value}`;
        missedInvalidations.delete(id);
        missedInvalidations.set(id, { type, value });
        if (missedInvalidations.size > MAX_MISSED_INVALIDATIONS) {
            missedInvalidations.delete(missedInvalidations.keys().next().value);
        }
    }
}

function replayInvalidations() {
    if (missedInvalidations.size === 0) return;
    const missed = [...missedInvalidations.values()];
    missedInvalidations.clear();
    console.log(`Redis: replaying ${missed.length} invalidation(s) missed while it was unavailable`);

    const patterns = missed.filter(item => item.type === 'pattern').map(item => item.value);
    const keys = missed.filter(item => item.type === 'key').map(item => item.value);
    if (patterns.length) {
        Promise.all(patterns.map(deleteMatching)).catch((err) => {
            console.error('Redis operation failed:', err.message);
            rememberInvalidations('pattern', patterns);
        });
    }
    if (keys.length) {
        runCommand('del', [keys], false).catch((err) => {
            console.error('Redis operation failed:', err.message);
            rememberInvalidations('key', keys);
        });
    }
}

// ── Helpers ────────────────────────────────────────────────────

function _namespaceKey(key) {
    return process.env.REDIS_VHOST ? `${process.env.REDIS_VHOST}:${key}` : key;
}

// Connect eagerly unless Redis is disabled (after all state above is initialized)
if (REDIS_ENABLED) {
    getClient();
}

// ── Public API ─────────────────────────────────────────────────

module.exports = {
    /**
     * Get cached array item. Returns [] on cache miss OR Redis failure.
     *
     * Single atomic GET — no separate EXISTS check. EXISTS-then-GET is a
     * classic TOCTOU race: if the key is deleted (TTL expiry, or a
     * concurrent cache-invalidation DEL/SCAN) in the gap between the two
     * calls, GET returns nil and `JSON.parse(null)` silently succeeds as
     * the JS value `null` (JSON.parse coerces its argument via String()
     * first, and String(null) === 'null') — so callers checking
     * `cachedData.length` crash with "Cannot read properties of null"
     * instead of getting the documented [] cache-miss value. Observed in
     * production 2026-07-09 during a bulk cache-flush that raced live
     * traffic. A plain GET already returns nil for a missing key, so the
     * EXISTS round-trip was redundant as well as the source of the bug.
     */
    async getArrayItem(key) {
        return safeExec(async () => {
            const namespacedKey = _namespaceKey(key);
            const reply = await runCommand('get', [namespacedKey]);
            if (reply === null || reply === undefined) {
                return [];
            }
            return JSON.parse(reply);
        }, [], { skippable: true });
    },

    /**
     * Store array item in cache. Returns the data even if caching fails.
     */
    async addArrayItem(key, array, expiryDate = 40000) {
        return safeExec(async () => {
            const namespacedKey = _namespaceKey(key);
            await runCommand('setex', [namespacedKey, expiryDate, JSON.stringify(array)]);
            return array;
        }, array, { skippable: true });
    },

    /**
     * Delete specific cache keys. Logs warning on failure (doesn't throw); keys that could
     * not be deleted because Redis was unreachable are deleted once it is ready again.
     */
    async delKeyItem(keys) {
        if (Array.isArray(keys) && keys.length === 0) {
            return undefined;
        }
        const namespacedKeys = Array.isArray(keys) ? keys.map(key => _namespaceKey(key)) : [_namespaceKey(keys)];
        return safeExec(async () => {
            await runCommand('del', Array.isArray(keys) ? [namespacedKeys] : namespacedKeys, false);
        }, undefined, { onFailure: () => rememberInvalidations('key', namespacedKeys) });
    },

    /**
     * Delete cache keys by prefix pattern using SCAN. Logs warning on failure (doesn't throw);
     * prefixes that could not be invalidated because Redis was unreachable are invalidated once
     * it is ready again. Several prefixes are scanned concurrently, and prefixes that can share
     * one SCAN pass (e.g. 'users_' and 'users:') are merged into a single pattern.
     */
    async delPrefixKeyItem(keys) {
        const prefixes = Array.isArray(keys) ? mergeInvalidationPatterns(keys) : [keys];
        const patterns = prefixes.map(prefix => _namespaceKey(`${prefix}*`));
        return safeExec(async () => {
            await Promise.all(patterns.map(deleteMatching));
        }, undefined, { onFailure: () => rememberInvalidations('pattern', patterns) });
    },

    /**
     * Check if Redis connection is healthy. Useful for health-check endpoints.
     */
    isRedisConnected() {
        getClient();
        return isRedisReady;
    },

    /**
     * Returns the raw Redis client instance.
     */
    getRedisClient() {
        return getClient();
    }
};
