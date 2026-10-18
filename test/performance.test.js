/**
 * Performance & Resilience Tests (v2.9.0)
 *
 * Connection release before Redis I/O, USE isolation between pooled callers,
 * COUNT(*) pagination with legacy fallback, bulkInsert resume on retry, merged
 * invalidation patterns, Redis fail-fast / command timeout / lazy client,
 * streamed prefix deletes, auto-key memoization and anchored table extraction.
 */

const chai = require('chai');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');
const proxyquire = require('proxyquire');

chai.use(sinonChai);
const { expect } = chai;

const ENV_KEYS = [
    'DB_HOST', 'DB_USERNAME', 'DB_NAME', 'REDIS_ENABLED', 'REDIS_SERVER', 'REDIS_PORT', 'REDIS_VHOST',
    'REDIS_PASSWORD', 'REDIS_WAIT_TIMEOUT', 'REDIS_COMMAND_TIMEOUT', 'REDIS_FAIL_FAST', 'REDIS_SCAN_COUNT',
    'REDIS_RECONNECT_MAX_DELAY', 'CORE_AUTO_INVALIDATION', 'DB_COALESCE_QUERIES', 'CORE_AUTO_FEATURES',
    'DB_PAGINATION_REUSE_TOTAL'
];

function clearEnv() {
    ENV_KEYS.forEach(key => delete process.env[key]);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('Performance & Resilience (v2.9.0)', () => {
    afterEach(() => {
        sinon.restore();
        clearEnv();
    });

    describe('dbConnector', () => {
        let dbConnector;
        let mockConnection;
        let mockPool;
        let mockRedis;

        beforeEach(() => {
            mockConnection = {
                query: sinon.stub(),
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

            process.env.DB_HOST = 'localhost';
            process.env.DB_USERNAME = 'root';
            process.env.DB_NAME = 'app_db';
            process.env.REDIS_ENABLED = 'true';
            process.env.REDIS_SERVER = 'localhost';

            dbConnector = proxyquire('../dbConnector', {
                'mysql2/promise': { createPool: sinon.stub().returns(mockPool) },
                './redis.Connector': mockRedis
            });
        });

        const executedSql = () => mockConnection.query.getCalls().map(call => call.args[0]);

        describe('Connection is released before Redis I/O', () => {
            it('getCacheQuery releases before writing the cache', async () => {
                mockConnection.query.resolves([[{ id: 1 }]]);

                await dbConnector.getCacheQuery('SELECT * FROM users WHERE id = ?', [1], 'users-1');

                expect(mockConnection.release).to.have.been.calledOnce;
                expect(mockConnection.release).to.have.been.calledBefore(mockRedis.addArrayItem);
            });

            it('getCacheQueryWithTimeout releases before writing the cache', async () => {
                mockConnection.query.resolves([[{ id: 1 }]]);

                await dbConnector.getCacheQueryWithTimeout('SELECT 1', [], 'one', { timeout: 1000 });

                expect(mockConnection.release).to.have.been.calledBefore(mockRedis.addArrayItem);
            });

            it('QuaryCache releases before invalidating', async () => {
                mockConnection.query.resolves([{ affectedRows: 1 }]);

                await dbConnector.QuaryCache('UPDATE users SET name = ?', ['x'], 'users');

                expect(mockConnection.release).to.have.been.calledBefore(mockRedis.delPrefixKeyItem);
            });

            it('getCacheQueryPagination releases before writing the cache', async () => {
                mockConnection.query.onCall(0).resolves([[{ id: 1 }]]);
                mockConnection.query.onCall(1).resolves([[{ total: 3 }]]);

                await dbConnector.getCacheQueryPagination('SELECT * FROM users', [], 'users', 0, 1);

                expect(mockConnection.release).to.have.been.calledBefore(mockRedis.addArrayItem);
            });

            it('withTransaction releases before applying buffered invalidations', async () => {
                mockConnection.query.resolves([{ affectedRows: 1 }]);

                await dbConnector.withTransaction(async (tx) => {
                    await tx.query('UPDATE users SET name = ?', ['x'], 'users');
                });

                expect(mockConnection.commit).to.have.been.calledBefore(mockConnection.release);
                expect(mockConnection.release).to.have.been.calledBefore(mockRedis.delPrefixKeyItem);
            });

            it('bulkInsert releases before invalidating', async () => {
                mockConnection.query.resolves([{ affectedRows: 1 }]);

                await dbConnector.bulkInsert('users', [{ name: 'a' }], { resetCacheName: 'users' });

                expect(mockConnection.release).to.have.been.calledBefore(mockRedis.delPrefixKeyItem);
            });
        });

        describe('USE isolation between pooled callers', () => {
            it('switches a connection back to the default database for the next caller', async () => {
                mockConnection.query.resolves([[{ id: 1 }]]);

                await dbConnector.QuaryCache('SELECT 1', [], null, 'tenant_db');
                await dbConnector.QuaryCache('SELECT 2', []);
                await dbConnector.QuaryCache('SELECT 3', []);

                expect(executedSql()).to.deep.equal([
                    'USE `tenant_db`', 'SELECT 1',
                    'USE `app_db`', 'SELECT 2',
                    'SELECT 3'
                ]);
            });

            it('skips USE when the connection is already on the requested database', async () => {
                mockConnection.query.resolves([[{ id: 1 }]]);

                await dbConnector.QuaryCache('SELECT 1', [], null, 'tenant_db');
                await dbConnector.QuaryCache('SELECT 2', [], null, 'tenant_db');
                await dbConnector.getCacheQuery('SELECT 3', [], 'three', 'tenant_db');
                await dbConnector.QuaryCache('SELECT 4', [], null, 'app_db');
                await dbConnector.getCacheQuery('SELECT 5', [], 'five');

                expect(executedSql()).to.deep.equal([
                    'USE `tenant_db`', 'SELECT 1', 'SELECT 2', 'SELECT 3',
                    'USE `app_db`', 'SELECT 4', 'SELECT 5'
                ]);
            });

            it('reselects the database after caller SQL that may contain USE', async () => {
                mockConnection.query.resolves([[{ id: 1 }]]);

                await dbConnector.QuaryCache('SELECT 1', [], null, 'tenant_db');
                await dbConnector.QuaryCache('USE reports', []);
                await dbConnector.QuaryCache('SELECT 2', [], null, 'tenant_db');
                await dbConnector.QuaryCache('SELECT 3', []);

                expect(executedSql()).to.deep.equal([
                    'USE `tenant_db`', 'SELECT 1',
                    'USE `app_db`', 'USE reports',
                    'USE `tenant_db`', 'SELECT 2',
                    'USE `app_db`', 'SELECT 3'
                ]);
            });

            it('reselects the database after the raw transaction connection was exposed', async () => {
                mockConnection.query.resolves([[{ id: 1 }]]);

                await dbConnector.withTransaction(async (tx) => {
                    tx.getConnection();
                });
                await dbConnector.QuaryCache('SELECT 1', []);

                expect(executedSql()).to.deep.equal(['USE `app_db`', 'SELECT 1']);
            });

            it('escapes backticks in database names', async () => {
                mockConnection.query.resolves([[{ id: 1 }]]);

                await dbConnector.QuaryCache('SELECT 1', [], null, 'odd`name');

                expect(mockConnection.query.firstCall.args[0]).to.equal('USE `odd``name`');
            });

            it('runs a transaction without database on the default database', async () => {
                mockConnection.query.resolves([{ affectedRows: 1 }]);

                await dbConnector.QuaryCache('SELECT 1', [], null, 'tenant_db');
                await dbConnector.withTransaction(async (tx) => {
                    await tx.query('INSERT INTO logs (a) VALUES (?)', [1]);
                });

                expect(executedSql()).to.deep.equal([
                    'USE `tenant_db`', 'SELECT 1',
                    'USE `app_db`', 'INSERT INTO logs (a) VALUES (?)'
                ]);
            });

            it('keeps tracking per connection (different connections are independent)', async () => {
                const second = { query: sinon.stub().resolves([[{ id: 2 }]]), release: sinon.stub() };
                mockConnection.query.resolves([[{ id: 1 }]]);
                mockPool.getConnection.onCall(1).resolves(second);

                await dbConnector.QuaryCache('SELECT 1', [], null, 'tenant_db');
                await dbConnector.QuaryCache('SELECT 2', []);

                expect(second.query.getCalls().map(call => call.args[0])).to.deep.equal(['SELECT 2']);
            });
        });

        describe('Pagination count', () => {
            const SQL = 'SELECT a.id, b.id FROM a JOIN b ON a.id = b.id';

            const COUNT_SQL = /^SELECT COUNT\(\*\) AS total FROM \(/;
            const countCalls = () => executedSql().filter(sql => COUNT_SQL.test(sql));

            it('counts a full page with SELECT COUNT(*) instead of fetching every row', async () => {
                mockConnection.query.onCall(0).resolves([[{ id: 1 }, { id: 2 }]]);
                mockConnection.query.onCall(1).resolves([[{ total: 42 }]]);

                const result = await dbConnector.getCacheQueryPagination(
                    'SELECT * FROM users WHERE status = ?;', ['active'], 'users', 1, 2
                );

                expect(result).to.deep.equal({ totalCount: 42, pageCount: 21, detail: [{ id: 1 }, { id: 2 }] });
                expect(mockConnection.query.firstCall.args).to.deep.equal([
                    'SELECT * FROM users WHERE status = ?\nLIMIT ?, ?',
                    ['active', 2, 2]
                ]);
                expect(mockConnection.query.secondCall.args).to.deep.equal([
                    'SELECT COUNT(*) AS total FROM (\nSELECT * FROM users WHERE status = ?\n) AS _pagination_count',
                    ['active']
                ]);
            });

            it('skips COUNT when the page is short, because it is the last page', async () => {
                mockConnection.query.resolves([[{ id: 31 }, { id: 32 }, { id: 33 }, { id: 34 }]]);

                const result = await dbConnector.getCacheQueryPagination('SELECT * FROM users', [], 'users', 3, 10);

                expect(result).to.deep.include({ totalCount: 34, pageCount: 4 });
                expect(mockConnection.query).to.have.been.calledOnce;
            });

            it('skips COUNT for an empty first page', async () => {
                mockConnection.query.resolves([[]]);

                const result = await dbConnector.getCacheQueryPagination('SELECT * FROM users', [], 'users', 0, 10);

                expect(result).to.deep.equal({ totalCount: 0, pageCount: 0, detail: [] });
                expect(countCalls()).to.be.empty;
            });

            it('still counts for a page past the end', async () => {
                mockConnection.query.onCall(0).resolves([[]]);
                mockConnection.query.onCall(1).resolves([[{ total: 12 }]]);

                const result = await dbConnector.getCacheQueryPagination('SELECT * FROM users', [], 'users', 5, 10);

                expect(result).to.deep.equal({ totalCount: 12, pageCount: 2, detail: [] });
                expect(countCalls()).to.have.lengthOf(1);
            });

            it('falls back to the full-fetch count when MySQL rejects the wrapper, and remembers it', async () => {
                const duplicate = Object.assign(new Error("Duplicate column name 'id'"), {
                    code: 'ER_DUP_FIELDNAME', errno: 1060, sqlState: '42S21', fatal: false
                });
                mockConnection.query.onCall(0).resolves([[{ id: 1 }]]);
                mockConnection.query.onCall(1).rejects(duplicate);
                mockConnection.query.onCall(2).resolves([[{ id: 1 }, { id: 1 }, { id: 2 }]]);

                const first = await dbConnector.getCacheQueryPagination(SQL, [], 'dup', 0, 1);
                expect(first.totalCount).to.equal(3);
                expect(first.pageCount).to.equal(3);

                mockConnection.query.reset();
                mockConnection.query.onCall(0).resolves([[{ id: 2 }]]);
                mockConnection.query.onCall(1).resolves([[{ id: 1 }, { id: 1 }, { id: 2 }]]);

                const second = await dbConnector.getCacheQueryPagination(SQL, [], 'dup', 1, 1);
                expect(second.totalCount).to.equal(3);
                expect(countCalls()).to.be.empty;
                expect(mockConnection.query.secondCall.args[0]).to.equal(SQL);
            });

            it('reports errors of the query itself exactly like before', async () => {
                mockConnection.query.rejects(Object.assign(new Error("Unknown column 'x'"), {
                    code: 'ER_BAD_FIELD_ERROR', errno: 1054, sqlState: '42S22', fatal: false
                }));

                try {
                    await dbConnector.getCacheQueryPagination('SELECT x FROM users', [], 'bad', 0, 10);
                    expect.fail('Should have thrown');
                } catch (error) {
                    expect(error.code).to.equal('ER_BAD_FIELD_ERROR');
                }
                expect(mockConnection.query).to.have.been.calledOnce;
            });

            it('lets connection-level errors reach the retry logic', async function () {
                this.timeout(5000);
                const lost = Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true });
                mockConnection.query.onCall(0).resolves([Array.from({ length: 10 }, (_, i) => ({ id: i }))]);
                mockConnection.query.onCall(1).rejects(lost);
                mockConnection.query.onCall(2).resolves([Array.from({ length: 10 }, (_, i) => ({ id: i }))]);
                mockConnection.query.onCall(3).resolves([[{ total: 25 }]]);

                const result = await dbConnector.getCacheQueryPagination('SELECT * FROM users', [], 'retry', 0, 10);

                expect(result.totalCount).to.equal(25);
                expect(mockConnection.query.callCount).to.equal(4);
                expect(countCalls()).to.have.lengthOf(2);
            });
        });

        describe('Auto keys per database', () => {
            const { generateCacheKey } = require('../core/autoKey');
            const SQL = 'SELECT * FROM users WHERE active = 1';

            beforeEach(() => {
                process.env.CORE_AUTO_FEATURES = 'true';
                mockConnection.query.resolves([[{ id: 1 }]]);
            });

            it('keeps the generated key unchanged when no database is given', async () => {
                await dbConnector.getCacheQuery(SQL, []);

                expect(mockRedis.getArrayItem).to.have.been.calledWith(generateCacheKey(SQL, []));
            });

            it('gives each database its own key (no rows shared between tenants)', async () => {
                await dbConnector.getCacheQuery(SQL, [], null, 'tenant_1');
                await dbConnector.getCacheQuery(SQL, [], null, 'tenant_2');

                const keys = mockRedis.getArrayItem.getCalls().map(call => call.args[0]);
                expect(keys).to.deep.equal([`${generateCacheKey(SQL, [])}@tenant_1`, `${generateCacheKey(SQL, [])}@tenant_2`]);
                // still under the table prefix that auto-invalidation deletes
                keys.forEach(key => expect(key.startsWith('users:')).to.be.true);
            });

            it('applies to tx.getCacheQuery in a transaction on another database', async () => {
                await dbConnector.withTransaction(async (tx) => {
                    await tx.getCacheQuery(SQL, []);
                }, { database: 'tenant_1' });

                expect(mockRedis.getArrayItem).to.have.been.calledWith(`${generateCacheKey(SQL, [])}@tenant_1`);
            });
        });

        describe('Request coalescing', () => {
            const SQL = 'SELECT id, name, created_at, avatar FROM users WHERE id = ?';
            const row = () => ({ id: 1, name: 'Ada', created_at: new Date(0), avatar: Buffer.from('png') });

            function slowQuery(result = () => [row()]) {
                mockConnection.query.callsFake(async () => {
                    await sleep(10);
                    return [result()];
                });
            }

            it('runs one query for concurrent misses and gives every caller its own copy', async () => {
                slowQuery();

                const results = await Promise.all(Array.from({ length: 20 }, () =>
                    dbConnector.getCacheQuery(SQL, [1], 'user-1')));

                expect(mockConnection.query).to.have.been.calledOnce;
                expect(mockRedis.addArrayItem).to.have.been.calledOnce;
                results[0][0].name = 'changed';
                results.slice(1).forEach((result) => {
                    expect(result).to.not.equal(results[0]);
                    expect(result[0].name).to.equal('Ada');
                    expect(result[0].created_at).to.be.instanceOf(Date);
                    expect(Buffer.isBuffer(result[0].avatar)).to.be.true;
                });
            });

            it('does not share loads between different parameters, databases or cache keys', async () => {
                slowQuery();

                await Promise.all([
                    dbConnector.getCacheQuery(SQL, [1], 'user'),
                    dbConnector.getCacheQuery(SQL, [2], 'user'),
                    dbConnector.getCacheQuery(SQL, [1], 'user', 'tenant_db'),
                    dbConnector.getCacheQuery(SQL, [1], 'other-key'),
                    dbConnector.getCacheQuery(SQL, [new Date(0)], 'user'),
                    dbConnector.getCacheQuery(SQL, [new Date(0).toISOString()], 'user')
                ]);

                expect(executedSql().filter(sql => sql === SQL)).to.have.lengthOf(6);
            });

            it('never shares statements that may write', async () => {
                slowQuery(() => ({ affectedRows: 1 }));

                await Promise.all([
                    dbConnector.getCacheQuery('INSERT INTO hits (page) VALUES (?)', ['home'], 'hits'),
                    dbConnector.getCacheQuery('INSERT INTO hits (page) VALUES (?)', ['home'], 'hits'),
                    dbConnector.getCacheQuery('SELECT 1; DELETE FROM hits', [], 'multi'),
                    dbConnector.getCacheQuery('SELECT 1; DELETE FROM hits', [], 'multi')
                ]);

                expect(mockConnection.query).to.have.callCount(4);
            });

            it('lets waiting callers run their own query when the shared one fails', async () => {
                let calls = 0;
                mockConnection.query.callsFake(async () => {
                    calls++;
                    await sleep(10);
                    if (calls === 1) throw Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' });
                    return [[row()]];
                });

                const results = await Promise.allSettled(Array.from({ length: 3 }, () =>
                    dbConnector.getCacheQuery(SQL, [1], 'user-1')));

                expect(results[0].status).to.equal('rejected');
                expect(results.slice(1).every(result => result.status === 'fulfilled')).to.be.true;
                expect(mockConnection.query).to.have.been.calledThrice;
            });

            it('does not let a read that starts after a write join a load that started before it', async () => {
                slowQuery();

                const before = dbConnector.getCacheQuery(SQL, [1], 'user-1');
                await sleep(1);
                await dbConnector.QuaryCache('UPDATE users SET name = ? WHERE id = ?', ['Grace', 1]);
                const after = dbConnector.getCacheQuery(SQL, [1], 'user-1');
                await Promise.all([before, after]);

                expect(executedSql().filter(sql => sql === SQL)).to.have.lengthOf(2);
            });

            it('coalesces concurrent misses of the same page', async () => {
                slowQuery(() => [{ id: 1 }, { id: 2 }]);

                const results = await Promise.all(Array.from({ length: 10 }, () =>
                    dbConnector.getCacheQueryPagination('SELECT * FROM users', [], 'users', 0, 10)));

                expect(mockConnection.query).to.have.been.calledOnce;
                expect(results.every(result => result.totalCount === 2)).to.be.true;
                expect(results[1].detail).to.not.equal(results[0].detail);
            });

            it('DB_COALESCE_QUERIES=false runs every query', async () => {
                process.env.DB_COALESCE_QUERIES = 'false';
                dbConnector = proxyquire('../dbConnector', {
                    'mysql2/promise': { createPool: sinon.stub().returns(mockPool) },
                    './redis.Connector': mockRedis
                });
                slowQuery();

                await Promise.all(Array.from({ length: 5 }, () => dbConnector.getCacheQuery(SQL, [1], 'user-1')));

                expect(mockConnection.query).to.have.callCount(5);
            });
        });

        describe('DB_PAGINATION_REUSE_TOTAL', () => {
            const fullPage = () => [Array.from({ length: 10 }, (_, i) => ({ id: i }))];
            const isTotalKey = key => /^users:total:[0-9a-f]{16}$/.test(key);

            function reload() {
                process.env.DB_PAGINATION_REUSE_TOTAL = 'true';
                dbConnector = proxyquire('../dbConnector', {
                    'mysql2/promise': { createPool: sinon.stub().returns(mockPool) },
                    './redis.Connector': mockRedis
                });
            }

            it('counts once and stores the total under the cache name', async () => {
                reload();
                mockConnection.query.onCall(0).resolves(fullPage());
                mockConnection.query.onCall(1).resolves([[{ total: 500 }]]);

                const result = await dbConnector.getCacheQueryPagination('SELECT * FROM users', [], 'users', 0, 10);

                expect(result.totalCount).to.equal(500);
                const totalWrite = mockRedis.addArrayItem.getCalls().find(call => isTotalKey(call.args[0]));
                expect(totalWrite.args[1]).to.deep.equal([500]);
            });

            it('reuses a stored total for the other pages instead of counting again', async () => {
                reload();
                mockRedis.getArrayItem.callsFake(async key => (isTotalKey(key) ? [500] : []));
                mockConnection.query.resolves(fullPage());

                const result = await dbConnector.getCacheQueryPagination('SELECT * FROM users', [], 'users', 7, 10);

                expect(result).to.deep.include({ totalCount: 500, pageCount: 50 });
                expect(mockConnection.query).to.have.been.calledOnce;
            });

            it('counts again when a page past the stored total comes back empty', async () => {
                reload();
                mockRedis.getArrayItem.callsFake(async key => (isTotalKey(key) ? [500] : []));
                mockConnection.query.onCall(0).resolves([[]]);
                mockConnection.query.onCall(1).resolves([[{ total: 300 }]]);

                const result = await dbConnector.getCacheQueryPagination('SELECT * FROM users', [], 'users', 40, 10);

                expect(result.totalCount).to.equal(300);
                expect(mockConnection.query).to.have.been.calledTwice;
            });

            it('is off by default', async () => {
                mockConnection.query.onCall(0).resolves(fullPage());
                mockConnection.query.onCall(1).resolves([[{ total: 500 }]]);

                await dbConnector.getCacheQueryPagination('SELECT * FROM users', [], 'users', 0, 10);

                const keys = mockRedis.getArrayItem.getCalls().concat(mockRedis.addArrayItem.getCalls()).map(call => call.args[0]);
                expect(keys.some(isTotalKey)).to.be.false;
            });
        });

        describe('bulkInsert', () => {
            it('builds the same INSERT statement as before', async () => {
                mockConnection.query.resolves([{ affectedRows: 2 }]);

                await dbConnector.bulkInsert('users', [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);

                expect(mockConnection.query.firstCall.args).to.deep.equal([
                    'INSERT INTO users (id,name) VALUES (?,?),(?,?)',
                    [1, 'a', 2, 'b']
                ]);
            });

            it('transaction: true commits all chunks together', async () => {
                mockConnection.query.resolves([{ affectedRows: 2 }]);

                const result = await dbConnector.bulkInsert('users', [1, 2, 3, 4].map(id => ({ id })), { chunkSize: 2, transaction: true });

                expect(result).to.deep.equal({ insertedRows: 4, chunks: 2 });
                expect(mockConnection.beginTransaction).to.have.been.calledBefore(mockConnection.query);
                expect(mockConnection.commit).to.have.been.calledOnce;
                expect(mockConnection.commit).to.have.been.calledAfter(mockConnection.query);
            });

            it('transaction: true rolls back on error and inserts nothing', async () => {
                mockConnection.query.onCall(0).resolves([{ affectedRows: 2 }]);
                mockConnection.query.onCall(1).rejects(Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' }));

                try {
                    await dbConnector.bulkInsert('users', [1, 2, 3, 4].map(id => ({ id })), { chunkSize: 2, transaction: true });
                    expect.fail('Should have thrown');
                } catch (error) {
                    expect(error.code).to.equal('ER_DUP_ENTRY');
                }
                expect(mockConnection.rollback).to.have.been.calledOnce;
                expect(mockConnection.commit).to.not.have.been.called;
            });

            it('transaction: true starts over after a connection error (the attempt was rolled back)', async function () {
                this.timeout(5000);
                const lost = Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
                mockConnection.query.onCall(0).resolves([{ affectedRows: 2 }]);
                mockConnection.query.onCall(1).rejects(lost);
                mockConnection.query.resolves([{ affectedRows: 2 }]);

                const result = await dbConnector.bulkInsert('users', [1, 2, 3, 4].map(id => ({ id })), { chunkSize: 2, transaction: true });

                expect(result).to.deep.equal({ insertedRows: 4, chunks: 2 });
                expect(mockConnection.query.getCalls().map(call => call.args[1])).to.deep.equal([[1, 2], [3, 4], [1, 2], [3, 4]]);
                expect(mockConnection.beginTransaction).to.have.been.calledTwice;
            });

            it('resumes at the first unacknowledged chunk after a connection error', async function () {
                this.timeout(5000);
                const lost = Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
                mockConnection.query.onCall(0).resolves([{ affectedRows: 2 }]);
                mockConnection.query.onCall(1).rejects(lost);
                mockConnection.query.onCall(2).resolves([{ affectedRows: 2 }]);
                mockConnection.query.onCall(3).resolves([{ affectedRows: 1 }]);

                const records = [1, 2, 3, 4, 5].map(id => ({ id, name: `n${id}` }));
                const result = await dbConnector.bulkInsert('users', records, { chunkSize: 2 });

                expect(result).to.deep.equal({ insertedRows: 5, chunks: 3 });
                expect(mockConnection.query.getCalls().map(call => call.args[1])).to.deep.equal([
                    [1, 'n1', 2, 'n2'],
                    [3, 'n3', 4, 'n4'],
                    [3, 'n3', 4, 'n4'],
                    [5, 'n5']
                ]);
                expect(mockConnection.release).to.have.been.calledTwice;
            });
        });

        describe('Invalidation patterns', () => {
            it('invalidates the default auto pattern pair with a single SCAN pass', async () => {
                process.env.CORE_AUTO_INVALIDATION = 'true';
                mockConnection.query.resolves([{ affectedRows: 1 }]);

                await dbConnector.QuaryCache('UPDATE users SET name = ? WHERE id = ?', ['x', 1]);

                expect(mockRedis.delPrefixKeyItem).to.have.been.calledOnceWithExactly('users[_:]*');
            });

            it('keeps unrelated patterns as separate calls', async () => {
                mockConnection.query.resolves([{ affectedRows: 1 }]);

                await dbConnector.QuaryCache('UPDATE users SET a = 1', [], ['users_*', 'orders_*']);

                expect(mockRedis.delPrefixKeyItem.getCalls().map(call => call.args[0])).to.deep.equal(['users_*', 'orders_*']);
            });
        });

        describe('getCacheQueryWithTimeout', () => {
            it('does not run a query whose caller timed out while waiting for a connection', async () => {
                let grantConnection;
                mockPool.getConnection.callsFake(() => new Promise((resolve) => {
                    grantConnection = () => resolve(mockConnection);
                }));
                mockConnection.query.resolves([[{ id: 1 }]]);

                try {
                    await dbConnector.getCacheQueryWithTimeout('SELECT 1', [], 'k', { timeout: 30 });
                    expect.fail('Should have timed out');
                } catch (error) {
                    expect(error.message).to.equal('Query timeout exceeded');
                }
                grantConnection();
                await sleep(10);

                expect(mockConnection.query).to.not.have.been.called;
                expect(mockConnection.release).to.have.been.calledOnce;
                expect(mockRedis.addArrayItem).to.not.have.been.called;
            });

            it('lets a running query finish and cache its result by default, as before', async () => {
                mockConnection.query.callsFake(async () => {
                    await sleep(60);
                    return [[{ id: 1 }]];
                });

                try {
                    await dbConnector.getCacheQueryWithTimeout('SELECT 1', [], 'k', { timeout: 20 });
                    expect.fail('Should have timed out');
                } catch (error) {
                    expect(error.message).to.equal('Query timeout exceeded');
                }
                await sleep(80);

                expect(mockRedis.addArrayItem).to.have.been.calledOnceWith('k', [{ id: 1 }]);
            });

            it('cancelOnTimeout kills the running query and does not cache it', async () => {
                const killer = { query: sinon.stub().resolves([{}]), end: sinon.stub().resolves() };
                dbConnector = proxyquire('../dbConnector', {
                    'mysql2/promise': { createPool: sinon.stub().returns(mockPool), createConnection: sinon.stub().resolves(killer) },
                    './redis.Connector': mockRedis
                });
                mockConnection.threadId = 77;
                mockConnection.query.callsFake(async () => {
                    await sleep(60);
                    return [[{ id: 1 }]];
                });

                try {
                    await dbConnector.getCacheQueryWithTimeout('SELECT SLEEP(10)', [], 'k', { timeout: 20, cancelOnTimeout: true });
                    expect.fail('Should have timed out');
                } catch (error) {
                    expect(error.message).to.equal('Query timeout exceeded');
                }
                await sleep(80);

                expect(killer.query).to.have.been.calledWith('KILL QUERY ?', [77]);
                expect(killer.end).to.have.been.calledOnce;
                expect(mockRedis.addArrayItem).to.not.have.been.called;
            });
        });

        describe('closeConnections', () => {
            it("stops mysql2's idle-connection reaper after closing the pool", async () => {
                sinon.stub(console, 'log');
                const reaper = setTimeout(() => {}, 100000);
                mockPool.pool._removeIdleTimeoutConnectionsTimer = reaper;
                const clearTimeoutSpy = sinon.spy(global, 'clearTimeout');

                await dbConnector.closeConnections();

                expect(mockPool.end).to.have.been.calledOnce;
                expect(clearTimeoutSpy).to.have.been.calledWith(reaper);
                clearTimeout(reaper);
            });
        });
    });

    describe('redis.Connector', () => {
        function createMockClient({ ready = true } = {}) {
            const handlers = {};
            return {
                get: sinon.stub(),
                setex: sinon.stub().callsFake((key, ttl, value, callback) => callback(null, 'OK')),
                del: sinon.stub().callsFake((...args) => args[args.length - 1](null, 1)),
                scan: sinon.stub(),
                on: sinon.stub().callsFake((event, handler) => {
                    (handlers[event] = handlers[event] || []).push(handler);
                    if (event === 'ready' && ready) handler();
                }),
                once: sinon.stub(),
                removeListener: sinon.stub(),
                setMaxListeners: sinon.stub(),
                emit(event, ...args) {
                    (handlers[event] || []).forEach(handler => handler(...args));
                }
            };
        }

        function load(client, env = {}) {
            Object.assign(process.env, { REDIS_SERVER: 'localhost', REDIS_PORT: '6379', REDIS_VHOST: 'app' }, env);
            const createClient = sinon.stub().returns(client);
            const connector = proxyquire('../redis.Connector', {
                redis: { createClient, '@noCallThru': true }
            });
            return { connector, createClient };
        }

        beforeEach(() => {
            sinon.stub(console, 'log');
            sinon.stub(console, 'error');
        });

        describe('Fail-fast during outages', () => {
            it('stops waiting for cache reads/writes once Redis has been down longer than REDIS_WAIT_TIMEOUT', async () => {
                const client = createMockClient();
                const { connector } = load(client, { REDIS_WAIT_TIMEOUT: '300' });

                client.emit('end');

                const start = Date.now();
                expect(await connector.getArrayItem('k')).to.deep.equal([]);
                expect(Date.now() - start).to.be.at.least(280);

                const fast = Date.now();
                expect(await connector.getArrayItem('k')).to.deep.equal([]);
                expect(await connector.addArrayItem('k', [1])).to.deep.equal([1]);
                expect(Date.now() - fast).to.be.below(150);
                expect(client.get).to.not.have.been.called;
                expect(client.setex).to.not.have.been.called;
            });

            it('keeps waiting for deletes so invalidations still run when Redis returns', async () => {
                const client = createMockClient();
                const { connector } = load(client, { REDIS_WAIT_TIMEOUT: '50' });

                client.emit('end');
                await sleep(80);

                const pending = connector.delKeyItem('k');
                setTimeout(() => client.emit('ready'), 20);
                await pending;

                expect(client.del).to.have.been.calledOnceWith('app:k');
            });

            it('resumes normal caching as soon as Redis is ready again', async () => {
                const client = createMockClient();
                client.get.callsFake((key, callback) => callback(null, JSON.stringify([7])));
                const { connector } = load(client, { REDIS_WAIT_TIMEOUT: '50' });

                client.emit('end');
                await sleep(80);
                expect(await connector.getArrayItem('k')).to.deep.equal([]);

                client.emit('ready');
                expect(await connector.getArrayItem('k')).to.deep.equal([7]);
                expect(client.get).to.have.been.calledOnce;
            });

            it('REDIS_FAIL_FAST=false keeps the old wait-on-every-call behavior', async () => {
                const client = createMockClient();
                const { connector } = load(client, { REDIS_WAIT_TIMEOUT: '100', REDIS_FAIL_FAST: 'false' });

                client.emit('end');
                await sleep(120);

                const start = Date.now();
                await connector.getArrayItem('k');
                expect(Date.now() - start).to.be.at.least(90);
            });

            it('releases every waiter on a single ready event without per-call listeners', async () => {
                const client = createMockClient();
                client.get.callsFake((key, callback) => callback(null, null));
                const { connector } = load(client, { REDIS_WAIT_TIMEOUT: '5000' });

                client.emit('end');
                const waiting = Array.from({ length: 500 }, (_, i) => connector.getArrayItem(`k${i}`));
                setTimeout(() => client.emit('ready'), 20);

                const results = await Promise.all(waiting);
                expect(results.every(result => Array.isArray(result) && result.length === 0)).to.be.true;
                expect(client.get.callCount).to.equal(500);
                expect(client.once).to.not.have.been.called;
                expect(client.removeListener).to.not.have.been.called;
            });
        });

        describe('Command timeout', () => {
            it('gives up on a command that never gets a reply and then fails fast', async () => {
                const client = createMockClient();
                client.get.onCall(1).callsFake((key, callback) => callback(null, JSON.stringify([9])));
                const { connector } = load(client, { REDIS_WAIT_TIMEOUT: '100', REDIS_COMMAND_TIMEOUT: '100' });

                const start = Date.now();
                expect(await connector.getArrayItem('hung')).to.deep.equal([]);
                const waited = Date.now() - start;
                expect(waited).to.be.at.least(95);
                expect(waited).to.be.below(1500);

                expect(await connector.getArrayItem('next')).to.deep.equal([]);
                expect(client.get).to.have.been.calledOnce;

                // The late reply to the first command proves the connection works again
                client.get.firstCall.args[1](null, JSON.stringify([1]));
                expect(await connector.getArrayItem('after')).to.deep.equal([9]);
            });

            it('does not leave a synchronously failing command to the watchdog', async () => {
                const client = createMockClient();
                client.get.onCall(0).throws(new Error('ERR invalid arguments'));
                client.get.onCall(1).callsFake((key, callback) => callback(null, JSON.stringify([5])));
                const { connector } = load(client, { REDIS_WAIT_TIMEOUT: '50', REDIS_COMMAND_TIMEOUT: '50' });

                expect(await connector.getArrayItem('k')).to.deep.equal([]);
                await sleep(250);

                expect(await connector.getArrayItem('k')).to.deep.equal([5]);
            });

            it('REDIS_COMMAND_TIMEOUT=0 sends commands without tracking them', async () => {
                const client = createMockClient();
                client.get.callsFake((key, callback) => callback(null, JSON.stringify([1])));
                const { connector } = load(client, { REDIS_COMMAND_TIMEOUT: '0' });

                expect(await connector.getArrayItem('k')).to.deep.equal([1]);
            });

            it('keeps the command timeout independent of a short REDIS_WAIT_TIMEOUT', async () => {
                const client = createMockClient();
                client.get.callsFake((key, callback) => setTimeout(() => callback(null, JSON.stringify([8])), 400));
                const { connector } = load(client, { REDIS_WAIT_TIMEOUT: '300' });

                expect(await connector.getArrayItem('slow')).to.deep.equal([8]);
            });

            it('probes again after a timeout and resumes as soon as Redis answers', async () => {
                const client = createMockClient();
                client.get.callsFake((key, callback) => callback(null, JSON.stringify([4])));
                client.get.onCall(0).callsFake(() => {}); // never answered
                const { connector } = load(client, { REDIS_WAIT_TIMEOUT: '100', REDIS_COMMAND_TIMEOUT: '100' });

                expect(await connector.getArrayItem('hung')).to.deep.equal([]);
                expect(await connector.getArrayItem('skipped')).to.deep.equal([]);
                expect(client.get).to.have.been.calledOnce;

                await sleep(150);
                expect(await connector.getArrayItem('probe')).to.deep.equal([4]);
                expect(await connector.getArrayItem('normal')).to.deep.equal([4]);
                expect(client.get).to.have.been.calledThrice;
            });

            it('treats a late error reply from Redis as proof the connection works', async () => {
                const client = createMockClient();
                client.get.callsFake((key, callback) => callback(null, JSON.stringify([6])));
                client.get.onCall(0).callsFake(() => {});
                const { connector } = load(client, { REDIS_WAIT_TIMEOUT: '100', REDIS_COMMAND_TIMEOUT: '100' });

                expect(await connector.getArrayItem('hung')).to.deep.equal([]);
                const replyError = new Error('BUSY Redis is busy running a script');
                Object.defineProperty(replyError, 'name', { value: 'ReplyError' });
                client.get.firstCall.args[1](replyError);

                expect(await connector.getArrayItem('k')).to.deep.equal([6]);
            });

            it('reconnects a connection that gave no reply at all for REDIS_COMMAND_TIMEOUT', async () => {
                const client = createMockClient();
                client.get.callsFake(() => {}); // silently dropped connection
                client.stream = { destroy: sinon.stub() };
                const { connector } = load(client, { REDIS_WAIT_TIMEOUT: '100', REDIS_COMMAND_TIMEOUT: '100' });

                expect(await connector.getArrayItem('k')).to.deep.equal([]);

                expect(client.stream.destroy).to.have.been.calledOnce;
            });
        });

        describe('Client lifecycle', () => {
            it('does not treat a command reply error as a lost connection', () => {
                const client = createMockClient();
                const { connector } = load(client);

                client.ready = true;
                client.emit('error', new Error('ERR wrong number of arguments'));
                expect(connector.isRedisConnected()).to.be.true;

                client.ready = false;
                client.emit('error', new Error('Connection lost'));
                expect(connector.isRedisConnected()).to.be.false;
            });

            it('does not connect when REDIS_ENABLED=false until Redis is used directly', async () => {
                const client = createMockClient();
                client.get.callsFake((key, callback) => callback(null, JSON.stringify([3])));
                const { connector, createClient } = load(client, { REDIS_ENABLED: 'false' });

                expect(createClient).to.not.have.been.called;

                expect(await connector.getArrayItem('k')).to.deep.equal([3]);
                expect(createClient).to.have.been.calledOnce;
                expect(connector.getRedisClient()).to.equal(client);
            });

            it('isRedisConnected() does not connect with REDIS_ENABLED=false, but reports a client created on demand', () => {
                const { connector, createClient } = load(createMockClient(), { REDIS_ENABLED: 'false' });

                expect(connector.isRedisConnected()).to.be.false;
                expect(createClient).to.not.have.been.called;

                connector.getRedisClient();
                expect(connector.isRedisConnected()).to.be.true; // the mock is ready as soon as it exists
            });

            it('logs each reconnect attempt once', () => {
                const client = createMockClient();
                const { createClient } = load(client);
                console.log.resetHistory();

                createClient.firstCall.args[0].retry_strategy({ attempt: 3 });
                client.emit('reconnecting', { attempt: 3, delay: 2100 });

                expect(console.log).to.have.been.calledOnceWithExactly('Redis reconnecting... (attempt 3, delay 2100ms)');
            });

            it('ignores invalid numeric settings', async () => {
                const client = createMockClient();
                client.scan.callsFake((...args) => args[args.length - 1](null, ['0', []]));
                const { connector, createClient } = load(client, { REDIS_SCAN_COUNT: '-5', REDIS_RECONNECT_MAX_DELAY: '-1' });

                await connector.delPrefixKeyItem('x');

                expect(client.scan.firstCall.args[4]).to.equal(1000);
                expect(createClient.firstCall.args[0].retry_strategy({ attempt: 30 })).to.be.within(5000, 6000);
            });

            it('omits an empty password and never stops reconnecting after an hour', () => {
                const { createClient } = load(createMockClient(), { REDIS_PASSWORD: '' });
                const options = createClient.firstCall.args[0];

                expect(options.password).to.be.undefined;
                expect(options.connect_timeout).to.equal(2147483647);
                expect(options.retry_strategy({ attempt: 30 })).to.be.at.most(6000);
            });

            it('REDIS_RECONNECT_MAX_DELAY raises the reconnect delay cap', () => {
                const { createClient } = load(createMockClient(), { REDIS_RECONNECT_MAX_DELAY: '30000' });

                expect(createClient.firstCall.args[0].retry_strategy({ attempt: 30 })).to.be.at.least(30000);
            });
        });

        describe('Deletes', () => {
            it('delKeyItem([]) does not call Redis', async () => {
                const client = createMockClient();
                const { connector } = load(client);

                await connector.delKeyItem([]);

                expect(client.del).to.not.have.been.called;
            });

            it('scans with COUNT 1000 and deletes while scanning', async () => {
                const client = createMockClient();
                const firstPage = Array.from({ length: 150 }, (_, i) => `app:pref${i}`);
                const secondPage = Array.from({ length: 60 }, (_, i) => `app:pref${150 + i}`);
                client.scan.onCall(0).callsFake((...args) => args[args.length - 1](null, ['7', firstPage]));
                client.scan.onCall(1).callsFake((...args) => args[args.length - 1](null, ['0', secondPage]));
                const { connector } = load(client);

                await connector.delPrefixKeyItem('pref');

                expect(client.scan.firstCall.args.slice(0, 5)).to.deep.equal(['0', 'MATCH', 'app:pref*', 'COUNT', 1000]);
                expect(client.del.getCalls().map(call => call.args.length - 1)).to.deep.equal([100, 100, 10]);
                expect(client.del.firstCall).to.have.been.calledBefore(client.scan.secondCall);
            });

            it('REDIS_SCAN_COUNT overrides the SCAN batch size', async () => {
                const client = createMockClient();
                client.scan.callsFake((...args) => args[args.length - 1](null, ['0', []]));
                const { connector } = load(client, { REDIS_SCAN_COUNT: '250' });

                await connector.delPrefixKeyItem('pref');

                expect(client.scan.firstCall.args[4]).to.equal(250);
            });

            it('merges prefixes that can share one SCAN pass', async () => {
                const client = createMockClient();
                client.scan.callsFake((...args) => args[args.length - 1](null, ['0', []]));
                const { connector } = load(client);

                await connector.delPrefixKeyItem(['users_', 'users:']);

                expect(client.scan).to.have.been.calledOnce;
                // delPrefixKeyItem appends '*' as always; '**' matches exactly like '*'
                expect(client.scan.firstCall.args[2]).to.equal('app:users[_:]**');
            });

            it('never cuts a prefix invalidation short (late SCAN replies still delete)', async () => {
                const client = createMockClient();
                client.scan.callsFake((...args) => setTimeout(() => args[args.length - 1](null, ['0', ['app:users:1']]), 300));
                const { connector } = load(client, { REDIS_WAIT_TIMEOUT: '100', REDIS_COMMAND_TIMEOUT: '100' });

                await connector.delPrefixKeyItem('users:');

                expect(client.del).to.have.been.calledOnceWith('app:users:1');
            });

            it('replays invalidations that failed while Redis was down once it is ready again', async () => {
                const client = createMockClient();
                client.scan.callsFake((...args) => args[args.length - 1](null, ['0', ['app:orders:1']]));
                const { connector } = load(client, { REDIS_WAIT_TIMEOUT: '50' });

                client.emit('end');
                await connector.delPrefixKeyItem('orders:');
                await connector.delKeyItem('session:1');
                expect(client.scan).to.not.have.been.called;
                expect(client.del).to.not.have.been.called;

                client.emit('ready');
                await sleep(10);

                expect(client.scan).to.have.been.calledOnce;
                expect(client.scan.firstCall.args[2]).to.equal('app:orders:*');
                expect(client.del).to.have.been.calledWith('app:orders:1');
                expect(client.del).to.have.been.calledWith(['app:session:1']);
            });
        });
    });

    describe('core', () => {
        const { mergeInvalidationPatterns, extractTableName } = require('../core/autoInvalidate');
        const autoKey = require('../core/autoKey');

        describe('mergeInvalidationPatterns', () => {
            it('merges the default auto-invalidation pair', () => {
                expect(mergeInvalidationPatterns(['users_*', 'users:*'])).to.deep.equal(['users[_:]*']);
            });

            it('drops prefixes covered by a shorter one and duplicates', () => {
                expect(mergeInvalidationPatterns(['users', 'users:list', 'users'])).to.deep.equal(['users']);
            });

            it('leaves unrelated and glob patterns untouched', () => {
                expect(mergeInvalidationPatterns(['users_*', 'orders_*'])).to.deep.equal(['users_*', 'orders_*']);
                expect(mergeInvalidationPatterns(['user?_a', 'user?_b'])).to.deep.equal(['user?_a', 'user?_b']);
            });

            it('escapes characters that are special inside a character class', () => {
                expect(mergeInvalidationPatterns(['k^', 'k-'])).to.deep.equal(['k[\\^\\-]*']);
            });
        });

        describe('extractTableName (statement-anchored)', () => {
            it('understands INSERT/UPDATE/DELETE modifiers', () => {
                expect(extractTableName('INSERT IGNORE INTO users (a) VALUES (?)')).to.equal('users');
                expect(extractTableName('UPDATE LOW_PRIORITY users SET a = ?')).to.equal('users');
                expect(extractTableName('DELETE QUICK IGNORE FROM users WHERE id = ?')).to.equal('users');
            });

            it('ignores keywords in the statement body', () => {
                expect(extractTableName('INSERT IGNORE INTO users (a) VALUES (?) ON DUPLICATE KEY UPDATE hits = hits + 1')).to.equal('users');
                expect(extractTableName("REPLACE INTO users (note) VALUES ('UPDATE orders')")).to.equal('users');
            });
        });

        describe('generateCacheKey memoization', () => {
            it('returns identical keys for repeated and evicted SQL', () => {
                const keysFor = () => Array.from({ length: 1500 }, (_, i) =>
                    autoKey.generateCacheKey(`SELECT * FROM t${i % 7} WHERE c${i} = ?`, [i]));

                const first = keysFor();
                const second = keysFor();

                expect(second).to.deep.equal(first);
                expect(first[3]).to.equal(`t3:c3:${autoKey.createParameterHash([3])}`);
            });
        });
    });
});
