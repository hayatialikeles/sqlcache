/**
 * Correctness & Safety Tests (v2.9.1)
 *
 * bulkInsert identifiers, invalidation and COMMIT handling, transaction cache fills, the
 * stale-fill guard, what is cached and served, missing cache names, auto keys, enable flags,
 * the coalescing max wait, query cancellation, database tracking, the pagination LIMIT,
 * linear-time string handling, result cloning, Redis connector diagnostics and ES module
 * named imports.
 */

const chai = require('chai');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');
const proxyquire = require('proxyquire');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

chai.use(sinonChai);
const { expect } = chai;

const ENV_KEYS = [
    'DB_HOST', 'DB_USERNAME', 'DB_NAME', 'REDIS_ENABLED', 'REDIS_SERVER', 'REDIS_PORT', 'REDIS_VHOST',
    'REDIS_PASSWORD', 'REDIS_WAIT_TIMEOUT', 'REDIS_COMMAND_TIMEOUT', 'REDIS_FAIL_FAST', 'CORE_AUTO_FEATURES',
    'CORE_AUTO_INVALIDATION', 'DB_COALESCE_QUERIES', 'DB_COALESCE_MAX_WAIT', 'DB_PAGINATION_REUSE_TOTAL'
];

const BASE_ENV = {
    DB_HOST: 'localhost', DB_USERNAME: 'root', DB_NAME: 'app_db', REDIS_ENABLED: 'true', REDIS_SERVER: 'localhost'
};

function clearEnv() {
    ENV_KEYS.forEach(key => delete process.env[key]);
}

function setEnv(env) {
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Settles like `promise`, or rejects if it is still pending after `ms`
function within(promise, ms) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms);
        })
    ]).finally(() => clearTimeout(timer));
}

const rejection = promise => promise.then(() => null, err => err);

const elapsedMs = start => Number(process.hrtime.bigint() - start) / 1e6;

const md5 = text => crypto.createHash('md5').update(text).digest('hex').substring(0, 8);

// Deterministic pseudo-random numbers (mulberry32), so a failure can be reproduced
function seededRandom(seed) {
    return () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Random text made of `pieces`; a piece that is a function gets the random source and returns text
function randomText(random, pieces, maxPieces) {
    let text = '';
    const count = 1 + Math.floor(random() * maxPieces);
    for (let i = 0; i < count; i++) {
        const piece = pieces[Math.floor(random() * pieces.length)];
        text += typeof piece === 'function' ? piece(random) : piece;
    }
    return text;
}

const run = char => random => char.repeat(1 + Math.floor(random() * 200));

// A fresh instance of a core module (enable flags off), usable as a proxyquire stub
function freshModule(request) {
    return { ...proxyquire(request, {}), '@noCallThru': true };
}

// Redis glob (SCAN MATCH) as a RegExp
function globToRegExp(glob) {
    const escape = c => c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
    let source = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        const classEnd = c === '[' ? glob.indexOf(']', i + 1) : -1;
        if (c === '*') source += '[\\s\\S]*';
        else if (c === '?') source += '[\\s\\S]';
        else if (classEnd !== -1) {
            source += `[${glob.slice(i + 1, classEnd)}]`;
            i = classEnd;
        } else if (c === '\\' && i + 1 < glob.length) source += escape(glob[++i]);
        else source += escape(c);
    }
    return new RegExp(`^${source}$`);
}

// node-redis v3 client over an in-memory store; replies arrive asynchronously, as from a server
function createFakeRedisClient() {
    const store = new Map();
    const handlers = {};
    const reply = (callback, value) => process.nextTick(() => callback(null, value));
    const client = {
        store,
        ready: true,
        get: sinon.spy((key, callback) => reply(callback, store.has(key) ? store.get(key) : null)),
        setex: sinon.spy((key, ttl, value, callback) => {
            store.set(key, value);
            reply(callback, 'OK');
        }),
        del: sinon.spy((...args) => {
            const callback = args.pop();
            let deleted = 0;
            for (const key of args.flat()) if (store.delete(key)) deleted++;
            reply(callback, deleted);
        }),
        scan: sinon.spy((cursor, match, pattern, count, size, callback) => {
            const regex = globToRegExp(pattern);
            reply(callback, ['0', [...store.keys()].filter(key => regex.test(key))]);
        }),
        on(event, handler) {
            (handlers[event] = handlers[event] || []).push(handler);
            if (event === 'ready' && client.ready) handler();
        },
        emit(event, ...args) {
            (handlers[event] || []).forEach(handler => handler(...args));
        },
        down() {
            client.ready = false;
            client.emit('end');
        },
        up() {
            client.ready = true;
            client.emit('ready');
        },
        once() {},
        removeListener() {},
        setMaxListeners() {}
    };
    return client;
}

