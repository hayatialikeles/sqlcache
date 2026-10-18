# node-caching-mysql-connector-with-redis → sqlcache

This package has been renamed to [`sqlcache`](https://www.npmjs.com/package/sqlcache).

Version 2.9.0 of `node-caching-mysql-connector-with-redis` contains no code of its own: it depends on
`sqlcache@^2.9.0` and forwards to it, including the deep import paths (`/dbConnector`,
`/redis.Connector`, `/core/autoKey`, `/core/autoInvalidate`) and the TypeScript types. Existing projects
on `^2.x` keep working after `npm update`.

To switch to the new name:

```bash
npm uninstall node-caching-mysql-connector-with-redis
npm install sqlcache
```

Then replace `require('node-caching-mysql-connector-with-redis')` (and TypeScript imports from it) with
`'sqlcache'`. The API is the same. This name is deprecated and will not receive new major versions.

Documentation: https://github.com/hayatialikeles/sqlcache#readme
