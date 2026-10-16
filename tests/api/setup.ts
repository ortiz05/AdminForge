// Setup file of the vitest `api` project (vitest.config.ts): forces NODE_ENV=test before any API module loads, so
// configuration takes its test defaults (e.g. delivery reads no env file). API tests use Fastify inject and, when
// DATABASE_URL points at the dev Postgres, a separate test database (db.ts).
process.env.NODE_ENV = 'test';