// ── v2.9.0 implementations, for the equivalence tests (D14) ─────
const v290 = {
    isPlainRead(sql) {
        if (typeof sql !== 'string') return false;
        const body = sql.replace(/[\s;]+$/, '');
        return /^\s*\(?\s*SELECT\b/i.test(body) && body.indexOf(';') === -1;
    },
    cleanPaginationSql: sql => sql.trim().replace(/;+\s*$/, ''),
    extractWhereConditions(sql) {
        const whereMatch = sql.match(/WHERE\s+(.+?)(?:ORDER\s+BY|LIMIT|GROUP\s+BY|HAVING|$)/is);
        if (!whereMatch) return [];
        const conditions = whereMatch[1].trim().split(/\s+(AND|OR)\s+/i)
            .filter(part => !/^(AND|OR)$/i.test(part.trim()));
        return conditions.map(c => c.trim());
    },
    extractColumnNames(conditions) {
        const columns = [];
        for (const condition of conditions) {
            const columnMatch = condition.match(/(\w+)\s*(?:=|>|<|>=|<=|!=|<>|IN|LIKE|NOT\s+IN|NOT\s+LIKE)/i);
            if (columnMatch) columns.push(columnMatch[1].toLowerCase());
        }
        return columns.sort();
    },
    mergeInvalidationPatterns(patterns) {
        const GLOB_SPECIAL_CHARS = /[*?[\]\\]/;
        const literals = [];
        for (const pattern of patterns) {
            if (typeof pattern !== 'string') continue;
            const literal = pattern.replace(/\*+$/, '');
            if (literal && !GLOB_SPECIAL_CHARS.test(literal)) literals.push(literal);
        }
        const result = [];
        const groups = new Map();
        const seen = new Set();
        for (const pattern of patterns) {
            const literal = typeof pattern === 'string' ? pattern.replace(/\*+$/, '') : null;
            if (!literal || GLOB_SPECIAL_CHARS.test(literal)) {
                result.push(pattern);
                continue;
            }
            if (seen.has(literal)) continue;
            seen.add(literal);
            if (literals.some(other => other.length < literal.length && literal.startsWith(other))) continue;
            const last = literal.slice(-1);
            const stem = literal.slice(0, -1);
            const group = stem && last.charCodeAt(0) < 128 ? groups.get(stem) : undefined;
            if (group) {
                group.chars.push(last);
            } else {
                if (stem && last.charCodeAt(0) < 128) groups.set(stem, { index: result.length, chars: [last] });
                result.push(pattern);
            }
        }
        for (const [stem, group] of groups) {
            if (group.chars.length > 1) {
                const charClass = group.chars.map(c => (c === '^' || c === '-' ? `\\${c}` : c)).join('');
                result[group.index] = `${stem}[${charClass}]*`;
            }
        }
        return result;
    }
};

// Statements (and fragments) with long runs of whitespace and semicolons, for D14
const SQL_PIECES = [
    'SELECT', 'select', 'SeLeCt', 'SELECTED', '(', ')', ' ', '\t', '\n', '\r', '\u00a0', '\u3000', '\u2028',
    ';', ';;', 'x', '1', '*', ' FROM t', 'UPDATE t SET a = 1', ' WHERE a = ?', '-- c',
    run(' '), run(';'), run('\t'), run('\u3000'), run('; '), run(' ;')
];

describe('Correctness & Safety (v2.9.1)', () => {
    afterEach(() => {
        sinon.restore();
        clearEnv();
    });

    describe('dbConnector', () => {
        let dbConnector;
        let mockConnection;
        let mockPool;
        let mockRedis;
        let createConnection;
        let autoKey;

        function load(env = {}) {
            setEnv({ ...BASE_ENV, ...env });
            autoKey = freshModule('../core/autoKey');
            dbConnector = proxyquire('../dbConnector', {
                'mysql2/promise': { createPool: () => mockPool, createConnection, '@noCallThru': true },
                './redis.Connector': mockRedis,
                './core/autoKey': autoKey,
                './core/autoInvalidate': freshModule('../core/autoInvalidate')
            });
            return dbConnector;
        }

        beforeEach(() => {
            mockConnection = {
                query: sinon.stub().resolves([[]]),
                release: sinon.stub(),
                beginTransaction: sinon.stub().resolves(),
                commit: sinon.stub().resolves(),
                rollback: sinon.stub().resolves()
            };
            mockPool = {
                getConnection: sinon.stub().resolves(mockConnection),
                end: sinon.stub().resolves(),
                pool: {}
            };
            mockRedis = {
                getArrayItem: sinon.stub().resolves([]),
                addArrayItem: sinon.stub().resolves(),
                delPrefixKeyItem: sinon.stub().resolves(),
                '@noCallThru': true
            };
            createConnection = sinon.stub();
            load();
        });

        const executedSql = () => mockConnection.query.getCalls().map(call => call.args[0]);
        const lost = () => Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true });
        const duplicate = () => Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });

        describe('bulkInsert identifiers (D1)', () => {
            const P = '(?:[0-9A-Za-z$_\\u0080-\\uFFFF]+|`(?:[^`]|``)+`)';
            const SPEC = new RegExp(`^\\s*${P}(?:\\.${P}){0,2}\\s*$`);

            it('rejects an invalid table or column name with a TypeError before anything is sent', async () => {
                const tables = [
                    'logs (msg) VALUES (1); UPDATE users SET is_admin = 1; INSERT INTO logs',
                    '`a`b`', 'users;', 'users -- x', 'a.b.c.d', 'app_db .users', 'app_db. users', '`users`x',
                    '', ' ', '\u00a0 .users', null, undefined, 42, { toString: () => 'users' }
                ];
                for (const table of tables) {
                    const err = await rejection(dbConnector.bulkInsert(table, [{ id: 1 }]));
                    expect(err, String(table)).to.be.instanceOf(TypeError);
                    expect(err.message).to.equal('bulkInsert: invalid table name ' + JSON.stringify(String(table)));
                }

                const columns = [
                    "name) VALUES ('x'); DROP TABLE users; -- ",
                    'name) SELECT password_hash FROM users -- ',
                    'a b', 'a,b', '`x', 'x`', 'col;', ''
                ];
                for (const column of columns) {
                    const err = await rejection(dbConnector.bulkInsert('products', [{ id: 1, [column]: 'x' }]));
                    expect(err, column).to.be.instanceOf(TypeError);
                    expect(err.message).to.equal('bulkInsert: invalid column name ' + JSON.stringify(column));
                }

                // nothing sent, and not retried
                expect(mockPool.getConnection).to.not.have.been.called;
            });

            it('sends the statement of a valid name exactly as before (no quoting added)', async () => {
                mockConnection.query.resolves([{ affectedRows: 1 }]);
                const cases = [
                    ['users', { id: 1, name: 'a' }, 'INSERT INTO users (id,name) VALUES (?,?)'],
                    ['app_db.users', { id: 1 }, 'INSERT INTO app_db.users (id) VALUES (?)'],
                    ['`users`', { '`id`': 1 }, 'INSERT INTO `users` (`id`) VALUES (?)'],
                    ['`app_db`.`users`', { id: 1 }, 'INSERT INTO `app_db`.`users` (id) VALUES (?)'],
                    ['`odd``name`', { '`select`': 1 }, 'INSERT INTO `odd``name` (`select`) VALUES (?)'],
                    ['`a.b; c`', { id: 1 }, 'INSERT INTO `a.b; c` (id) VALUES (?)'],
                    ['müşteriler', { 'adı': 'Ali' }, 'INSERT INTO müşteriler (adı) VALUES (?)'],
                    [' users\n', { ' name ': 'x' }, 'INSERT INTO  users\n ( name ) VALUES (?)'],
                    ['db.t', { 't.col': 1, $x_1: 2 }, 'INSERT INTO db.t (t.col,$x_1) VALUES (?,?)'],
                    ['order', { key: 1 }, 'INSERT INTO order (key) VALUES (?)']
                ];
                for (const [table, record, sql] of cases) {
                    mockConnection.query.resetHistory();
                    await dbConnector.bulkInsert(table, [record]);
                    expect(mockConnection.query.firstCall.args[0]).to.equal(sql);
                }
            });

            it('accepts exactly the names that ^\\s*P(?:\\.P){0,2}\\s*$ accepts (exhaustive and randomized)', async () => {
                mockConnection.query.resolves([{ affectedRows: 1 }]);
                const alphabet = ['a', '0', '$', '_', 'é', '\u00a0', '\u3000', ' ', '\t', '\n', '.', '`', '(', ';', '-', '*'];
                const names = ['', '\u00a0', '\u00a0.users', 'db.\u00a0', ' \u00a0.x', '\u3000.\u00a0', 'a.\u00a0 '];
                let level = [''];
                for (let length = 1; length <= 3; length++) {
                    level = level.flatMap(prefix => alphabet.map(char => prefix + char));
                    names.push(...level);
                }
                const random = seededRandom(291);
                for (let i = 0; i < 3000; i++) {
                    let name = '';
                    const length = 4 + Math.floor(random() * 10);
                    for (let j = 0; j < length; j++) name += alphabet[Math.floor(random() * alphabet.length)];
                    names.push(name);
                }

                for (const name of names) {
                    const err = await rejection(dbConnector.bulkInsert(name, [{ id: 1 }]));
                    if (err && !(err instanceof TypeError)) throw err;
                    expect(err === null, JSON.stringify(name)).to.equal(SPEC.test(name));
                }
            });

            it('checks names in linear time (that regex is cubic on long runs of U+00A0)', async () => {
                mockConnection.query.resolves([{ affectedRows: 1 }]);
                const start = process.hrtime.bigint();
                const err = await rejection(dbConnector.bulkInsert('t', [{ [`${'\u00a0'.repeat(20000)}!`]: 1 }]));
                await dbConnector.bulkInsert(`${' '.repeat(50000)}users${'\u3000'.repeat(50000)}`, [{ id: 1 }]);

                expect(err).to.be.instanceOf(TypeError);
                expect(elapsedMs(start)).to.be.below(200);
            });
        });

        describe('bulkInsert invalidation (D2)', () => {
            it('applies auto-invalidation when no resetCacheName is given', async () => {
                process.env.CORE_AUTO_INVALIDATION = 'true';
                mockConnection.query.resolves([{ affectedRows: 1 }]);

                await dbConnector.bulkInsert('users', [{ name: 'a' }]);

                expect(mockRedis.delPrefixKeyItem).to.have.been.calledOnceWithExactly('users[_:]*');
            });

            it('invalidates resetCacheName instead, as before', async () => {
                process.env.CORE_AUTO_INVALIDATION = 'true';
                mockConnection.query.resolves([{ affectedRows: 1 }]);

                await dbConnector.bulkInsert('users', [{ name: 'a' }], { resetCacheName: 'users_' });

                expect(mockRedis.delPrefixKeyItem).to.have.been.calledOnceWithExactly('users_');
            });

            it('invalidates after a failure once an INSERT was sent, then rethrows the original error', async () => {
                mockConnection.query.onCall(0).resolves([{ affectedRows: 2 }]);
                mockConnection.query.onCall(1).rejects(duplicate());

                const err = await rejection(dbConnector.bulkInsert('events', [1, 2, 3].map(id => ({ id })), { chunkSize: 2, resetCacheName: 'events:' }));

                expect(err.code).to.equal('ER_DUP_ENTRY');
                expect(mockRedis.delPrefixKeyItem).to.have.been.calledOnceWithExactly('events:');
            });

            it('treats a failed first INSERT as possibly applied too', async () => {
                process.env.CORE_AUTO_INVALIDATION = 'true';
                mockConnection.query.rejects(duplicate());

                await rejection(dbConnector.bulkInsert('events', [{ id: 1 }]));

                expect(mockRedis.delPrefixKeyItem).to.have.been.calledOnceWithExactly('events[_:]*');
            });

            it('forgets in-flight reads after such a failure', async () => {
                let selects = 0;
                mockConnection.query.callsFake(async (sql) => {
                    if (!/^SELECT/.test(sql)) throw duplicate();
                    selects++;
                    await sleep(20);
                    return [[{ id: 1 }]];
                });

                const before = dbConnector.getCacheQuery('SELECT * FROM events', [], 'events:list');
                await sleep(2);
                await rejection(dbConnector.bulkInsert('events', [{ id: 1 }]));
                const after = dbConnector.getCacheQuery('SELECT * FROM events', [], 'events:list');
                await Promise.all([before, after]);

                expect(selects).to.equal(2);
            });

            it('does not invalidate when nothing can have been written', async () => {
                // USE fails: no INSERT was sent
                mockConnection.query.rejects(Object.assign(new Error('Unknown database'), { code: 'ER_BAD_DB_ERROR' }));
                await rejection(dbConnector.bulkInsert('events', [{ id: 1 }], { resetCacheName: 'events:', database: 'gone' }));

                // a transaction that failed before COMMIT was rolled back
                mockConnection.query.reset();
                mockConnection.query.onCall(0).resolves([{ affectedRows: 1 }]);
                mockConnection.query.onCall(1).rejects(duplicate());
                await rejection(dbConnector.bulkInsert('events', [{ id: 1 }, { id: 2 }], { chunkSize: 1, transaction: true, resetCacheName: 'events:' }));

                expect(mockConnection.rollback).to.have.been.calledOnce;
                expect(mockRedis.delPrefixKeyItem).to.not.have.been.called;
            });

            it('never lets an invalidation problem replace the original error', async () => {
                sinon.stub(console, 'error');
                mockRedis.delPrefixKeyItem.rejects(new Error('Redis is down'));
                mockConnection.query.rejects(duplicate());

                const err = await rejection(dbConnector.bulkInsert('events', [{ id: 1 }], { resetCacheName: 'events:' }));

                expect(err.code).to.equal('ER_DUP_ENTRY');
                expect(mockRedis.delPrefixKeyItem).to.have.been.calledOnce;
                expect(console.error).to.have.been.calledWith('Cache invalidation error:');
            });
        });

        describe('bulkInsert with transaction: true (D3)', () => {
            it('never retries a failed COMMIT, flags its error commitOutcomeUnknown and invalidates', async () => {
                mockConnection.query.resolves([{ affectedRows: 2 }]);
                mockConnection.commit.rejects(lost());

                const err = await rejection(dbConnector.bulkInsert('events', [1, 2, 3, 4].map(id => ({ id })), {
                    chunkSize: 2, transaction: true, resetCacheName: 'events:'
                }));

                expect(err.code).to.equal('PROTOCOL_CONNECTION_LOST');
                expect(err.commitOutcomeUnknown).to.equal(true);
                expect(Object.getOwnPropertySymbols(err)).to.have.lengthOf(1); // the internal no-retry marker
                expect(mockConnection.beginTransaction).to.have.been.calledOnce;
                expect(mockConnection.commit).to.have.been.calledOnce;
                expect(mockConnection.query).to.have.been.calledTwice;
                expect(mockConnection.rollback).to.have.been.calledOnce;
                // it may have been applied: invalidated as after a successful insert
                expect(mockRedis.delPrefixKeyItem).to.have.been.calledOnceWithExactly('events:');
            });
        });

        describe('withTransaction cache fills (D4)', () => {
            const rowsFor = sql => (/^SELECT/.test(sql) ? [[{ id: 1, name: 'Ada' }]] : [{ affectedRows: 1 }]);

            it('does not write the cache while the transaction is open, but after COMMIT', async () => {
                mockConnection.query.callsFake(async sql => rowsFor(sql));

                await dbConnector.withTransaction(async (tx) => {
                    await tx.getCacheQuery('SELECT * FROM users WHERE id = ?', [1], 'user:1');
                    expect(mockRedis.addArrayItem).to.not.have.been.called;
                });

                expect(mockRedis.addArrayItem).to.have.been.calledOnceWithExactly('user:1', [{ id: 1, name: 'Ada' }]);
            });

            it('writes the fills after COMMIT, the release of the connection and the invalidations', async () => {
                mockConnection.query.callsFake(async sql => rowsFor(sql));

                await dbConnector.withTransaction(async (tx) => {
                    await tx.query('UPDATE orders SET status = ?', ['paid'], 'orders:');
                    await tx.getCacheQuery('SELECT * FROM users WHERE id = ?', [1], 'user:1');
                });

                expect(mockConnection.commit).to.have.been.calledBefore(mockConnection.release);
                expect(mockConnection.release).to.have.been.calledBefore(mockRedis.delPrefixKeyItem);
                expect(mockRedis.delPrefixKeyItem).to.have.been.calledBefore(mockRedis.addArrayItem);
            });

            it('keeps the last value read per key, as it was read', async () => {
                mockConnection.query.onCall(0).resolves([[{ id: 1, v: 'first' }]]);
                mockConnection.query.onCall(1).resolves([[{ id: 1, v: 'second' }]]);

                await dbConnector.withTransaction(async (tx) => {
                    await tx.getCacheQuery('SELECT * FROM t WHERE id = ?', [1], 't:1');
                    const rows = await tx.getCacheQuery('SELECT * FROM t WHERE id = ?', [1], 't:1');
                    rows[0].v = 'changed by the caller';
                });

                expect(mockRedis.addArrayItem).to.have.been.calledOnceWithExactly('t:1', [{ id: 1, v: 'second' }]);
            });

            it('drops the fills when the transaction is rolled back', async () => {
                mockConnection.query.callsFake(async sql => rowsFor(sql));

                await rejection(dbConnector.withTransaction(async (tx) => {
                    await tx.getCacheQuery('SELECT * FROM users WHERE id = ?', [1], 'user:1');
                    throw new Error('payment declined');
                }));

                expect(mockConnection.rollback).to.have.been.calledOnce;
                expect(mockRedis.addArrayItem).to.not.have.been.called;
            });

            it('when COMMIT throws: applies the buffered invalidations, drops the fills and rethrows', async () => {
                mockConnection.query.callsFake(async sql => rowsFor(sql));
                mockConnection.commit.rejects(lost());

                const err = await rejection(dbConnector.withTransaction(async (tx) => {
                    await tx.query('UPDATE users SET name = ? WHERE id = ?', ['x', 1], 'users:');
                    await tx.getCacheQuery('SELECT * FROM users WHERE id = ?', [1], 'users:1');
                }));

                expect(err.code).to.equal('PROTOCOL_CONNECTION_LOST');
                expect(mockRedis.delPrefixKeyItem).to.have.been.calledOnceWithExactly('users:');
                expect(mockConnection.release).to.have.been.calledBefore(mockRedis.delPrefixKeyItem);
                expect(mockRedis.addArrayItem).to.not.have.been.called;
            });

            it('rethrows the COMMIT error even when that invalidation fails', async () => {
                sinon.stub(console, 'error');
                mockConnection.query.callsFake(async sql => rowsFor(sql));
                mockConnection.commit.rejects(lost());
                mockRedis.delPrefixKeyItem.rejects(new Error('Redis is down'));

                const err = await rejection(dbConnector.withTransaction(async (tx) => {
                    await tx.query('UPDATE users SET name = ? WHERE id = ?', ['x', 1], 'users:');
                }));

                expect(err.code).to.equal('PROTOCOL_CONNECTION_LOST');
                expect(mockRedis.delPrefixKeyItem).to.have.been.calledOnce;
            });

            it('does not store an empty or a non-array result', async () => {
                mockConnection.query.onCall(0).resolves([[]]);
                mockConnection.query.onCall(1).resolves([{ affectedRows: 0 }]);

                await dbConnector.withTransaction(async (tx) => {
                    await tx.getCacheQuery('SELECT * FROM t WHERE 0', [], 'empty');
                    await tx.getCacheQuery('DO 1', [], 'header');
                });

                expect(mockRedis.addArrayItem).to.not.have.been.called;
            });
        });

        describe('What is cached and served (D6)', () => {
            it('getCacheQuery serves only cached rows: null, strings, objects and [] are misses', async () => {
                mockConnection.query.resolves([[{ id: 1 }]]);

                for (const cached of [null, 'abc', { length: 1 }, [], 0, true]) {
                    mockRedis.getArrayItem.resolves(cached);
                    expect(await dbConnector.getCacheQuery('SELECT * FROM t', [], 'k')).to.deep.equal([{ id: 1 }]);
                }
                expect(mockConnection.query).to.have.callCount(6);
            });

            it('getCacheQuery stores only rows', async () => {
                mockConnection.query.onCall(0).resolves([[]]);
                mockConnection.query.onCall(1).resolves([{ affectedRows: 1 }]);
                mockConnection.query.onCall(2).resolves([[{ id: 1 }]]);

                await dbConnector.getCacheQuery('SELECT * FROM t WHERE 0', [], 'empty');
                await dbConnector.getCacheQuery('INSERT INTO t VALUES (1)', [], 'header');
                await dbConnector.getCacheQuery('SELECT * FROM t', [], 'rows');

                expect(mockRedis.addArrayItem).to.have.been.calledOnceWithExactly('rows', [{ id: 1 }]);
            });

            it('getCacheQueryWithTimeout serves and stores only rows', async () => {
                mockRedis.getArrayItem.resolves('abc');
                mockConnection.query.onCall(0).resolves([[]]);
                mockConnection.query.onCall(1).resolves([[{ id: 1 }]]);

                expect(await dbConnector.getCacheQueryWithTimeout('SELECT * FROM t WHERE 0', [], 'empty')).to.deep.equal([]);
                expect(await dbConnector.getCacheQueryWithTimeout('SELECT * FROM t', [], 'rows')).to.deep.equal([{ id: 1 }]);

                expect(mockRedis.addArrayItem).to.have.been.calledOnceWithExactly('rows', [{ id: 1 }]);
            });

            it('tx.getCacheQuery serves only cached rows', async () => {
                mockRedis.getArrayItem.resolves(null);
                mockConnection.query.resolves([[{ id: 1 }]]);

                let rows;
                await dbConnector.withTransaction(async (tx) => {
                    rows = await tx.getCacheQuery('SELECT * FROM t', [], 'k');
                });

                expect(rows).to.deep.equal([{ id: 1 }]);
            });

            it('pagination serves only a cached object with a detail array', async () => {
                mockRedis.getArrayItem.resolves({ totalCount: 5, pageCount: 1 });
                mockConnection.query.resolves([[{ id: 1 }]]);

                expect(await dbConnector.getCacheQueryPagination('SELECT * FROM t', [], 't', 0, 10))
                    .to.deep.equal({ totalCount: 1, pageCount: 1, detail: [{ id: 1 }] });

                mockRedis.getArrayItem.resolves({ totalCount: 0, pageCount: 0, detail: [] });
                mockConnection.query.resetHistory();
                expect(await dbConnector.getCacheQueryPagination('SELECT * FROM t', [], 't', 0, 10))
                    .to.deep.equal({ totalCount: 0, pageCount: 0, detail: [] });
                expect(mockConnection.query).to.not.have.been.called;
            });
        });

        describe('Missing cacheName in pagination and the timeout variant (D7)', () => {
            const notCached = name => `sqlcache: ${name}() was called without a cacheName, so its result is not cached. Pass a cacheName or enable automatic keys (CORE_AUTO_FEATURES=true).`;

            it('pagination runs without the cache, and logs that once, when auto keys are off', async () => {
                sinon.stub(console, 'warn');
                load({ DB_PAGINATION_REUSE_TOTAL: 'true' });
                mockConnection.query.onCall(0).resolves([Array.from({ length: 10 }, (_, i) => ({ id: i }))]);
                mockConnection.query.onCall(1).resolves([[{ total: 42 }]]);
                mockConnection.query.resolves([[{ id: 1 }]]);

                for (const cacheName of [undefined, null, '']) {
                    await dbConnector.getCacheQueryPagination('SELECT * FROM t', [], cacheName, 0, 10);
                }

                expect(mockRedis.getArrayItem).to.not.have.been.called;
                expect(mockRedis.addArrayItem).to.not.have.been.called;
                expect(console.warn).to.have.been.calledOnceWithExactly(notCached('getCacheQueryPagination'));
            });

            it('pagination uses an automatic key as the base of the page and total keys when auto keys are on', async () => {
                load({ CORE_AUTO_FEATURES: 'true', DB_PAGINATION_REUSE_TOTAL: 'true' });
                mockConnection.query.onCall(0).resolves([Array.from({ length: 10 }, (_, i) => ({ id: i }))]);
                mockConnection.query.onCall(1).resolves([[{ total: 42 }]]);
                const sql = 'SELECT * FROM users WHERE status = ?';

                await dbConnector.getCacheQueryPagination(sql, ['active'], undefined, 0, 10, 'tenant_1');

                const base = `${autoKey.generateCacheKey(sql, ['active'])}@tenant_1`;
                expect(mockRedis.getArrayItem.firstCall.args[0]).to.equal(`${base}:page0:size10`);
                const [pageWrite, totalWrite] = mockRedis.addArrayItem.getCalls().map(call => call.args[0]);
                expect(pageWrite).to.equal(`${base}:page0:size10`);
                expect(totalWrite.startsWith(`${base}:total:`)).to.be.true;
            });

            it('getCacheQueryWithTimeout runs without the cache, and logs that once, when auto keys are off', async () => {
                sinon.stub(console, 'warn');
                mockConnection.query.resolves([[{ id: 1 }]]);

                await dbConnector.getCacheQueryWithTimeout('SELECT * FROM t', [], undefined);
                await dbConnector.getCacheQueryWithTimeout('SELECT * FROM t', [], null, { timeout: 1000 });

                expect(mockRedis.getArrayItem).to.not.have.been.called;
                expect(mockRedis.addArrayItem).to.not.have.been.called;
                expect(console.warn).to.have.been.calledOnceWithExactly(notCached('getCacheQueryWithTimeout'));
            });

            it('getCacheQueryWithTimeout uses an automatic key when auto keys are on', async () => {
                load({ CORE_AUTO_FEATURES: 'true' });
                mockConnection.query.resolves([[{ id: 1 }]]);

                await dbConnector.getCacheQueryWithTimeout('SELECT * FROM users WHERE id = ?', [1], '', { database: 'tenant_1' });

                const key = `${autoKey.generateCacheKey('SELECT * FROM users WHERE id = ?', [1])}@tenant_1`;
                expect(mockRedis.getArrayItem).to.have.been.calledOnceWithExactly(key);
                expect(mockRedis.addArrayItem).to.have.been.calledOnceWithExactly(key, [{ id: 1 }]);
            });

            it('logs nothing when Redis is disabled (nothing is cached anyway)', async () => {
                sinon.stub(console, 'warn');
                load({ REDIS_ENABLED: 'false' });
                mockConnection.query.resolves([[{ id: 1 }]]);

                await dbConnector.getCacheQueryPagination('SELECT * FROM t', [], undefined, 0, 10);
                await dbConnector.getCacheQueryWithTimeout('SELECT * FROM t', [], undefined);

                expect(console.warn).to.not.have.been.called;
                expect(mockRedis.getArrayItem).to.not.have.been.called;
            });

            it('getCacheQuery still requires a cacheName when auto keys are off', async () => {
                const err = await rejection(dbConnector.getCacheQuery('SELECT * FROM t', []));

                expect(err.message).to.include('cacheName is required');
            });
        });

        describe('Auto keys in getCacheQuery (D8)', () => {
            it('accepts BigInt parameters', async () => {
                load({ CORE_AUTO_FEATURES: 'true' });
                mockConnection.query.resolves([[{ id: 1 }]]);

                expect(await dbConnector.getCacheQuery('SELECT * FROM users WHERE id = ?', [10n])).to.deep.equal([{ id: 1 }]);
                expect(mockRedis.getArrayItem).to.have.been.calledOnceWithExactly(`users:id:${md5('[{"$bigint":"10"}]')}`);
            });
        });

        describe('Coalescing max wait (D10)', () => {
            const SQL = 'SELECT * FROM products WHERE featured = ?';
            const read = () => dbConnector.getCacheQuery(SQL, [1], 'home');

            it('shares a stuck load for at most DB_COALESCE_MAX_WAIT, then one fresh load', async () => {
                load({ DB_COALESCE_MAX_WAIT: '50' });
                let selects = 0;
                mockConnection.query.callsFake(() => {
                    selects++;
                    if (selects === 1) return new Promise(() => {}); // e.g. a silently dropped connection
                    return sleep(5).then(() => [[{ id: 1 }]]);
                });

                read().catch(() => {});
                await sleep(5);
                const started = Date.now();
                const results = await within(Promise.all(Array.from({ length: 5 }, read)), 1000);

                expect(results).to.deep.equal(Array.from({ length: 5 }, () => [{ id: 1 }]));
                expect(Date.now() - started).to.be.within(30, 500);
                expect(selects).to.equal(2);
            });

            it('copies the rows for waiting callers before the first caller can change them', async () => {
                load();
                mockConnection.query.callsFake(() => sleep(10).then(() => [[{ id: 1, name: 'Ada' }]]));

                const first = read().then((rows) => {
                    rows[0].name = 'changed';
                    return rows;
                });
                const waiting = [read(), read(), read()];

                const [changed, ...copies] = await Promise.all([first, ...waiting]);
                expect(changed[0].name).to.equal('changed');
                copies.forEach(rows => expect(rows[0].name).to.equal('Ada'));
            });

            it('lets later callers join the fresh load instead of the overdue one', async () => {
                load({ DB_COALESCE_MAX_WAIT: '50' });
                let selects = 0;
                mockConnection.query.callsFake(() => {
                    selects++;
                    if (selects === 1) return new Promise(() => {});
                    return sleep(40).then(() => [[{ id: selects }]]);
                });

                read().catch(() => {});
                await sleep(60);
                const starter = read(); // finds the load overdue: starts a fresh one
                await sleep(5);
                const joiner = read();

                expect(await within(starter, 1000)).to.deep.equal([{ id: 2 }]);
                expect(await within(joiner, 1000)).to.deep.equal([{ id: 2 }]);
                expect(selects).to.equal(2);
            });

            it('resolves with whichever of the two loads fulfils first', async () => {
                load({ DB_COALESCE_MAX_WAIT: '30' });
                let selects = 0;
                mockConnection.query.callsFake(() => {
                    selects++;
                    return selects === 1
                        ? sleep(60).then(() => [[{ from: 'overdue load' }]])
                        : sleep(100).then(() => [[{ from: 'fresh load' }]]);
                });

                const leader = read();
                await sleep(5);
                const waiter = await read();

                expect(waiter).to.deep.equal([{ from: 'overdue load' }]);
                expect(selects).to.equal(2);
                await leader;
                await sleep(80); // let the fresh load finish
            });

            it("rejects only when both loads reject, with the fresh load's error", async () => {
                load({ DB_COALESCE_MAX_WAIT: '30' });
                let selects = 0;
                mockConnection.query.callsFake(() => {
                    selects++;
                    return selects === 1
                        ? sleep(60).then(() => { throw Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' }); })
                        : sleep(50).then(() => { throw Object.assign(new Error('Lock wait timeout'), { code: 'ER_LOCK_WAIT_TIMEOUT' }); });
                });

                read().catch(() => {});
                await sleep(5);
                const err = await rejection(read());

                expect(err.code).to.equal('ER_LOCK_WAIT_TIMEOUT');
                expect(selects).to.equal(2); // no query of its own after both failed
            });

            it('rethrows ER_QUERY_TIMEOUT of a shared load to its waiters instead of running their own', async () => {
                let selects = 0;
                mockConnection.query.callsFake(async () => {
                    selects++;
                    await sleep(20);
                    throw Object.assign(new Error('Query execution was interrupted, maximum statement execution time exceeded'), {
                        code: 'ER_QUERY_TIMEOUT', errno: 3024
                    });
                });

                const results = await Promise.allSettled(Array.from({ length: 6 }, read));

                expect(results.every(result => result.status === 'rejected' && result.reason.errno === 3024)).to.be.true;
                expect(selects).to.equal(1);
            });

            it("uses one unref'd timer per shared load, cleared when the load settles", async () => {
                load({ DB_COALESCE_MAX_WAIT: '5000' });
                const setTimeoutSpy = sinon.spy(global, 'setTimeout');
                const clearTimeoutSpy = sinon.spy(global, 'clearTimeout');
                mockConnection.query.callsFake(() => sleep(20).then(() => [[{ id: 1 }]]));

                await Promise.all(Array.from({ length: 10 }, read));

                const timers = setTimeoutSpy.getCalls().filter(call => call.args[1] > 1000);
                expect(timers).to.have.lengthOf(1);
                expect(timers[0].args[1]).to.be.within(4900, 5000);
                expect(timers[0].returnValue.hasRef()).to.be.false;
                expect(clearTimeoutSpy).to.have.been.calledWith(timers[0].returnValue);
            });

            it('DB_COALESCE_MAX_WAIT: unset or invalid means 10000 ms', async () => {
                const setTimeoutSpy = sinon.spy(global, 'setTimeout');
                for (const value of [undefined, 'abc', '0', '-5']) {
                    load({ DB_COALESCE_MAX_WAIT: value });
                    setTimeoutSpy.resetHistory();
                    mockConnection.query.callsFake(() => sleep(5).then(() => [[{ id: 1 }]]));

                    await Promise.all([read(), read()]);

                    const timers = setTimeoutSpy.getCalls().filter(call => call.args[1] > 1000);
                    expect(timers, String(value)).to.have.lengthOf(1);
                    expect(timers[0].args[1]).to.be.within(9900, 10000);
                }
            });
        });

        describe('cancelOnTimeout (D11)', () => {
            let killer;

            beforeEach(() => {
                killer = { query: sinon.stub().resolves([{}]), end: sinon.stub().resolves() };
                createConnection = sinon.stub().resolves(killer);
                load();
                mockConnection.threadId = 77;
                mockConnection.destroy = sinon.stub();
            });

            const cancellingRead = (options = {}) => rejection(dbConnector.getCacheQueryWithTimeout(
                'SELECT SLEEP(10)', [], 'k', { timeout: 20, cancelOnTimeout: true, ...options }
            ));

            it('destroys the connection of a killed query instead of returning it to the pool', async () => {
                mockConnection.query.callsFake(() => sleep(60).then(() => [[{ id: 1 }]]));

                const err = await cancellingRead();
                await sleep(80);

                expect(err.message).to.equal('Query timeout exceeded');
                expect(killer.query).to.have.been.calledOnceWith('KILL QUERY ?', [77]);
                expect(mockConnection.destroy).to.have.been.calledOnce;
                expect(mockConnection.release).to.not.have.been.called;
            });

            it('releases it when the connection has no destroy()', async () => {
                delete mockConnection.destroy;
                mockConnection.query.callsFake(() => sleep(60).then(() => [[{ id: 1 }]]));

                await cancellingRead();
                await sleep(80);

                expect(killer.query).to.have.been.calledOnce;
                expect(mockConnection.release).to.have.been.calledOnce;
            });

            it('kills each thread only once', async () => {
                createConnection.callsFake(() => sleep(30).then(() => killer));
                const twin = { ...mockConnection, query: sinon.stub().callsFake(() => sleep(60).then(() => [[]])), release: sinon.stub(), destroy: sinon.stub() };
                mockConnection.query.callsFake(() => sleep(60).then(() => [[]]));
                mockPool.getConnection.onCall(1).resolves(twin);

                await Promise.all([cancellingRead(), cancellingRead()]);
                await sleep(80);

                expect(createConnection).to.have.been.calledOnce;
                expect(mockConnection.destroy).to.have.been.calledOnce;
                expect(twin.destroy).to.have.been.calledOnce;
            });

            it('opens at most 4 kill connections at once, and logs when it cannot cancel', async () => {
                sinon.stub(console, 'error');
                let finishKills;
                const killsMayFinish = new Promise((resolve) => {
                    finishKills = resolve;
                });
                createConnection.callsFake(() => killsMayFinish.then(() => killer));
                const connections = Array.from({ length: 6 }, (_, i) => ({
                    threadId: 100 + i,
                    query: sinon.stub().callsFake(() => sleep(60).then(() => [[]])),
                    release: sinon.stub(),
                    destroy: sinon.stub()
                }));
                connections.forEach((connection, i) => mockPool.getConnection.onCall(i).resolves(connection));

                const errors = await Promise.all(connections.map(() => cancellingRead()));
                expect(errors.every(err => err.message === 'Query timeout exceeded')).to.be.true;
                expect(createConnection).to.have.callCount(4);
                expect(console.error.getCalls().filter(call =>
                    call.args[0] === 'Could not cancel timed-out query: too many cancellations in progress')).to.have.lengthOf(2);

                finishKills();
                await sleep(80);
                expect(killer.query).to.have.callCount(4);
                // a connection without a KILL goes back to the pool as usual
                expect(connections.filter(connection => connection.destroy.called)).to.have.lengthOf(4);
                expect(connections.filter(connection => connection.release.called)).to.have.lengthOf(2);
            });

            it('does not send the query when the timeout fires during the USE round trip', async () => {
                mockConnection.query.callsFake(sql => (/^USE /.test(sql) ? sleep(40).then(() => [[]]) : Promise.resolve([[{ id: 1 }]])));

                const err = await cancellingRead({ database: 'tenant_db' });
                await sleep(60);

                expect(err.message).to.equal('Query timeout exceeded');
                expect(executedSql()).to.deep.equal(['USE `tenant_db`']);
                expect(createConnection).to.not.have.been.called;
            });
        });

        describe('Database tracking (D12)', () => {
            it('reselects the database after DROP DATABASE or DROP SCHEMA', async () => {
                mockConnection.query.resolves([{ affectedRows: 0 }]);

                await dbConnector.QuaryCache('DROP DATABASE tenant_42', [], null, 'tenant_42');
                await dbConnector.QuaryCache('CREATE TABLE users (id INT)', [], null, 'tenant_42');
                await dbConnector.QuaryCache('drop  schema if exists tenant_43', [], null, 'tenant_42');
                await dbConnector.QuaryCache('SELECT 1', [], null, 'tenant_42');

                expect(executedSql()).to.deep.equal([
                    'USE `tenant_42`', 'DROP DATABASE tenant_42',
                    'USE `tenant_42`', 'CREATE TABLE users (id INT)',
                    'drop  schema if exists tenant_43',
                    'USE `tenant_42`', 'SELECT 1'
                ]);
            });
        });

        describe('Pagination LIMIT (D13)', () => {
            it('puts LIMIT on its own line, so a trailing -- comment cannot swallow it', async () => {
                mockConnection.query.resolves([[{ id: 1 }]]);

                await dbConnector.getCacheQueryPagination('SELECT * FROM products WHERE active = ? -- only active rows', [1], 'products', 0, 10);

                expect(mockConnection.query.firstCall.args).to.deep.equal([
                    'SELECT * FROM products WHERE active = ? -- only active rows\nLIMIT ?, ?', [1, 0, 10]
                ]);
            });
        });

        describe('Linear-time string handling (D14)', () => {
            it('decides what is a plain read exactly like v2.9.0 (randomized, through coalescing)', async () => {
                mockConnection.query.callsFake(() => sleep(1).then(() => [[{ id: 1 }]]));
                const random = seededRandom(14);

                for (let i = 0; i < 400; i++) {
                    const sql = randomText(random, SQL_PIECES, 8);
                    mockConnection.query.resetHistory();

                    await Promise.all([dbConnector.getCacheQuery(sql, [], 'k'), dbConnector.getCacheQuery(sql, [], 'k')]);

                    const runs = executedSql().filter(text => text === sql).length;
                    expect(runs, JSON.stringify(sql)).to.equal(v290.isPlainRead(sql) ? 1 : 2);
                }
            });

            it('strips the trailing semicolons of a paginated query exactly like v2.9.0 (randomized)', async () => {
                const random = seededRandom(13);

                for (let i = 0; i < 400; i++) {
                    const sql = randomText(random, SQL_PIECES, 8);
                    mockConnection.query.resetHistory();

                    await dbConnector.getCacheQueryPagination(sql, [], 'p', 0, 10);

                    expect(mockConnection.query.firstCall.args[0], JSON.stringify(sql))
                        .to.equal(`${v290.cleanPaginationSql(sql)}\nLIMIT ?, ?`);
                }
            });

            it('handles 100k-character statements in getCacheQuery and pagination under 200 ms', async () => {
                const N = 100000;
                mockConnection.query.resolves([[{ id: 1 }]]);

                for (const sql of [`SELECT 1${' '.repeat(N)}x`, `${' '.repeat(N)}UPDATE t SET a = 1`, `(${'\u3000'.repeat(N)}x`]) {
                    const start = process.hrtime.bigint();
                    await dbConnector.getCacheQuery(sql, [], 'k');
                    expect(elapsedMs(start), sql.slice(0, 12)).to.be.below(200);
                }

                const start = process.hrtime.bigint();
                await dbConnector.getCacheQueryPagination(`SELECT 1${';'.repeat(N)}x`, [], 'p', 0, 10);
                expect(elapsedMs(start)).to.be.below(200);
            });
        });

        describe('cloneResult (D15)', () => {
            it('copies an own "__proto__" key of a shared result as data', async () => {
                mockConnection.query.callsFake(async () => {
                    await sleep(10);
                    return [[{ id: 1, prefs: JSON.parse('{"theme":"dark","__proto__":{"isAdmin":true}}') }]];
                });

                const [first, second] = await Promise.all([
                    dbConnector.getCacheQuery('SELECT * FROM users WHERE id = ?', [1], 'user:1'),
                    dbConnector.getCacheQuery('SELECT * FROM users WHERE id = ?', [1], 'user:1')
                ]);

                expect(mockConnection.query).to.have.been.calledOnce;
                const copy = second[0].prefs;
                expect(copy).to.not.equal(first[0].prefs);
                expect(Object.getPrototypeOf(copy)).to.equal(Object.prototype);
                expect(copy.isAdmin).to.be.undefined;
                expect(Object.keys(copy)).to.deep.equal(['theme', '__proto__']);
                expect(Object.getOwnPropertyDescriptor(copy, '__proto__').value).to.deep.equal({ isAdmin: true });
            });
        });

        describe('Uncountable SQL (D16)', () => {
            const duplicateColumn = () => Object.assign(new Error("Duplicate column name 'id'"), { code: 'ER_DUP_FIELDNAME' });

            function answerPagination() {
                mockConnection.query.callsFake(async (sql) => {
                    if (/^SELECT COUNT\(\*\)/.test(sql)) throw duplicateColumn();
                    if (/\nLIMIT \?, \?$/.test(sql)) return [[{ id: 1 }]]; // a full page of size 1
                    return [[{ id: 1 }, { id: 1 }, { id: 2 }]]; // the full fetch
                });
            }
            const countQueries = () => executedSql().filter(sql => /^SELECT COUNT\(\*\)/.test(sql)).length;

            it('remembers SQL that cannot be counted by its SHA-1 hash, not by its text', async () => {
                const createHash = sinon.spy(crypto, 'createHash');
                const SQL = 'SELECT a.id, b.id FROM a JOIN b ON a.id = b.id';
                answerPagination();

                await dbConnector.getCacheQueryPagination(SQL, [], 'dup', 0, 1);
                expect(createHash).to.have.been.calledWith('sha1');

                mockConnection.query.resetHistory();
                const second = await dbConnector.getCacheQueryPagination(SQL, [], 'dup', 1, 1);
                expect(second.totalCount).to.equal(3);
                expect(countQueries()).to.equal(0);
            });

            it('still remembers at most 500 of them', async () => {
                answerPagination();
                for (let i = 0; i <= 500; i++) {
                    await dbConnector.getCacheQueryPagination(`SELECT a.id, b.id FROM a JOIN b ON a.id = b.id AND ${i} = ${i}`, [], `dup${i}`, 0, 1);
                }

                mockConnection.query.resetHistory();
                await dbConnector.getCacheQueryPagination('SELECT a.id, b.id FROM a JOIN b ON a.id = b.id AND 500 = 500', [], 'again', 1, 1);
                expect(countQueries()).to.equal(0);
                await dbConnector.getCacheQueryPagination('SELECT a.id, b.id FROM a JOIN b ON a.id = b.id AND 0 = 0', [], 'again', 1, 1);
                expect(countQueries()).to.equal(1); // evicted first
            });
        });
    });

    describe('Stale-fill guard (D5) with the real redis.Connector', () => {
        let connector;
        let client;
        let dbConnector;
        let mockConnection;
        let mockPool;

        function loadAll(env = {}) {
            setEnv({ ...BASE_ENV, REDIS_PORT: '6379', REDIS_VHOST: 'app', ...env });
            client = createFakeRedisClient();
            connector = proxyquire('../redis.Connector', { redis: { createClient: () => client, '@noCallThru': true } });
            dbConnector = proxyquire('../dbConnector', {
                'mysql2/promise': { createPool: () => mockPool, '@noCallThru': true },
                './redis.Connector': { ...connector, '@noCallThru': true },
                './core/autoKey': freshModule('../core/autoKey'),
                './core/autoInvalidate': freshModule('../core/autoInvalidate')
            });
        }

        beforeEach(() => {
            sinon.stub(console, 'log');
            sinon.stub(console, 'error');
            mockConnection = {
                query: sinon.stub().resolves([[]]),
                release: sinon.stub(),
                beginTransaction: sinon.stub().resolves(),
                commit: sinon.stub().resolves(),
                rollback: sinon.stub().resolves()
            };
            mockPool = { getConnection: sinon.stub().resolves(mockConnection), end: sinon.stub().resolves(), pool: {} };
            loadAll();
        });

        const written = () => client.setex.getCalls().map(call => call.args[0]);

        // A row whose SELECT reads it when it starts and returns it 30 ms later; UPDATE changes it
        function productsTable() {
            const row = { id: 1, price: 100 };
            mockConnection.query.callsFake(async (sql, params) => {
                if (/^SELECT/.test(sql)) {
                    const snapshot = { ...row };
                    await sleep(30);
                    return [[snapshot]];
                }
                row.price = params[0];
                return [{ affectedRows: 1 }];
            });
            return row;
        }

        it('skips a read-through fill when a write invalidated its key while the SELECT ran', async () => {
            productsTable();
            const SQL = 'SELECT * FROM products WHERE id = ?';

            const reader = dbConnector.getCacheQuery(SQL, [1], 'product:1');
            await sleep(5);
            await dbConnector.QuaryCache('UPDATE products SET price = ? WHERE id = ?', [80, 1], 'product:');

            expect(await reader).to.deep.equal([{ id: 1, price: 100 }]);
            expect(client.store.has('app:product:1')).to.be.false;

            // the next miss caches the new row
            expect(await dbConnector.getCacheQuery(SQL, [1], 'product:1')).to.deep.equal([{ id: 1, price: 80 }]);
            expect(JSON.parse(client.store.get('app:product:1'))).to.deep.equal([{ id: 1, price: 80 }]);
        });

        it('still fills when the invalidation does not cover the key', async () => {
            productsTable();

            const reader = dbConnector.getCacheQuery('SELECT * FROM products WHERE id = ?', [1], 'product:1');
            await sleep(5);
            await dbConnector.QuaryCache('UPDATE products SET price = ? WHERE id = ?', [80, 1], 'orders:');
            await reader;

            expect(client.store.has('app:product:1')).to.be.true;
        });

        it('captures the sequence inside the shared load, before getConnection', async () => {
            let grant;
            mockPool.getConnection.callsFake(() => new Promise((resolve) => {
                grant = () => resolve(mockConnection);
            }));
            mockConnection.query.resolves([[{ id: 1 }]]);

            const reader = dbConnector.getCacheQuery('SELECT * FROM products WHERE id = ?', [1], 'product:1');
            await sleep(5);
            await connector.delKeyItem('product:1'); // while the load waits for a pool connection
            grant();
            await reader;

            expect(client.store.has('app:product:1')).to.be.false;
        });

        it('matches deleted keys exactly and deleted patterns by their literal prefix', async () => {
            const guard = connector._fillGuard;

            let sequence = guard.sequence();
            await connector.delKeyItem('user:1');
            await guard.fill('user:10', [1], sequence);
            await guard.fill('user:1', [1], sequence);
            expect(written()).to.deep.equal(['app:user:10']);

            client.setex.resetHistory();
            sequence = guard.sequence();
            await connector.delPrefixKeyItem(['users_', 'users:']); // SCAN app:users[_:]**, literal prefix app:users
            await connector.delPrefixKeyItem('a?c');
            await connector.delPrefixKeyItem('x\\*y');
            for (const key of ['users:1', 'users_list', 'usersettings', 'abc', 'ab', 'x*y', 'orders:1', 'b']) {
                await guard.fill(key, [1], sequence);
            }
            // 'usersettings' and 'ab' are skipped needlessly (harmless); nothing covered is written
            expect(written()).to.deep.equal(['app:orders:1', 'app:b']);
        });

        it('compares keys as Redis sees them, also without REDIS_VHOST (a numeric cache name)', async () => {
            loadAll({ REDIS_VHOST: undefined });
            const guard = connector._fillGuard;

            let sequence = guard.sequence();
            await connector.delKeyItem('123');
            await guard.fill(123, [1], sequence);
            sequence = guard.sequence();
            await connector.delPrefixKeyItem('4');
            await guard.fill(456, [1], sequence);
            await guard.fill(789, [1], sequence);

            expect(written()).to.deep.equal([789]);
        });

        it('records a delete when it is called, also one that fails and is replayed later', async () => {
            loadAll({ REDIS_WAIT_TIMEOUT: '20' });
            const guard = connector._fillGuard;
            const sequence = guard.sequence();

            client.down();
            await connector.delPrefixKeyItem('product:'); // fails after REDIS_WAIT_TIMEOUT, kept for replay
            expect(client.scan).to.not.have.been.called;
            client.up();
            await guard.fill('product:1', [{ id: 1 }], sequence);

            expect(client.scan).to.have.been.calledOnce;
            expect(client.setex).to.not.have.been.called;
        });

        it('checks right before SETEX, after waiting for the connection', async () => {
            const guard = connector._fillGuard;
            const sequence = guard.sequence();

            client.down();
            const fill = guard.fill('product:1', [{ id: 1 }], sequence); // waits for the connection
            await sleep(5);
            const del = connector.delKeyItem('product:1');
            client.up();
            await Promise.all([fill, del]);

            expect(client.setex).to.not.have.been.called;
        });

        it('skips a fill when the log no longer reaches back to its sequence', async () => {
            const guard = connector._fillGuard;
            const sequence = guard.sequence();

            for (let i = 0; i < 1000; i++) await connector.delKeyItem(`other:${i}`);
            await guard.fill('k1', [1], sequence); // 1000 newer deletes, none covering it: written
            await connector.delKeyItem('other:1000');
            await guard.fill('k2', [1], sequence); // 1001: older than the log, cannot tell

            expect(written()).to.deep.equal(['app:k1']);
        });

        it('fills the page and total keys of pagination and getCacheQueryWithTimeout through the guard', async () => {
            loadAll({ DB_PAGINATION_REUSE_TOTAL: 'true' });
            const fullPage = Array.from({ length: 10 }, (_, i) => ({ id: i }));
            mockConnection.query.callsFake(async (sql) => {
                await sleep(20);
                return /^SELECT COUNT/.test(sql) ? [[{ total: 42 }]] : [fullPage];
            });

            const page = dbConnector.getCacheQueryPagination('SELECT * FROM users', [], 'users', 0, 10);
            const timed = dbConnector.getCacheQueryWithTimeout('SELECT * FROM users WHERE id = ?', [1], 'users:1', { timeout: 1000 });
            await sleep(5);
            await connector.delPrefixKeyItem('users');
            await Promise.all([page, timed]);
            expect(client.setex).to.not.have.been.called;

            // without a delete meanwhile, all of them are written
            await dbConnector.getCacheQueryPagination('SELECT * FROM users', [], 'users', 1, 10);
            await dbConnector.getCacheQueryWithTimeout('SELECT * FROM users WHERE id = ?', [2], 'users:2', { timeout: 1000 });
            const keys = written();
            expect(keys).to.have.lengthOf(3);
            expect(keys).to.include.members(['app:users:page1:size10', 'app:users:2']);
            expect(keys.some(key => /^app:users:total:[0-9a-f]{16}$/.test(key))).to.be.true;
        });

        it('leaves the public addArrayItem unchanged', async () => {
            await connector.delKeyItem('k');
            await connector.addArrayItem('k', [1]);

            expect(client.store.get('app:k')).to.equal('[1]');
        });

        it('fills tx.getCacheQuery reads with the sequence captured before BEGIN (D4)', async () => {
            mockConnection.query.resolves([[{ id: 1, stock: 10 }]]);

            await dbConnector.withTransaction(async (tx) => {
                // another request invalidates the key after BEGIN, before this transaction reads it
                await connector.delPrefixKeyItem('product:');
                await tx.getCacheQuery('SELECT * FROM products WHERE id = ?', [1], 'product:1');
            });
            expect(client.store.has('app:product:1')).to.be.false;

            await dbConnector.withTransaction(async (tx) => {
                await tx.query('UPDATE products SET stock = ? WHERE id = ?', [9, 1], 'product:');
                await tx.getCacheQuery('SELECT * FROM products WHERE id = ?', [1], 'product:1');
            });
            expect(client.store.has('app:product:1')).to.be.false; // its own invalidation covers it

            await dbConnector.withTransaction(async (tx) => {
                await connector.delPrefixKeyItem('orders:');
                await tx.getCacheQuery('SELECT * FROM products WHERE id = ?', [1], 'product:1');
            });
            expect(client.store.has('app:product:1')).to.be.true;
        });

        it('bulkInsert with resetCacheName makes the same deletes as delPrefixKeyItem(resetCacheName) (D2)', async () => {
            mockConnection.query.resolves([{ affectedRows: 1 }]);
            const scanned = () => client.scan.getCalls().map(call => call.args[2]).sort();

            for (const resetCacheName of ['users_', ['users_', 'users:'], ['users_', 'orders_'], ['a', 'a:list']]) {
                client.scan.resetHistory();
                await connector.delPrefixKeyItem(resetCacheName);
                const expected = scanned();

                client.scan.resetHistory();
                await dbConnector.bulkInsert('users', [{ id: 1 }], { resetCacheName });

                expect(scanned(), JSON.stringify(resetCacheName)).to.deep.equal(expected);
            }
        });
    });

    describe('redis.Connector diagnostics (D17)', () => {
        let client;

        function loadConnector(env = {}) {
            setEnv({ REDIS_SERVER: 'localhost', REDIS_PORT: '6379', ...env });
            client = createFakeRedisClient();
            return proxyquire('../redis.Connector', { redis: { createClient: () => client, '@noCallThru': true } });
        }

        beforeEach(() => {
            sinon.stub(console, 'log');
            sinon.stub(console, 'error');
            sinon.stub(console, 'warn');
        });

        it('logs once per outage when missed invalidations are dropped', async () => {
            const connector = loadConnector({ REDIS_WAIT_TIMEOUT: '20' });
            const message = 'Redis: more than 1000 invalidations were missed while it was unavailable; the oldest were dropped and those entries may stay stale until they expire';
            const logged = () => console.error.getCalls().filter(call => call.args[0] === message).length;
            const keys = n => Array.from({ length: n }, (_, i) => `k${i}`);

            client.down();
            await connector.delKeyItem(keys(1000));
            expect(logged()).to.equal(0);
            await connector.delKeyItem(['one more', 'and another']);
            await connector.delKeyItem(['still down']);
            expect(logged()).to.equal(1);

            client.up(); // replayed: the next outage logs again
            await sleep(5);
            client.down();
            await connector.delKeyItem(keys(1001));
            expect(logged()).to.equal(2);
        });

        it('warns once when REDIS_VHOST changes at runtime, and otherwise behaves as before', async () => {
            const connector = loadConnector({ REDIS_VHOST: 'tenant_a' });

            await connector.getArrayItem('k');
            process.env.REDIS_VHOST = 'tenant_b';
            await connector.getArrayItem('k');
            process.env.REDIS_VHOST = 'tenant_c';
            await connector.getArrayItem('k');

            expect(console.warn).to.have.been.calledOnceWithExactly(
                'sqlcache: REDIS_VHOST changed at runtime ("tenant_a" -> "tenant_b"). It is shared by every concurrent request; for per-tenant caches pass a per-call database or prefix the cache names (see docs/USE-CASE-SAAS.md).'
            );
            expect(client.get.getCalls().map(call => call.args[0])).to.deep.equal(['tenant_a:k', 'tenant_b:k', 'tenant_c:k']);
        });

        it('does not warn while REDIS_VHOST stays the same (unset and empty are the same)', async () => {
            const connector = loadConnector();

            await connector.getArrayItem('k');
            process.env.REDIS_VHOST = '';
            await connector.getArrayItem('k');
            await connector.addArrayItem('k', [1]);

            expect(console.warn).to.not.have.been.called;
        });
    });

    describe('core', () => {
        describe('Auto keys (D8)', () => {
            const autoKey = require('../core/autoKey');

            it('adds the parameter hash to the key of SQL without a table', () => {
                const sqlHash = md5('CALL get_user(?)');
                for (const params of [[1], [1, 2, 3, 4], { id: 1 }]) {
                    expect(autoKey.generateCacheKey('CALL get_user(?)', params)).to.equal(`query:${sqlHash}:${md5(JSON.stringify(params))}`);
                }
                expect(autoKey.generateCacheKey('CALL get_user(?)', [1])).to.not.equal(autoKey.generateCacheKey('CALL get_user(?)', [2]));
                expect(autoKey.generateCacheKey('SELECT balance_of(?) AS balance', [1], { strategy: 'simple' }))
                    .to.equal(`query:${md5('SELECT balance_of(?) AS balance')}:${md5('[1]')}`);
            });

            it('keeps query:<sqlhash> without parameters', () => {
                for (const params of [[], null, undefined]) {
                    expect(autoKey.generateCacheKey('SHOW TABLES', params)).to.equal(`query:${md5('SHOW TABLES')}`);
                }
            });

            it('hashes BigInt parameters instead of throwing', () => {
                expect(autoKey.createParameterHash([1n, 'x'])).to.equal(md5('[{"$bigint":"1"},"x"]'));
                expect(autoKey.createParameterHash([-12345678901234567890n])).to.equal(md5('[{"$bigint":"-12345678901234567890"}]'));
                expect(autoKey.createParameterHash({ id: 2n })).to.equal(md5('{"id":{"$bigint":"2"}}'));
                expect(autoKey.generateCacheKey('SELECT * FROM users WHERE id = ?', [10n])).to.equal(`users:id:${md5('[{"$bigint":"10"}]')}`);
            });

            it('keeps the hash of every non-BigInt parameter byte-identical', () => {
                class Point {
                    constructor() {
                        this.x = 1;
                        this.y = [2];
                    }
                }
                const values = [
                    0, -0, 1.5, -1e21, 1e-7, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, '', 'abc', 'üñí©ødé',
                    '\u2028\u2029', 'a"b\\c\n', '😀', true, false, null, undefined, new Date(0), new Date(NaN),
                    Buffer.from('png'), [1, [2, [3]]], { a: 1, b: { c: [null] } }, { toJSON: () => 'custom' }, new Point(),
                    new Map([[1, 2]]), new Set([1]), new Uint8Array([1, 2]), [, 1], () => 1, Symbol('s'), Object.create(null),
                    { u: undefined, f() {} }, Object(1), Object('s'), Object(true)
                ];
                values.forEach((value, i) => {
                    expect(autoKey.createParameterHash([value]), `value #${i}`).to.equal(md5(JSON.stringify([value])));
                    expect(autoKey.createParameterHash([value, 'tail', 7]), `value #${i}`).to.equal(md5(JSON.stringify([value, 'tail', 7])));
                });
                expect(autoKey.createParameterHash(values)).to.equal(md5(JSON.stringify(values)));
                expect(autoKey.createParameterHash({ id: 1, at: new Date(0) })).to.equal(md5(JSON.stringify({ id: 1, at: new Date(0) })));
                expect(autoKey.createParameterHash('raw')).to.equal(md5(JSON.stringify('raw')));
            });
        });

        describe('Enable flags (D9)', () => {
            it('enableAutoKey(false) disables and enableAutoKey(true) enables; objects as before', () => {
                const { enableAutoKey, isAutoKeyEnabled } = proxyquire('../core/autoKey', {});

                enableAutoKey(true);
                expect(isAutoKeyEnabled()).to.be.true;
                enableAutoKey(false);
                expect(isAutoKeyEnabled()).to.be.false;
                enableAutoKey({});
                expect(isAutoKeyEnabled()).to.be.true;
                enableAutoKey({ enabled: false });
                expect(isAutoKeyEnabled()).to.be.false;
                enableAutoKey();
                expect(isAutoKeyEnabled()).to.be.true;
            });

            it('enableAutoInvalidation(false) disables and enableAutoInvalidation(true) enables; objects as before', () => {
                const autoInvalidate = proxyquire('../core/autoInvalidate', {});

                autoInvalidate.enableAutoInvalidation(true);
                expect(autoInvalidate.isAutoInvalidationEnabled()).to.be.true;
                expect(autoInvalidate.determineInvalidationPatterns('UPDATE users SET a = 1')).to.deep.equal(['users_*', 'users:*']);
                autoInvalidate.enableAutoInvalidation(false);
                expect(autoInvalidate.isAutoInvalidationEnabled()).to.be.false;
                expect(autoInvalidate.determineInvalidationPatterns('UPDATE users SET a = 1')).to.deep.equal([]);
                autoInvalidate.enableAutoInvalidation({ tables: { users: 'u:*' } });
                expect(autoInvalidate.determineInvalidationPatterns('UPDATE users SET a = 1')).to.deep.equal(['u:*']);
                autoInvalidate.enableAutoInvalidation({ enabled: false });
                expect(autoInvalidate.isAutoInvalidationEnabled()).to.be.false;
            });

            it('configure() passes booleans through', () => {
                const autoKey = freshModule('../core/autoKey');
                const autoInvalidate = freshModule('../core/autoInvalidate');
                const index = proxyquire('../index', {
                    './dbConnector': { '@noCallThru': true },
                    './redis.Connector': { '@noCallThru': true },
                    './core/autoKey': autoKey,
                    './core/autoInvalidate': autoInvalidate
                });

                index.configure({ autoKey: true, autoInvalidation: true });
                expect(autoKey.isAutoKeyEnabled()).to.be.true;
                expect(autoInvalidate.isAutoInvalidationEnabled()).to.be.true;
                index.configure({ autoKey: false, autoInvalidation: false });
                expect(autoKey.isAutoKeyEnabled()).to.be.false;
                expect(autoInvalidate.isAutoInvalidationEnabled()).to.be.false;
            });
        });

        describe('Linear-time string handling (D14)', () => {
            const autoKey = require('../core/autoKey');
            const { mergeInvalidationPatterns } = require('../core/autoInvalidate');

            it('splits WHERE conditions exactly like v2.9.0 (randomized)', () => {
                const pieces = [
                    'a = ?', 'b>1', 'c IN (?)', 'AND', 'and', 'OR', 'Or', 'ANDOR', 'BAND', ' ', '\t', '\n', '\u00a0', 'x',
                    "'it''s'", 'ORDER BY id', 'LIMIT 5', 'GROUP BY a', run(' '), run('\n'), run('\u3000'),
                    random => ` ${random() < 0.5 ? 'AND' : 'or'}${' '.repeat(1 + Math.floor(random() * 300))}`
                ];
                const random = seededRandom(8);
                for (let i = 0; i < 2000; i++) {
                    const sql = `SELECT * FROM t WHERE ${randomText(random, pieces, 10)}`;
                    expect(autoKey.extractWhereConditions(sql), JSON.stringify(sql)).to.deep.equal(v290.extractWhereConditions(sql));
                }
            });

            it('extracts column names exactly like v2.9.0 (randomized)', () => {
                const pieces = [
                    'id', 'Name', '_x', '9', '=', '>', '<', '>=', '<=', '!=', '<>', 'IN', 'in', 'LIKE', 'NOT IN', 'not  like',
                    ' ', '\t', 'xIN', 'INx', 'NOTx', '(', ')', '?', '.', 'REGEXP', run('a'), run('_'), run(' ')
                ];
                const random = seededRandom(9);
                for (let i = 0; i < 2000; i++) {
                    const conditions = Array.from({ length: 1 + Math.floor(random() * 3) }, () => randomText(random, pieces, 6));
                    expect(autoKey.extractColumnNames(conditions), JSON.stringify(conditions)).to.deep.equal(v290.extractColumnNames(conditions));
                }
            });

            it('merges invalidation patterns exactly like v2.9.0 (randomized)', () => {
                const pieces = ['users', 'a', '_', ':', '*', '?', '[', ']', '\\', '^', '-', 'é', run('*'), random => (random() < 0.5 ? '*' : '')];
                const random = seededRandom(10);
                for (let i = 0; i < 2000; i++) {
                    const patterns = Array.from({ length: 1 + Math.floor(random() * 5) }, () => (random() < 0.05 ? null : randomText(random, pieces, 4)));
                    expect(mergeInvalidationPatterns(patterns), JSON.stringify(patterns)).to.deep.equal(v290.mergeInvalidationPatterns(patterns));
                }
            });

            it('handles 100k-character inputs under 200 ms', () => {
                const N = 100000;
                const checks = [
                    () => autoKey.generateCacheKey(`SELECT * FROM notes WHERE body = '${' '.repeat(N)}x' AND owner_id = ?`, [1]),
                    () => autoKey.extractWhereConditions(`SELECT * FROM t WHERE a = ?${'\t'.repeat(N)}x`),
                    () => autoKey.extractColumnNames([`body REGEXP ${'a'.repeat(N)}`]),
                    () => mergeInvalidationPatterns([`search:${'*'.repeat(N)}x`, `k${'*'.repeat(N)}`])
                ];
                for (const check of checks) {
                    const start = process.hrtime.bigint();
                    check();
                    expect(elapsedMs(start), check.toString()).to.be.below(200);
                }
            });
        });
    });

    describe('ES module named imports (D18)', () => {
        it('lets Node detect every export, so import { getCacheQuery } from works', function (done) {
            this.timeout(20000);
            const url = pathToFileURL(require.resolve('../index')).href;
            const code = [
                `import { getCacheQuery, closeConnections } from ${JSON.stringify(url)};`,
                "console.log('imported', typeof getCacheQuery, typeof closeConnections);",
                'await closeConnections();'
            ].join('\n');

            execFile(process.execPath, ['--input-type=module', '-e', code], {
                cwd: path.join(__dirname, '..'),
                env: { ...process.env, DB_HOST: 'localhost', DB_USERNAME: 'root', DB_NAME: 'app_db', REDIS_ENABLED: 'false', NODE_OPTIONS: '' },
                timeout: 15000
            }, (err, stdout, stderr) => {
                try {
                    expect(err, stderr).to.be.null;
                    expect(stdout).to.include('imported function function');
                    done();
                } catch (assertion) {
                    done(assertion);
                }
            });
        });

        it('still exports exactly the 17 CommonJS names, and default is the module itself', () => {
            setEnv({ DB_HOST: 'localhost', DB_USERNAME: 'test', DB_NAME: 'testdb', REDIS_ENABLED: 'false' });
            const index = require('../index');

            expect(Object.keys(index)).to.deep.equal([
                'QuaryCache', 'getCacheQuery', 'getCacheQueryPagination', 'bulkInsert', 'getCacheQueryWithTimeout',
                'closeConnections', 'getPoolStats', 'withTransaction', 'getArrayItem', 'addArrayItem', 'delKeyItem',
                'delPrefixKeyItem', 'isRedisConnected', 'getRedisClient', 'enableAutoKey', 'enableAutoInvalidation', 'configure'
            ]);
            expect(index.default).to.equal(index);
            expect(index.configure).to.be.a('function');
        });
    });
});
