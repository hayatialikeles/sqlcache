const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

describe('dbConnector', () => {
    let dbConnector;
    let mockPool;
    let mockConnection;
    let mockRedis;
    let getArrayItemStub;
    let addArrayItemStub;
    let delPrefixKeyItemStub;

    beforeEach(() => {
        // Mock connection
        mockConnection = {
            query: sinon.stub(),
            release: sinon.stub()
        };

        // Mock pool
        mockPool = {
            getConnection: sinon.stub().resolves(mockConnection)
        };

        // Mock mysql2/promise
        const mockMysql = {
            createPool: sinon.stub().returns(mockPool)
        };

        // Mock redis connector functions
        getArrayItemStub = sinon.stub();
        addArrayItemStub = sinon.stub();
        delPrefixKeyItemStub = sinon.stub();

        mockRedis = {
            getArrayItem: getArrayItemStub,
            addArrayItem: addArrayItemStub,
            delPrefixKeyItem: delPrefixKeyItemStub
        };

        // Mock dotenv
        process.env.DB_HOST = 'localhost';
        process.env.DB_USERNAME = 'root';
        process.env.DB_NAME = 'testdb';
        process.env.REDIS_ENABLED = 'true';
        process.env.REDIS_SERVER = 'localhost';

        // Load module with mocks
        dbConnector = proxyquire('../dbConnector', {
            'mysql2/promise': mockMysql,
            './redis.Connector': mockRedis
        });
    });

    afterEach(() => {
        sinon.restore();
        delete process.env.DB_HOST;
        delete process.env.DB_USERNAME;
        delete process.env.DB_NAME;
        delete process.env.REDIS_ENABLED;
        delete process.env.REDIS_SERVER;
        delete process.env.DB_PORT;
        delete process.env.DB_CONNECTION_LIMIT;
        delete process.env.DB_QUEUE_LIMIT;
        delete process.env.DB_CONNECT_TIMEOUT;
    });

    describe('Configuration Validation', () => {
        it('should throw error if DB_HOST is missing', () => {
            delete process.env.DB_HOST;

            expect(() => {
                proxyquire('../dbConnector', {
                    'mysql2/promise': { createPool: sinon.stub() },
                    './redis.Connector': mockRedis
                });
            }).to.throw('DB_HOST is required');
        });

        it('should throw error if DB_USERNAME is missing', () => {
            delete process.env.DB_USERNAME;

            expect(() => {
                proxyquire('../dbConnector', {
                    'mysql2/promise': { createPool: sinon.stub() },
                    './redis.Connector': mockRedis
                });
            }).to.throw('DB_USERNAME is required');
        });

        it('should throw error if DB_NAME is missing', () => {
            delete process.env.DB_NAME;

            expect(() => {
                proxyquire('../dbConnector', {
                    'mysql2/promise': { createPool: sinon.stub() },
                    './redis.Connector': mockRedis
                });
            }).to.throw('DB_NAME is required');
        });

        it('should throw error if REDIS_SERVER is missing when Redis is enabled', () => {
            delete process.env.REDIS_SERVER;

            expect(() => {
                proxyquire('../dbConnector', {
                    'mysql2/promise': { createPool: sinon.stub() },
                    './redis.Connector': mockRedis
                });
            }).to.throw('REDIS_SERVER is required');
        });

        it('should not throw error if REDIS_SERVER is missing when Redis is disabled', () => {
            delete process.env.REDIS_SERVER;
            process.env.REDIS_ENABLED = 'false';

            expect(() => {
                proxyquire('../dbConnector', {
                    'mysql2/promise': { createPool: sinon.stub() },
                    './redis.Connector': mockRedis
                });
            }).to.not.throw();
        });

        it('should throw error if DB_PORT is invalid', () => {
            process.env.DB_PORT = 'invalid';

            expect(() => {
                proxyquire('../dbConnector', {
                    'mysql2/promise': { createPool: sinon.stub() },
                    './redis.Connector': mockRedis
                });
            }).to.throw('DB_PORT must be a valid number');
        });
    });

    describe('QuaryCache', () => {
        it('should execute query and return data', async () => {
            const mockData = [{ id: 1, name: 'Test' }];
            mockConnection.query.resolves([mockData]);

            const result = await dbConnector.QuaryCache(
                'SELECT * FROM users WHERE id = ?',
                [1]
            );

            expect(result).to.deep.equal(mockData);
            expect(mockConnection.query.calledOnce).to.be.true;
            expect(mockConnection.release.calledOnce).to.be.true;
        });

        it('should reset cache when resetCacheName is provided', async () => {
            const mockData = [{ id: 1, name: 'Test' }];
            mockConnection.query.resolves([mockData]);
            delPrefixKeyItemStub.resolves();

            await dbConnector.QuaryCache(
                'INSERT INTO users SET name = ?',
                ['Test'],
                'users-cache'
            );

            expect(delPrefixKeyItemStub.calledWith('users-cache')).to.be.true;
        });

        it('should switch database when database parameter is provided', async () => {
            const mockData = [{ id: 1 }];
            mockConnection.query.resolves([mockData]);

            await dbConnector.QuaryCache(
                'SELECT * FROM users',
                [],
                null,
                'other_db'
            );

            expect(mockConnection.query.firstCall.args[0]).to.equal('USE `other_db`');
            expect(mockConnection.query.secondCall.args[0]).to.equal('SELECT * FROM users');
        });

        it('should release connection on error', async () => {
            mockConnection.query.rejects(new Error('DB Error'));

            try {
                await dbConnector.QuaryCache('SELECT * FROM users', []);
                expect.fail('Should have thrown error');
            } catch (err) {
                expect(err.message).to.equal('DB Error');
                expect(mockConnection.release.calledOnce).to.be.true;
            }
        });
    });

    describe('getCacheQuery', () => {
        it('should return cached data if available', async () => {
            const cachedData = [{ id: 1, name: 'Cached' }];
            getArrayItemStub.resolves(cachedData);

            const result = await dbConnector.getCacheQuery(
                'SELECT * FROM users',
                [],
                'users-cache'
            );

            expect(result).to.deep.equal(cachedData);
            expect(mockConnection.query.called).to.be.false;
        });

        it('should query database and cache result if cache miss', async () => {
            const dbData = [{ id: 1, name: 'Fresh' }];
            getArrayItemStub.resolves([]);
            mockConnection.query.resolves([dbData]);
            addArrayItemStub.resolves();

            const result = await dbConnector.getCacheQuery(
                'SELECT * FROM users WHERE id = ?',
                [1],
                'users-1'
            );

            expect(result).to.deep.equal(dbData);
            expect(mockConnection.query.calledOnce).to.be.true;
            expect(addArrayItemStub.calledWith('users-1', dbData)).to.be.true;
        });

        it('should switch database when provided', async () => {
            getArrayItemStub.resolves([]);
            mockConnection.query.resolves([[{ id: 1 }]]);
            addArrayItemStub.resolves();

            await dbConnector.getCacheQuery(
                'SELECT * FROM stats',
                [],
                'stats-cache',
                'analytics_db'
            );

            expect(mockConnection.query.firstCall.args[0]).to.equal('USE `analytics_db`');
        });

        it('should work when Redis is disabled', async () => {
            process.env.REDIS_ENABLED = 'false';

            // Reload module with Redis disabled
            dbConnector = proxyquire('../dbConnector', {
                'mysql2/promise': { createPool: sinon.stub().returns(mockPool) },
                './redis.Connector': mockRedis
            });

            const dbData = [{ id: 1 }];
            mockConnection.query.resolves([dbData]);

            const result = await dbConnector.getCacheQuery(
                'SELECT * FROM users',
                [],
                'cache-key'
            );

            expect(result).to.deep.equal(dbData);
            expect(getArrayItemStub.called).to.be.false;
            expect(addArrayItemStub.called).to.be.false;
        });

        it('should propagate database errors when Redis is disabled', async () => {
            process.env.REDIS_ENABLED = 'false';

            dbConnector = proxyquire('../dbConnector', {
                'mysql2/promise': { createPool: sinon.stub().returns(mockPool) },
                './redis.Connector': mockRedis
            });

            mockConnection.query.rejects({ code: 'ER_TABLE_NOT_FOUND', message: 'Table not found' });

            try {
                await dbConnector.getCacheQuery('SELECT * FROM nonexistent', [], 'cache');
                expect.fail('Should have thrown error');
            } catch (err) {
                expect(err.message).to.equal('Table not found');
                expect(mockConnection.release.calledOnce).to.be.true;
            }
        });
    });

    describe('getCacheQueryPagination', () => {
        // Answers pagination queries by SQL shape, so tests do not depend on the order in
        // which the page query and the COUNT(*) query run
        function mockPaginationQueries(total, pageData) {
            mockConnection.query.callsFake(async (sql) => {
                if (/^USE /.test(sql)) return [[]];
                if (/^SELECT COUNT\(\*\) AS total FROM \(/.test(sql)) return [[{ total }]];
                return [pageData];
            });
        }
        const pageQuery = () => mockConnection.query.getCalls().find(call => / LIMIT \?, \?$/.test(call.args[0]));

        it('should return cached pagination data if available', async () => {
            const cachedData = {
                totalCount: 100,
                pageCount: 10,
                detail: [{ id: 1 }]
            };
            getArrayItemStub.resolves(cachedData);

            const result = await dbConnector.getCacheQueryPagination(
                'SELECT * FROM users',
                [],
                'users-page-0',
                0,
                10
            );

            expect(result).to.deep.equal(cachedData);
            expect(mockConnection.query.called).to.be.false;
        });

        it('should query DB if cache returns array instead of object', async () => {
            getArrayItemStub.resolves([{ id: 1 }]); // Returns array, not pagination object

            const allData = Array(15).fill({ id: 1 });
            const pageData = Array(10).fill({ id: 1 });
            mockPaginationQueries(allData.length, pageData);
            addArrayItemStub.resolves();

            const result = await dbConnector.getCacheQueryPagination(
                'SELECT * FROM users',
                [],
                'cache',
                0,
                10
            );

            expect(result.totalCount).to.equal(15);
            expect(mockConnection.query.called).to.be.true;
        });

        it('should paginate and cache results on cache miss', async () => {
            const allData = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
            const pageData = allData.slice(0, 10);

            getArrayItemStub.resolves([]);
            mockPaginationQueries(allData.length, pageData);
            addArrayItemStub.resolves();

            const result = await dbConnector.getCacheQueryPagination(
                'SELECT * FROM users',
                [],
                'users-page-0',
                0,
                10
            );

            expect(result.totalCount).to.equal(50);
            expect(result.pageCount).to.equal(5);
            expect(result.detail).to.deep.equal(pageData);
            expect(addArrayItemStub.called).to.be.true;
        });

        it('should throw error if pageSize is 0 or negative', async () => {
            getArrayItemStub.resolves([]);

            try {
                await dbConnector.getCacheQueryPagination(
                    'SELECT * FROM users',
                    [],
                    'cache',
                    0,
                    0
                );
                expect.fail('Should have thrown error');
            } catch (err) {
                expect(err.message).to.equal('Page size must be greater than 0');
            }
        });

        it('should throw error if pageSize is negative', async () => {
            getArrayItemStub.resolves([]);

            try {
                await dbConnector.getCacheQueryPagination(
                    'SELECT * FROM users',
                    [],
                    'cache',
                    0,
                    -10
                );
                expect.fail('Should have thrown error');
            } catch (err) {
                expect(err.message).to.equal('Page size must be greater than 0');
            }
        });

        it('should switch database when provided', async () => {
            getArrayItemStub.resolves([]);
            const allData = [{ id: 1 }, { id: 2 }];
            const pageData = [{ id: 1 }];

            mockPaginationQueries(allData.length, pageData);
            addArrayItemStub.resolves();

            await dbConnector.getCacheQueryPagination(
                'SELECT * FROM orders',
                [],
                'orders-page-0',
                0,
                10,
                'sales_db'
            );

            expect(mockConnection.query.firstCall.args[0]).to.equal('USE `sales_db`');
        });

        it('should calculate pageCount correctly', async () => {
            getArrayItemStub.resolves([]);
            mockPaginationQueries(25, Array(10).fill({ id: 1 }));
            addArrayItemStub.resolves();

            const result = await dbConnector.getCacheQueryPagination(
                'SELECT * FROM users',
                [],
                'cache',
                0,
                10
            );

            expect(result.pageCount).to.equal(3); // ceil(25/10) = 3
        });

        it('should work when Redis is disabled for pagination', async () => {
            process.env.REDIS_ENABLED = 'false';

            dbConnector = proxyquire('../dbConnector', {
                'mysql2/promise': { createPool: sinon.stub().returns(mockPool) },
                './redis.Connector': mockRedis
            });

            const allData = Array(25).fill({ id: 1 });
            const pageData = Array(10).fill({ id: 1 });
            mockPaginationQueries(allData.length, pageData);

            const result = await dbConnector.getCacheQueryPagination(
                'SELECT * FROM users',
                [],
                'cache',
                0,
                10
            );

            expect(result.totalCount).to.equal(25);
            expect(result.pageCount).to.equal(3);
            expect(getArrayItemStub.called).to.be.false;
            expect(addArrayItemStub.called).to.be.false;
        });

        it('should handle SQL with trailing semicolon', async () => {
            getArrayItemStub.resolves([]);
            const allData = Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }));
            const pageData = allData.slice(0, 10);

            mockPaginationQueries(allData.length, pageData);
            addArrayItemStub.resolves();

            const result = await dbConnector.getCacheQueryPagination(
                'SELECT * FROM users WHERE status = "active";',  // SQL with semicolon
                [],
                'users-page-0',
                0,
                10
            );

            expect(result.totalCount).to.equal(30);
            expect(result.pageCount).to.equal(3);
            expect(result.detail).to.deep.equal(pageData);

            // Verify that the paginated SQL doesn't have syntax errors
            const pageSql = pageQuery().args[0];
            expect(pageSql).to.not.include(';;'); // Should not have double semicolons
            expect(pageSql).to.include('LIMIT');
        });

        it('should handle SQL with multiple trailing semicolons', async () => {
            getArrayItemStub.resolves([]);
            const allData = Array.from({ length: 15 }, (_, i) => ({ id: i + 1 }));
            const pageData = allData.slice(10, 15);

            mockPaginationQueries(allData.length, pageData);
            addArrayItemStub.resolves();

            const result = await dbConnector.getCacheQueryPagination(
                'SELECT * FROM orders;;;',  // Multiple semicolons
                [],
                'orders-page-1',
                1,
                10
            );

            expect(result.totalCount).to.equal(15);
            expect(result.pageCount).to.equal(2);

            // Verify clean SQL - with parameterized LIMIT, SQL ends with LIMIT ?, ?
            const pageSql = pageQuery().args[0];
            expect(pageSql).to.include('LIMIT ?, ?');
            expect(pageSql).to.not.match(/;/); // Should not have semicolons
        });

        it('should handle SQL with trailing semicolon and whitespace', async () => {
            getArrayItemStub.resolves([]);
            const allData = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }));
            const pageData = allData.slice(0, 5);

            mockPaginationQueries(allData.length, pageData);
            addArrayItemStub.resolves();

            const result = await dbConnector.getCacheQueryPagination(
                'SELECT * FROM products;  \n  ',  // Semicolon with trailing whitespace
                [],
                'products-page-0',
                0,
                5
            );

            expect(result.totalCount).to.equal(20);
            expect(result.pageCount).to.equal(4);
            expect(result.detail.length).to.equal(5);

            // Verify clean SQL - with parameterized LIMIT
            const pageSql = pageQuery().args[0];
            expect(pageSql).to.include('LIMIT ?, ?');
            expect(pageSql).to.not.match(/;\s*$/); // Should not end with semicolon
        });

        it('should handle complex SQL with ORDER BY and semicolon', async () => {
            getArrayItemStub.resolves([]);
            const allData = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `User${i}` }));
            const pageData = allData.slice(20, 30);

            mockPaginationQueries(allData.length, pageData);
            addArrayItemStub.resolves();

            const result = await dbConnector.getCacheQueryPagination(
                'SELECT * FROM users WHERE status = "active" ORDER BY created_at DESC;',
                [],
                'users-sorted-page-2',
                2,
                10
            );

            expect(result.totalCount).to.equal(50);
            expect(result.pageCount).to.equal(5);

            // Verify SQL structure: ORDER BY comes before LIMIT
            const pageSql = pageQuery().args[0];
            expect(pageSql).to.match(/ORDER BY.*LIMIT/); // ORDER BY before LIMIT
            expect(pageSql).to.include('LIMIT ?, ?');
        });

        it('should handle undefined page parameter (default to 0)', async () => {
            getArrayItemStub.resolves([]);
            const allData = Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }));
            const pageData = allData.slice(0, 10);

            mockPaginationQueries(allData.length, pageData);
            addArrayItemStub.resolves();

            const result = await dbConnector.getCacheQueryPagination(
                'SELECT * FROM users',
                [],
                'users-page',
                undefined,
                10
            );

            expect(result.totalCount).to.equal(30);
            // With parameterized LIMIT, verify parameters instead
            const pageParams = pageQuery().args[1];
            expect(pageParams).to.include(0); // offset
            expect(pageParams).to.include(10); // pageSize
        });

        it('should handle null page parameter (default to 0)', async () => {
            getArrayItemStub.resolves([]);
            const allData = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
            const pageData = allData.slice(0, 5);

            mockPaginationQueries(allData.length, pageData);
            addArrayItemStub.resolves();

            const result = await dbConnector.getCacheQueryPagination(
                'SELECT * FROM products',
                [],
                'products-page',
                null,
                5
            );

            expect(result.totalCount).to.equal(25);
            const pageParams = pageQuery().args[1];
            expect(pageParams).to.include(0); // offset
            expect(pageParams).to.include(5); // pageSize
        });

        it('should handle NaN page parameter (default to 0)', async () => {
            getArrayItemStub.resolves([]);
            const allData = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }));
            const pageData = allData.slice(0, 10);

            mockPaginationQueries(allData.length, pageData);
            addArrayItemStub.resolves();

            const result = await dbConnector.getCacheQueryPagination(
                'SELECT * FROM orders',
                [],
                'orders-page',
                NaN,
                10
            );

            expect(result.totalCount).to.equal(20);
            const pageParams = pageQuery().args[1];
            expect(pageParams).to.include(0); // offset
            expect(pageParams).to.include(10); // pageSize
        });

        it('should handle invalid string page parameter (default to 0)', async () => {
            getArrayItemStub.resolves([]);
            const allData = Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }));
            const pageData = allData.slice(0, 10);

            mockPaginationQueries(allData.length, pageData);
            addArrayItemStub.resolves();

            const result = await dbConnector.getCacheQueryPagination(
                'SELECT * FROM users',
                [],
                'users-page',
                'invalid',
                10
            );

            expect(result.totalCount).to.equal(30);
            const pageParams = pageQuery().args[1];
            expect(pageParams).to.include(0); // offset
            expect(pageParams).to.include(10); // pageSize
        });

        it('should handle negative page parameter (default to 0)', async () => {
            getArrayItemStub.resolves([]);
            const allData = Array.from({ length: 40 }, (_, i) => ({ id: i + 1 }));
            const pageData = allData.slice(0, 10);

            mockPaginationQueries(allData.length, pageData);
            addArrayItemStub.resolves();

            const result = await dbConnector.getCacheQueryPagination(
                'SELECT * FROM products',
                [],
                'products-page',
                -5,
                10
            );

            expect(result.totalCount).to.equal(40);
            const pageParams = pageQuery().args[1];
            expect(pageParams).to.include(0); // offset
            expect(pageParams).to.include(10); // pageSize
        });

        it('should handle valid string page parameter', async () => {
            getArrayItemStub.resolves([]);
            const allData = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
            const pageData = allData.slice(20, 30);

            mockPaginationQueries(allData.length, pageData);
            addArrayItemStub.resolves();

            const result = await dbConnector.getCacheQueryPagination(
                'SELECT * FROM orders',
                [],
                'orders-page-2',
                '2',
                10
            );

            expect(result.totalCount).to.equal(50);
            const pageParams = pageQuery().args[1];
            expect(pageParams).to.include(20); // offset
            expect(pageParams).to.include(10); // pageSize
        });
    });

    describe('Retry Mechanism', () => {
        it('should succeed on first attempt without retry', async () => {
            mockConnection.query.resolves([[{ id: 1, name: 'Success' }]]);

            const result = await dbConnector.QuaryCache('SELECT * FROM users', []);

            expect(result).to.deep.equal([{ id: 1, name: 'Success' }]);
            expect(mockPool.getConnection.calledOnce).to.be.true;
        });

        it('should retry on connection errors', async () => {
            let callCount = 0;
            mockPool.getConnection = sinon.stub().callsFake(async () => {
                callCount++;
                if (callCount === 1) {
                    throw { code: 'ECONNREFUSED', message: 'Connection refused' };
                }
                return mockConnection;
            });
            mockConnection.query.resolves([[{ id: 1 }]]);

            const result = await dbConnector.QuaryCache('SELECT * FROM users', []);

            expect(result).to.deep.equal([{ id: 1 }]);
            expect(callCount).to.equal(2);
        });

        it('should not retry on non-connection errors', async () => {
            mockConnection.query.rejects({ code: 'ER_SYNTAX_ERROR', message: 'Syntax error' });

            try {
                await dbConnector.QuaryCache('SELECT * FROM users', []);
                expect.fail('Should have thrown error');
            } catch (err) {
                expect(err.message).to.equal('Syntax error');
                expect(mockConnection.query.calledOnce).to.be.true;
            }
        });

        it('should fail after max retries', async () => {
            let callCount = 0;
            mockPool.getConnection = sinon.stub().callsFake(async () => {
                callCount++;
                throw { code: 'ETIMEDOUT', message: 'Timeout' };
            });

            try {
                await dbConnector.QuaryCache('SELECT * FROM users', []);
                expect.fail('Should have thrown error');
            } catch (err) {
                expect(err.message).to.equal('Timeout');
                expect(callCount).to.equal(3); // 3 retries
            }
        });

        it('should retry on ENOTFOUND error', async () => {
            let callCount = 0;
            mockPool.getConnection = sinon.stub().callsFake(async () => {
                callCount++;
                if (callCount === 1) {
                    throw { code: 'ENOTFOUND', message: 'Host not found' };
                }
                return mockConnection;
            });
            mockConnection.query.resolves([[{ id: 1 }]]);

            const result = await dbConnector.QuaryCache('SELECT * FROM users', []);

            expect(result).to.deep.equal([{ id: 1 }]);
            expect(callCount).to.equal(2);
        });

        it('should retry on ER_CON_COUNT_ERROR', async () => {
            let callCount = 0;
            mockPool.getConnection = sinon.stub().callsFake(async () => {
                callCount++;
                if (callCount === 1) {
                    throw { code: 'ER_CON_COUNT_ERROR', message: 'Too many connections' };
                }
                return mockConnection;
            });
            mockConnection.query.resolves([[{ id: 1 }]]);

            const result = await dbConnector.QuaryCache('SELECT * FROM users', []);

            expect(result).to.deep.equal([{ id: 1 }]);
            expect(callCount).to.equal(2);
        });
    });
});
