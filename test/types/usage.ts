// Type-level usage of every export of index.d.ts, including the snippets from README.md and
// docs/*.md. It is compiled, never run:
//   npx -p typescript@5 tsc -p test/types                            (esModuleInterop off)
//   npx -p typescript@5 tsc -p test/types/tsconfig.interop.json      (esModuleInterop on)
import sqlcache from 'sqlcache';
import * as sqlcacheNamespace from 'sqlcache';
import sqlcacheRequire = require('sqlcache');
import {
    QuaryCache,
    getCacheQuery,
    getCacheQueryPagination,
    bulkInsert,
    getCacheQueryWithTimeout,
    closeConnections,
    getPoolStats,
    withTransaction,
    getArrayItem,
    addArrayItem,
    delKeyItem,
    delPrefixKeyItem,
    isRedisConnected,
    getRedisClient,
    enableAutoKey,
    enableAutoInvalidation,
    configure,
    type QueryResult,
    type PaginationResult,
    type RedisClient,
    type BulkInsertOptions,
    type BulkInsertResult,
    type QueryTimeoutOptions,
    type PoolStats,
    type AutoKeyConfig,
    type AutoInvalidationConfig,
    type CoreConfig,
    type ConfigureOptions,
    type TransactionContext,
    type TransactionOptions
} from 'sqlcache';

/** Consumes values, so that the checks below do not depend on unused-variable settings. */
declare function use(...values: unknown[]): void;

interface User {
    id: number;
    name: string;
    email: string;
}

interface Product {
    id: number;
    name: string;
    price: number;
}

export async function reads(): Promise<void> {
    // README: Quick start, Reading, Several databases
    const [user] = await getCacheQuery<User>('SELECT * FROM users WHERE id = ?', [42], 'user:42');
    const tenantUsers: User[] = await getCacheQuery<User>('SELECT * FROM users', [], 'tenant7:users', 'tenant_7');
    // Automatic key, and no parameters at all (docs/USE-CASE-ECOMMERCE.md)
    const active = await getCacheQuery<User>('SELECT * FROM users WHERE status = ?', ['active']);
    const listing = await getCacheQuery('SELECT * FROM products WHERE active = 1 ORDER BY created_at DESC');
    const explicitNulls = await getCacheQuery('SELECT * FROM users', [], null, null);
    use(user.email, tenantUsers, active, listing, explicitNulls);

    // Pagination: 0-based page, { totalCount, pageCount, detail } (docs/API.md)
    const page: PaginationResult<Product> = await getCacheQueryPagination<Product>(
        'SELECT * FROM products WHERE category = ?',
        [5],
        'products:cat:5',
        0,
        25
    );
    const counts: number = page.totalCount + page.pageCount;
    const names: string[] = page.detail.map((product) => product.name);
    const defaultPageSize = await getCacheQueryPagination('SELECT * FROM orders', [], 'orders:all', 1);
    const otherDatabase = await getCacheQueryPagination('SELECT * FROM orders', [], 'orders:all', 0, undefined, 'tenant_7');
    const withoutName = await getCacheQueryPagination('SELECT * FROM orders', [], null, 0, 20);
    // @ts-expect-error the result has no `data` field (it is `detail`)
    use(page.data);
    // @ts-expect-error parameters stay required for pagination
    await getCacheQueryPagination('SELECT * FROM orders');
    use(counts, names, defaultPageSize, otherDatabase, withoutName);

    // Query timeouts (README, docs/API.md)
    const timeoutOptions: QueryTimeoutOptions = { timeout: 5000, database: 'analytics_db', cancelOnTimeout: true };
    const report = await getCacheQueryWithTimeout<User>(
        'SELECT * FROM users WHERE status = ?',
        ['active'],
        'active_users',
        timeoutOptions
    );
    const withoutCacheName = await getCacheQueryWithTimeout('SELECT 1');
    use(report[0].email, withoutCacheName);
}

export async function writes(): Promise<void> {
    // README: Writing and invalidation; resetCacheName is a prefix or an array of prefixes
    const update: QueryResult = await QuaryCache('UPDATE users SET name = ? WHERE id = ?', ['Ada', 42], 'user:');
    await QuaryCache('DELETE FROM users WHERE id = ?', [123], ['users_*', 'profiles_*', 'sessions_*']);
    await QuaryCache('INSERT INTO logs (message) VALUES (?)', ['User logged in'], 'logs_*', 'logging_db');
    const inserted = await QuaryCache('INSERT INTO users (name, email) VALUES (?, ?)', ['John', 'john@example.com']);
    const insertId: number | undefined = inserted.insertId;
    use(update.affectedRows, inserted.info, inserted.warningStatus, inserted.changedRows, insertId);

    // An uncached read through QuaryCache takes the row type (README: TypeScript)
    const rows = await QuaryCache<User[]>('SELECT id, name, email FROM users WHERE id = ?', [1]);
    use(rows.length, rows[0].email);

    // A statement without parameters
    await QuaryCache('DELETE FROM sessions WHERE expires_at < NOW()');
}

export async function bulk(): Promise<void> {
    const options: BulkInsertOptions = {
        chunkSize: 1000,
        resetCacheName: ['events:', 'stats:'],
        transaction: true,
        database: null
    };
    const result: BulkInsertResult = await bulkInsert('events', [{ event_type: 'click', user_id: 1 }], options);
    const single = await bulkInsert('users', [{ name: 'Alice', email: 'alice@example.com' }], { resetCacheName: 'users_' });
    const empty = await bulkInsert('users', []);
    use(result.insertedRows + result.chunks, single.insertedRows, empty.chunks);
}

