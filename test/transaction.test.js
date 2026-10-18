/**
 * Transaction Tests (v2.7.0)
 *
 * Tests for withTransaction wrapper function
 */

const chai = require('chai');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');
const proxyquire = require('proxyquire');

chai.use(sinonChai);
const { expect } = chai;

describe('Transactions (v2.7.0)', () => {
    let dbConnector;
    let mockConnection;
    let mockPool;
    let getArrayItemStub;
    let addArrayItemStub;
    let delPrefixKeyItemStub;
    let determineInvalidationPatternsStub;
    let isAutoKeyEnabledStub;
    let generateCacheKeyStub;
    let originalEnv;

    before(() => {
        // Save and set environment variables
        originalEnv = { ...process.env };
        process.env.DB_HOST = 'localhost';
        process.env.DB_USERNAME = 'test';
        process.env.DB_NAME = 'testdb';
        process.env.REDIS_SERVER = 'localhost';
        process.env.REDIS_PORT = '6379';
    });

    after(() => {
        // Restore environment
        process.env = originalEnv;
    });

    beforeEach(() => {
        // Mock connection object
        mockConnection = {
            query: sinon.stub(),
            beginTransaction: sinon.stub().resolves(),
            commit: sinon.stub().resolves(),
            rollback: sinon.stub().resolves(),
            release: sinon.stub()
        };

        // Mock pool
        mockPool = {
            getConnection: sinon.stub().resolves(mockConnection),
            end: sinon.stub().resolves(),
            pool: {
                _allConnections: [1, 2, 3],
                _freeConnections: [1],
                _connectionQueue: []
            }
        };

        // Redis stubs
        getArrayItemStub = sinon.stub().resolves([]);
        addArrayItemStub = sinon.stub().resolves();
        delPrefixKeyItemStub = sinon.stub().resolves();

        // Auto invalidation stub
        determineInvalidationPatternsStub = sinon.stub().returns([]);

        // Auto key stubs
        isAutoKeyEnabledStub = sinon.stub().returns(false);
        generateCacheKeyStub = sinon.stub().returns('auto-generated-key');

        // Load dbConnector with mocks
        dbConnector = proxyquire('../dbConnector', {
            'mysql2/promise': {
                createPool: () => mockPool
            },
            './redis.Connector': {
                getArrayItem: getArrayItemStub,
                addArrayItem: addArrayItemStub,
                delPrefixKeyItem: delPrefixKeyItemStub
            },
            './core/autoInvalidate': {
                determineInvalidationPatterns: determineInvalidationPatternsStub
            },
            './core/autoKey': {
                isAutoKeyEnabled: isAutoKeyEnabledStub,
                generateCacheKey: generateCacheKeyStub
            }
        });
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('Basic Transaction Flow', () => {
        it('should execute queries in transaction and commit', async () => {
            mockConnection.query
                .onFirstCall().resolves([{ insertId: 1 }, null])
                .onSecondCall().resolves([{ affectedRows: 1 }, null]);

            const result = await dbConnector.withTransaction(async (tx) => {
                await tx.query('INSERT INTO users (name) VALUES (?)', ['John']);
                await tx.query('UPDATE orders SET user_id = ? WHERE id = ?', [1, 100]);
                return { success: true };
            });

            expect(result).to.deep.equal({ success: true });
            expect(mockConnection.beginTransaction).to.have.been.calledOnce;
            expect(mockConnection.commit).to.have.been.calledOnce;
            expect(mockConnection.rollback).to.not.have.been.called;
            expect(mockConnection.release).to.have.been.calledOnce;
        });

        it('should rollback transaction on error', async () => {
            mockConnection.query.rejects(new Error('Database error'));

            try {
                await dbConnector.withTransaction(async (tx) => {
                    await tx.query('INSERT INTO users (name) VALUES (?)', ['John']);
                    await tx.query('INVALID SQL');
                });
                expect.fail('Should have thrown error');
            } catch (error) {
                expect(error.message).to.equal('Database error');
                expect(mockConnection.beginTransaction).to.have.been.calledOnce;
                expect(mockConnection.commit).to.not.have.been.called;
                expect(mockConnection.rollback).to.have.been.calledOnce;
                expect(mockConnection.release).to.have.been.calledOnce;
            }
        });

        it('should release connection even if rollback fails', async () => {
            mockConnection.query.rejects(new Error('Query error'));
            mockConnection.rollback.rejects(new Error('Rollback error'));

            const consoleErrorStub = sinon.stub(console, 'error');

            try {
                await dbConnector.withTransaction(async (tx) => {
                    await tx.query('INVALID SQL');
                });
                expect.fail('Should have thrown error');
            } catch (error) {
                expect(error.message).to.equal('Query error');
                expect(mockConnection.release).to.have.been.calledOnce;
                expect(consoleErrorStub).to.have.been.calledWith('Rollback error:', sinon.match.instanceOf(Error));
            }

            consoleErrorStub.restore();
        });
    });

    describe('Cache Invalidation in Transactions', () => {
        it('should buffer cache invalidations and apply on commit', async () => {
            determineInvalidationPatternsStub
                .onFirstCall().returns(['users_*'])
                .onSecondCall().returns(['orders_*']);

            mockConnection.query
                .onFirstCall().resolves([{ insertId: 1 }, null])
                .onSecondCall().resolves([{ affectedRows: 1 }, null]);

            await dbConnector.withTransaction(async (tx) => {
                await tx.query('INSERT INTO users (name) VALUES (?)', ['John']);
                await tx.query('UPDATE orders SET status = ?', ['shipped']);
            });

            expect(delPrefixKeyItemStub).to.have.been.calledTwice;
            expect(delPrefixKeyItemStub.firstCall.args[0]).to.equal('users_*');
            expect(delPrefixKeyItemStub.secondCall.args[0]).to.equal('orders_*');
        });

        it('should not invalidate cache if transaction is rolled back', async () => {
            determineInvalidationPatternsStub.returns(['users_*']);
            mockConnection.query
                .onFirstCall().resolves([{ insertId: 1 }, null])
                .onSecondCall().rejects(new Error('Query failed'));

            try {
                await dbConnector.withTransaction(async (tx) => {
                    await tx.query('INSERT INTO users (name) VALUES (?)', ['John']);
                    await tx.query('INVALID SQL');
                });
                expect.fail('Should have thrown error');
            } catch (error) {
                expect(delPrefixKeyItemStub).to.not.have.been.called;
            }
        });

        it('should deduplicate cache invalidation patterns', async () => {
            determineInvalidationPatternsStub.returns(['users_*']);

            mockConnection.query.resolves([{ affectedRows: 1 }, null]);

            await dbConnector.withTransaction(async (tx) => {
                await tx.query('INSERT INTO users...', []);
                await tx.query('UPDATE users...', []);
                await tx.query('DELETE FROM users...', []);
            });

            // Should only call once with deduplicated pattern
            expect(delPrefixKeyItemStub).to.have.been.calledOnce;
            expect(delPrefixKeyItemStub.firstCall.args[0]).to.equal('users_*');
        });

        it('should support manual cache invalidation patterns', async () => {
            determineInvalidationPatternsStub
                .withArgs(sinon.match.any, 'custom-pattern-*')
                .returns(['custom-pattern-*']);

            mockConnection.query.resolves([{ insertId: 1 }, null]);

            await dbConnector.withTransaction(async (tx) => {
                await tx.query('INSERT INTO users...', [], 'custom-pattern-*');
            });

            expect(delPrefixKeyItemStub).to.have.been.calledWith('custom-pattern-*');
        });
    });

    describe('Transaction getCacheQuery', () => {
        it('should read from cache if available', async () => {
            getArrayItemStub.resolves([{ id: 1, name: 'John' }]);

            await dbConnector.withTransaction(async (tx) => {
                const result = await tx.getCacheQuery('SELECT * FROM users WHERE id = ?', [1], 'user-1');
                expect(result).to.deep.equal([{ id: 1, name: 'John' }]);
            });

            expect(getArrayItemStub).to.have.been.calledWith('user-1');
            expect(mockConnection.query).to.not.have.been.called;
        });

        it('should execute query and cache result on cache miss', async () => {
            getArrayItemStub.resolves([]);
            mockConnection.query.resolves([[{ id: 1, name: 'John' }], null]);

            await dbConnector.withTransaction(async (tx) => {
                const result = await tx.getCacheQuery('SELECT * FROM users WHERE id = ?', [1], 'user-1');
                expect(result).to.deep.equal([{ id: 1, name: 'John' }]);
            });

            expect(getArrayItemStub).to.have.been.calledWith('user-1');
            expect(mockConnection.query).to.have.been.calledOnce;
            expect(addArrayItemStub).to.have.been.calledWith('user-1', [{ id: 1, name: 'John' }]);
        });

        it('should support auto key generation', async () => {
            // Enable auto key stub
            isAutoKeyEnabledStub.returns(true);

            getArrayItemStub.resolves([]);
            mockConnection.query.resolves([[{ id: 1 }], null]);

            await dbConnector.withTransaction(async (tx) => {
                await tx.getCacheQuery('SELECT * FROM users WHERE id = ?', [1]);
            });

            // Auto key should be generated
            expect(isAutoKeyEnabledStub).to.have.been.called;
            expect(generateCacheKeyStub).to.have.been.calledOnce;
            expect(getArrayItemStub).to.have.been.calledWith('auto-generated-key');
            expect(addArrayItemStub).to.have.been.calledWith('auto-generated-key', [{ id: 1 }]);
        });

        it('should throw error if cacheName missing and auto key disabled', async () => {
            delete process.env.CORE_AUTO_FEATURES;

            try {
                await dbConnector.withTransaction(async (tx) => {
                    await tx.getCacheQuery('SELECT * FROM users WHERE id = ?', [1]);
                });
                expect.fail('Should have thrown error');
            } catch (error) {
                expect(error.message).to.include('cacheName is required in transaction');
            }
        });
    });

    describe('Database Switching', () => {
        it('should switch database when specified in options', async () => {
            mockConnection.query.resolves([{ insertId: 1 }, null]);

            await dbConnector.withTransaction(async (tx) => {
                await tx.query('INSERT INTO users...', []);
            }, { database: 'other_db' });

            expect(mockConnection.query.firstCall.args[0]).to.include('USE `other_db`');
        });

        it('should not switch database if not specified', async () => {
            mockConnection.query.resolves([{ insertId: 1 }, null]);

            await dbConnector.withTransaction(async (tx) => {
                await tx.query('INSERT INTO users...', []);
            });

            expect(mockConnection.query.firstCall.args[0]).to.not.include('USE');
        });
    });

    describe('Transaction Context Methods', () => {
        it('should provide getConnection() method', async () => {
            let capturedConnection;

            await dbConnector.withTransaction(async (tx) => {
                capturedConnection = tx.getConnection();
            });

            expect(capturedConnection).to.equal(mockConnection);
        });

        it('should have query method', async () => {
            await dbConnector.withTransaction(async (tx) => {
                expect(tx.query).to.be.a('function');
            });
        });

        it('should have getCacheQuery method', async () => {
            await dbConnector.withTransaction(async (tx) => {
                expect(tx.getCacheQuery).to.be.a('function');
            });
        });
    });

    describe('Real-world Scenarios', () => {
        it('should handle user registration with order creation', async () => {
            mockConnection.query
                .onFirstCall().resolves([{ insertId: 123 }, null])
                .onSecondCall().resolves([{ insertId: 456 }, null])
                .onThirdCall().resolves([{ affectedRows: 1 }, null]);

            determineInvalidationPatternsStub
                .onFirstCall().returns(['users_*'])
                .onSecondCall().returns(['orders_*'])
                .onThirdCall().returns(['analytics_*']);

            const result = await dbConnector.withTransaction(async (tx) => {
                const userResult = await tx.query('INSERT INTO users (name) VALUES (?)', ['John']);
                const orderResult = await tx.query('INSERT INTO orders (user_id) VALUES (?)', [userResult.insertId]);
                await tx.query('UPDATE analytics SET total_users = total_users + 1');

                return { userId: userResult.insertId, orderId: orderResult.insertId };
            });

            expect(result.userId).to.equal(123);
            expect(result.orderId).to.equal(456);
            expect(mockConnection.commit).to.have.been.calledOnce;
            expect(delPrefixKeyItemStub).to.have.been.calledThrice;
        });

        it('should handle complex multi-table update', async () => {
            mockConnection.query.resolves([{ affectedRows: 1 }, null]);
            determineInvalidationPatternsStub.returns(['products_*']);

            await dbConnector.withTransaction(async (tx) => {
                await tx.query('UPDATE products SET stock = stock - 1 WHERE id = ?', [100]);
                await tx.query('UPDATE products SET stock = stock - 1 WHERE id = ?', [200]);
                await tx.query('UPDATE products SET stock = stock - 1 WHERE id = ?', [300]);
            });

            expect(mockConnection.commit).to.have.been.calledOnce;
            // Should deduplicate to single pattern
            expect(delPrefixKeyItemStub).to.have.been.calledOnce;
        });

        it('should rollback on constraint violation', async () => {
            mockConnection.query
                .onFirstCall().resolves([{ insertId: 1 }, null])
                .onSecondCall().rejects(new Error('ER_DUP_ENTRY: Duplicate entry'));

            try {
                await dbConnector.withTransaction(async (tx) => {
                    await tx.query('INSERT INTO users (email) VALUES (?)', ['test@example.com']);
                    await tx.query('INSERT INTO users (email) VALUES (?)', ['test@example.com']); // Duplicate!
                });
                expect.fail('Should have thrown error');
            } catch (error) {
                expect(error.message).to.include('Duplicate entry');
                expect(mockConnection.rollback).to.have.been.calledOnce;
                expect(mockConnection.commit).to.not.have.been.called;
                expect(delPrefixKeyItemStub).to.not.have.been.called;
            }
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty transaction', async () => {
            const result = await dbConnector.withTransaction(async (tx) => {
                return 'empty';
            });

            expect(result).to.equal('empty');
            expect(mockConnection.commit).to.have.been.calledOnce;
        });

        it('should handle transaction returning null', async () => {
            const result = await dbConnector.withTransaction(async (tx) => {
                return null;
            });

            expect(result).to.be.null;
            expect(mockConnection.commit).to.have.been.calledOnce;
        });

        it('should handle transaction returning undefined', async () => {
            const result = await dbConnector.withTransaction(async (tx) => {
                // No return
            });

            expect(result).to.be.undefined;
            expect(mockConnection.commit).to.have.been.calledOnce;
        });

        it('should propagate callback errors correctly', async () => {
            const customError = new Error('Custom business logic error');

            try {
                await dbConnector.withTransaction(async (tx) => {
                    throw customError;
                });
                expect.fail('Should have thrown error');
            } catch (error) {
                expect(error).to.equal(customError);
                expect(mockConnection.rollback).to.have.been.calledOnce;
            }
        });
    });
});
