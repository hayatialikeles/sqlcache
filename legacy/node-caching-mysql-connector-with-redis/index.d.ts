// node-caching-mysql-connector-with-redis has been renamed to sqlcache; these are its types.
/// <reference types="sqlcache" />

declare module 'node-caching-mysql-connector-with-redis' {
    export * from 'sqlcache';
    export { default } from 'sqlcache';
}