export async function transactions(): Promise<void> {
    const options: TransactionOptions = { database: 'tenant_7' };

    // README: Transactions
    const orderId = await withTransaction(async (tx) => {
        const { insertId } = await tx.query('INSERT INTO orders (customer_id) VALUES (?)', [7], 'orders:');
        await tx.query('UPDATE stock SET qty = qty - 1 WHERE product_id = ?', [3], ['stock:', 'products:']);
        return insertId;
    });

    // Explicit context and result types (docs/README.tr.md), reads in the transaction (docs/EXAMPLES.md)
    const userId: number = await withTransaction(async (tx: TransactionContext) => {
        const result = await tx.query<{ insertId: number }>('INSERT INTO users (name) VALUES (?)', ['John']);
        const [cached] = await tx.getCacheQuery<User>('SELECT * FROM users WHERE id = ?', [123], 'user-123');
        const [locked] = await tx.query<Product[]>('SELECT id, name, price FROM products WHERE id = ? FOR UPDATE', [1]);
        await tx.query('UPDATE counters SET value = value + 1'); // no parameters (docs/MIGRATION.md)
        const connection = tx.getConnection();
        use(cached.email, locked.price, connection);
        return result.insertId;
    }, options);

    // The callback may return a plain value
    const done: string = await withTransaction(() => 'done');
    use(orderId, userId, done);
}

export async function redisHelpers(): Promise<void> {
    // README: Redis helpers
    await addArrayItem('settings', [{ theme: 'dark' }], 3600);
    const settings = await getArrayItem<{ theme: string }>('settings');
    await delKeyItem(['settings', 'flags']);
    await delKeyItem('settings');
    await delPrefixKeyItem('user:');
    await delPrefixKeyItem(['users_', 'profiles_', 'sessions_']);
    const healthy: boolean = isRedisConnected();
    const client: RedisClient = getRedisClient();
    use(settings[0].theme, healthy, client);
}

export function configuration(): void {
    const autoKey: AutoKeyConfig = { enabled: true };
    const autoInvalidation: AutoInvalidationConfig = {
        enabled: true,
        tables: { users: ['users:*', 'users_*', 'profiles:*'], orders: 'orders:*' }
    };
    enableAutoKey(autoKey);
    enableAutoKey(false);
    enableAutoKey();
    enableAutoInvalidation(autoInvalidation);
    enableAutoInvalidation(false);
    enableAutoInvalidation({ enabled: false });

    const core: CoreConfig = { autoKey, autoInvalidation };
    configure(core);
    const options: ConfigureOptions = { autoKey: false, autoInvalidation: true };
    configure(options);
    configure({ autoKey: { enabled: true }, autoInvalidation: false });
    configure();
}

export async function operations(): Promise<void> {
    // README: Health checks and shutdown
    const stats: PoolStats = getPoolStats();
    const exhausted: boolean = stats.queuedRequests > 0;
    await closeConnections();
    getRedisClient().quit();
    use(stats.totalConnections, stats.activeConnections, stats.freeConnections, exhausted);
}

export async function importStyles(): Promise<void> {
    // Default import: matches the runtime without esModuleInterop since 2.9.1
    const viaDefault = await sqlcache.getCacheQuery<User>('SELECT * FROM users', [], 'users:all');
    const viaNamespace = await sqlcacheNamespace.getCacheQueryPagination<User>('SELECT * FROM users', [], 'users:list', 0);
    const viaRequire: PoolStats = sqlcacheRequire.getPoolStats();
    use(viaDefault, viaNamespace.detail, viaRequire);
}

// Code written against the 2.9.0 definitions keeps compiling.
export async function compatibility(): Promise<void> {
    const result: QueryResult = await QuaryCache('UPDATE users SET name = ? WHERE id = ?', ['Ada', 42], 'user:', null);
    const pending: Promise<QueryResult> = QuaryCache('DELETE FROM users WHERE id = ?', [1]);
    const id: number = await withTransaction(async (tx: TransactionContext) => {
        const inserted = await tx.query<{ insertId: number }>('INSERT INTO users (name) VALUES (?)', ['x']);
        return inserted.insertId;
    });
    const explicit: Promise<string> = withTransaction<string>(async () => 'ok');
    const callback: (tx: TransactionContext) => Promise<number> = async () => 1;
    const fromCallback: number = await withTransaction(callback);

    const core: CoreConfig = { autoKey: { enabled: true } };
    const autoKeyOn: boolean | undefined = core.autoKey?.enabled;
    const configureRef: (config?: CoreConfig) => void = configure;
    const enableRef: (config?: AutoKeyConfig) => void = enableAutoKey;
    const quaryRef: (sql: string, parameters: any[]) => Promise<QueryResult> = QuaryCache;
    const pageRef: (sql: string, parameters: any[], cacheName: string, page: number) => Promise<PaginationResult> =
        getCacheQueryPagination;
    const timeoutRef: (sql: string, parameters: any[], cacheName: string) => Promise<any[]> = getCacheQueryWithTimeout;

    const mockTx: TransactionContext = {
        query: async (sql: string, parameters: any[]): Promise<any> => ({ sql, parameters }),
        getCacheQuery: async (sql: string, parameters: any[], cacheName?: string | null) => [],
        getConnection: () => null
    };
    const options: BulkInsertOptions = { resetCacheName: 'users_' };
    const resetName: string | string[] | null | undefined = options.resetCacheName;

    use(result, pending, id, explicit, fromCallback, autoKeyOn, configureRef, enableRef, quaryRef, pageRef,
        timeoutRef, mockTx, resetName);
}
