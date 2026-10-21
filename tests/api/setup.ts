// Setup file of the vitest `api` project (vitest.config.ts): forces NODE_ENV=test before any API module loads, so
// configuration takes its test defaults (e.g. delivery reads no env file). API tests use Fastify inject and, for the
// database-backed suites, a migrated SQLite file of their own (db.ts).
process.env.NODE_ENV = 'test';
