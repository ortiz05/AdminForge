-- Row access for the services' role ({{APP_ROLE}}); applied by create-app-role.sh (and tests/api/app-role-pg.test.ts).
-- Placeholders: {{APP_ROLE}}, {{OWNER}} (the role that runs migrations and owns the tables), {{DB}}, {{QUEUE_SCHEMA}}.
GRANT CONNECT ON DATABASE "{{DB}}" TO {{APP_ROLE}};
GRANT USAGE ON SCHEMA public TO {{APP_ROLE}};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {{APP_ROLE}};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO {{APP_ROLE}};
-- Tables created by future migrations (run as the owner) get the same row access.
ALTER DEFAULT PRIVILEGES FOR ROLE "{{OWNER}}" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {{APP_ROLE}};
ALTER DEFAULT PRIVILEGES FOR ROLE "{{OWNER}}" IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO {{APP_ROLE}};
-- The audit log is append-only for the services, independent of its triggers.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM {{APP_ROLE}};
REVOKE CREATE ON SCHEMA public FROM {{APP_ROLE}};
-- The run queue (pg-boss, schema {{QUEUE_SCHEMA}}) installs and manages its own tables — including one partition per
-- queue — so the services' role owns that schema and everything in it (nothing in public).
CREATE SCHEMA IF NOT EXISTS {{QUEUE_SCHEMA}} AUTHORIZATION {{APP_ROLE}};
ALTER SCHEMA {{QUEUE_SCHEMA}} OWNER TO {{APP_ROLE}};
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.oid::regclass AS obj, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = '{{QUEUE_SCHEMA}}' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') LOOP
    IF r.relkind = 'S' THEN
      EXECUTE format('ALTER SEQUENCE %s OWNER TO {{APP_ROLE}}', r.obj);
    ELSIF r.relkind IN ('v', 'm') THEN
      EXECUTE format('ALTER %s %s OWNER TO {{APP_ROLE}}', CASE r.relkind WHEN 'v' THEN 'VIEW' ELSE 'MATERIALIZED VIEW' END, r.obj);
    ELSE
      EXECUTE format('ALTER TABLE %s OWNER TO {{APP_ROLE}}', r.obj);
    END IF;
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS obj, p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = '{{QUEUE_SCHEMA}}' LOOP
    EXECUTE format('ALTER %s %s OWNER TO {{APP_ROLE}}', CASE r.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, r.obj);
  END LOOP;
  FOR r IN SELECT t.oid::regtype AS obj FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = '{{QUEUE_SCHEMA}}' AND t.typtype IN ('e', 'c', 'd') AND t.typrelid = 0 LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO {{APP_ROLE}}', r.obj);
  END LOOP;
END $$;
