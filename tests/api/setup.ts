// API tests use Fastify inject and, when DATABASE_URL points at the dev Postgres, a real database.
process.env.NODE_ENV = 'test';
