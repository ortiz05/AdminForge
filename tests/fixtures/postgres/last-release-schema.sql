-- The schema of the last Postgres release (migrations 0000–0012), for the db import-postgres tests: pg_dump
-- --schema-only --no-owner --no-privileges of a migrated test database, without psql meta-commands and comments. Frozen:
-- the Postgres releases end here (ADR-016).

CREATE FUNCTION public.approvals_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  i integer;
  rebound text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR pg_catalog.jsonb_array_length(NEW.decisions) <> 0 OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'approvals: a new approval starts pending, with no decisions';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.step_id IS DISTINCT FROM OLD.step_id
     OR NEW.policy IS DISTINCT FROM OLD.policy
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'approvals: only the decision of an approval can change';
  END IF;
  IF pg_catalog.jsonb_array_length(NEW.decisions) < pg_catalog.jsonb_array_length(OLD.decisions) THEN
    RAISE EXCEPTION 'approvals: decisions are append-only';
  END IF;
  FOR i IN 0 .. pg_catalog.jsonb_array_length(OLD.decisions) - 1 LOOP
    IF ((NEW.decisions -> i) - 'sessionHash') IS DISTINCT FROM ((OLD.decisions -> i) - 'sessionHash') THEN
      RAISE EXCEPTION 'approvals: a recorded decision cannot change';
    END IF;
    rebound := (NEW.decisions -> i) ->> 'sessionHash';
    IF rebound IS DISTINCT FROM ((OLD.decisions -> i) ->> 'sessionHash')
       AND NOT EXISTS (
         SELECT 1 FROM public.sessions s
          WHERE s.id_hash = rebound AND s.user_oid = ((NEW.decisions -> i) ->> 'oid')) THEN
      RAISE EXCEPTION 'approvals: a decision can be rebound only to a session of the person who made it';
    END IF;
  END LOOP;
  IF OLD.status <> 'pending' AND (
       NEW.status IS DISTINCT FROM OLD.status
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR pg_catalog.jsonb_array_length(NEW.decisions) <> pg_catalog.jsonb_array_length(OLD.decisions)) THEN
    RAISE EXCEPTION 'approvals: a decided approval is final (%)', OLD.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.approvals_delete_with_subject() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
BEGIN
  IF OLD.subject_id ~ '^[0-9a-fA-F-]{36}$' AND (
       (OLD.subject_type = 'run' AND EXISTS (SELECT 1 FROM public.runs r WHERE r.id = OLD.subject_id::uuid))
       OR (OLD.subject_type = 'schedule' AND EXISTS (SELECT 1 FROM public.schedules s WHERE s.id = OLD.subject_id::uuid))) THEN
    RAISE EXCEPTION 'approvals: an approval is deleted only together with its % (retention)', OLD.subject_type;
  END IF;
  RETURN NULL;
END;
$_$;

CREATE FUNCTION public.audit_events_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% blocked)', TG_OP;
END;
$$;

CREATE TABLE public.approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    step_id text,
    policy jsonb NOT NULL,
    decisions jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    requested_by text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT approvals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'expired'::text, 'cancelled'::text])))
);

CREATE TABLE public.audit_events (
    seq bigint NOT NULL,
    ts timestamp with time zone NOT NULL,
    actor_oid text,
    actor_upn text,
    session_hash text,
    mode text,
    action text NOT NULL,
    target_type text,
    target_id text,
    details jsonb,
    result text NOT NULL,
    correlation_id text NOT NULL,
    ip text,
    prev_hash text NOT NULL,
    hash text NOT NULL
);

CREATE SEQUENCE public.audit_events_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.audit_events_seq_seq OWNED BY public.audit_events.seq;

CREATE TABLE public.definitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    key text NOT NULL,
    version text NOT NULL,
    status text NOT NULL,
    source text NOT NULL,
    body json NOT NULL,
    sha256 text NOT NULL,
    author_oid text,
    approver_oid text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    CONSTRAINT definitions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'in_review'::text, 'published'::text, 'retired'::text])))
);

CREATE TABLE public.news_feed_state (
    feed_key text NOT NULL,
    last_run_at timestamp with time zone,
    last_success_at timestamp with time zone,
    status text,
    error_code text,
    error_message text,
    etag text,
    last_modified text,
    items integer DEFAULT 0 NOT NULL,
    new_items integer DEFAULT 0 NOT NULL,
    updated_items integer DEFAULT 0 NOT NULL,
    duration_ms integer,
    definition_sha text,
    note text
);

CREATE TABLE public.news_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feed_key text NOT NULL,
    external_id text NOT NULL,
    title text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    url text NOT NULL,
    kind text NOT NULL,
    severity text NOT NULL,
    areas text[] DEFAULT '{}'::text[] NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    status text,
    audience text[] DEFAULT '{}'::text[] NOT NULL,
    published_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    activity_at timestamp with time zone NOT NULL,
    action_required_by timestamp with time zone,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    content_hash text NOT NULL,
    facts jsonb DEFAULT '[]'::jsonb NOT NULL
);

CREATE TABLE public.preauth (
    state text NOT NULL,
    kind text NOT NULL,
    verifier text NOT NULL,
    nonce text NOT NULL,
    return_to text NOT NULL,
    session_id_hash text,
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    binding_hash text
);

CREATE TABLE public.probe_results (
    id bigint NOT NULL,
    probe_key text NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    status text NOT NULL,
    metric double precision,
    duration_ms integer,
    message text,
    details jsonb,
    schedule_run_id uuid,
    CONSTRAINT probe_results_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'warn'::text, 'crit'::text, 'error'::text])))
);

CREATE SEQUENCE public.probe_results_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.probe_results_id_seq OWNED BY public.probe_results.id;

CREATE TABLE public.run_step_events (
    id bigint NOT NULL,
    run_id uuid NOT NULL,
    step_seq integer,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    type text NOT NULL,
    level text,
    data jsonb
);

CREATE SEQUENCE public.run_step_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.run_step_events_id_seq OWNED BY public.run_step_events.id;

CREATE TABLE public.run_steps (
    run_id uuid NOT NULL,
    seq integer NOT NULL,
    step_id text NOT NULL,
    path text NOT NULL,
    type text NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    status text NOT NULL,
    actor_oid text,
    mode text NOT NULL,
    request jsonb,
    plan jsonb,
    output jsonb,
    error jsonb,
    ms_request_id text,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    CONSTRAINT run_steps_status_check CHECK ((status = ANY (ARRAY['running'::text, 'waiting'::text, 'succeeded'::text, 'failed'::text, 'skipped'::text, 'planned'::text, 'retried'::text, 'cancelled'::text, 'compensated'::text, 'needs_review'::text])))
);

CREATE TABLE public.runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    definition_key text NOT NULL,
    definition_version text NOT NULL,
    definition_sha256 text NOT NULL,
    status text NOT NULL,
    dry_run boolean DEFAULT false NOT NULL,
    trigger text DEFAULT 'interactive'::text NOT NULL,
    identity text DEFAULT 'delegated'::text NOT NULL,
    initiator_oid text,
    initiator_upn text,
    session_hash text,
    schedule_id uuid,
    parent_run_id uuid,
    inputs jsonb DEFAULT '{}'::jsonb NOT NULL,
    outputs jsonb,
    error jsonb,
    correlation_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    identity_name text,
    CONSTRAINT runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'awaiting_approval'::text, 'awaiting_input'::text, 'awaiting_arm'::text, 'awaiting_reauth'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'compensated'::text, 'needs_review'::text])))
);

CREATE TABLE public.saved_views (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_oid text NOT NULL,
    page_key text NOT NULL,
    name text NOT NULL,
    state jsonb NOT NULL,
    shared boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.schedule_grants (
    schedule_id uuid NOT NULL,
    user_oid text NOT NULL,
    upn text NOT NULL,
    home_account_id text NOT NULL,
    status text NOT NULL,
    reason text,
    consented_at timestamp with time zone NOT NULL,
    checked_at timestamp with time zone,
    CONSTRAINT schedule_grants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'needs_sign_in'::text])))
);

CREATE TABLE public.schedule_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    schedule_id uuid NOT NULL,
    schedule_key text NOT NULL,
    trigger text NOT NULL,
    status text NOT NULL,
    run_id uuid,
    result jsonb,
    error jsonb,
    artifact_path text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    CONSTRAINT schedule_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'timeout'::text, 'skipped'::text])))
);

CREATE TABLE public.schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    source text NOT NULL,
    definition jsonb NOT NULL,
    sha256 text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    created_by text,
    approved_by text,
    next_run_at timestamp with time zone,
    last_run_at timestamp with time zone,
    last_status text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_target text,
    CONSTRAINT schedules_last_status_check CHECK ((last_status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'timeout'::text, 'skipped'::text])))
);

CREATE TABLE public.sessions (
    id_hash text NOT NULL,
    user_oid text NOT NULL,
    upn text NOT NULL,
    display_name text NOT NULL,
    tenant_id text NOT NULL,
    tenant_name text NOT NULL,
    tenant_domain text NOT NULL,
    roles text[] DEFAULT '{}'::text[] NOT NULL,
    csrf text NOT NULL,
    read_account_id text,
    write_account_id text,
    write_expires_at timestamp with time zone,
    write_extended boolean DEFAULT false NOT NULL,
    write_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ip text,
    user_agent text,
    roles_checked_at timestamp with time zone
);

CREATE TABLE public.settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.token_cache (
    partition_key text NOT NULL,
    sealed text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.user_prefs (
    user_oid text NOT NULL,
    prefs jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.audit_events ALTER COLUMN seq SET DEFAULT nextval('public.audit_events_seq_seq'::regclass);

ALTER TABLE ONLY public.probe_results ALTER COLUMN id SET DEFAULT nextval('public.probe_results_id_seq'::regclass);

ALTER TABLE ONLY public.run_step_events ALTER COLUMN id SET DEFAULT nextval('public.run_step_events_id_seq'::regclass);

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (seq);

ALTER TABLE ONLY public.definitions
    ADD CONSTRAINT definitions_kind_key_version UNIQUE (kind, key, version);

ALTER TABLE ONLY public.definitions
    ADD CONSTRAINT definitions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.news_feed_state
    ADD CONSTRAINT news_feed_state_pkey PRIMARY KEY (feed_key);

ALTER TABLE ONLY public.news_items
    ADD CONSTRAINT news_items_feed_external_uq UNIQUE (feed_key, external_id);

ALTER TABLE ONLY public.news_items
    ADD CONSTRAINT news_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.preauth
    ADD CONSTRAINT preauth_pkey PRIMARY KEY (state);

ALTER TABLE ONLY public.probe_results
    ADD CONSTRAINT probe_results_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.run_step_events
    ADD CONSTRAINT run_step_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.run_steps
    ADD CONSTRAINT run_steps_run_id_seq_pk PRIMARY KEY (run_id, seq);

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.saved_views
    ADD CONSTRAINT saved_views_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.schedule_grants
    ADD CONSTRAINT schedule_grants_pkey PRIMARY KEY (schedule_id);

ALTER TABLE ONLY public.schedule_runs
    ADD CONSTRAINT schedule_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_key_unique UNIQUE (key);

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id_hash);

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.token_cache
    ADD CONSTRAINT token_cache_pkey PRIMARY KEY (partition_key);

ALTER TABLE ONLY public.user_prefs
    ADD CONSTRAINT user_prefs_pkey PRIMARY KEY (user_oid);

CREATE INDEX approvals_status_idx ON public.approvals USING btree (status);

CREATE INDEX approvals_subject_idx ON public.approvals USING btree (subject_type, subject_id);

CREATE INDEX audit_action_idx ON public.audit_events USING btree (action);

CREATE INDEX audit_actor_idx ON public.audit_events USING btree (actor_oid);

CREATE INDEX audit_correlation_idx ON public.audit_events USING btree (correlation_id);

CREATE INDEX audit_ts_idx ON public.audit_events USING btree (ts);

CREATE INDEX definitions_lookup_idx ON public.definitions USING btree (kind, key, status);

CREATE INDEX news_items_activity_idx ON public.news_items USING btree (activity_at DESC NULLS LAST, id DESC NULLS LAST);

CREATE INDEX news_items_areas_idx ON public.news_items USING gin (areas);

CREATE INDEX news_items_changed_idx ON public.news_items USING btree (changed_at);

CREATE INDEX news_items_feed_idx ON public.news_items USING btree (feed_key, activity_at);

CREATE INDEX preauth_expires_idx ON public.preauth USING btree (expires_at);

CREATE INDEX probe_results_probe_ts_idx ON public.probe_results USING btree (probe_key, ts);

CREATE INDEX run_step_events_run_idx ON public.run_step_events USING btree (run_id, id);

CREATE INDEX runs_created_idx ON public.runs USING btree (created_at);

CREATE INDEX runs_definition_idx ON public.runs USING btree (definition_key);

CREATE INDEX runs_initiator_idx ON public.runs USING btree (initiator_oid, created_at);

CREATE INDEX runs_parent_idx ON public.runs USING btree (parent_run_id);

CREATE INDEX runs_status_idx ON public.runs USING btree (status);

CREATE INDEX saved_views_page_idx ON public.saved_views USING btree (page_key, user_oid);

CREATE INDEX schedule_runs_schedule_idx ON public.schedule_runs USING btree (schedule_id, started_at);

CREATE INDEX sessions_expires_idx ON public.sessions USING btree (expires_at);

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_oid);

CREATE TRIGGER approvals_append_only BEFORE INSERT OR UPDATE ON public.approvals FOR EACH ROW EXECUTE FUNCTION public.approvals_append_only();

CREATE CONSTRAINT TRIGGER approvals_delete_with_subject AFTER DELETE ON public.approvals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.approvals_delete_with_subject();

CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON public.audit_events FOR EACH STATEMENT EXECUTE FUNCTION public.audit_events_append_only();

CREATE TRIGGER audit_events_no_update_delete BEFORE DELETE OR UPDATE ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.audit_events_append_only();

ALTER TABLE ONLY public.probe_results
    ADD CONSTRAINT probe_results_schedule_run_id_schedule_runs_id_fk FOREIGN KEY (schedule_run_id) REFERENCES public.schedule_runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.run_step_events
    ADD CONSTRAINT run_step_events_run_id_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.run_steps
    ADD CONSTRAINT run_steps_run_id_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_parent_run_id_runs_id_fk FOREIGN KEY (parent_run_id) REFERENCES public.runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_schedule_id_schedules_id_fk FOREIGN KEY (schedule_id) REFERENCES public.schedules(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.schedule_grants
    ADD CONSTRAINT schedule_grants_schedule_id_schedules_id_fk FOREIGN KEY (schedule_id) REFERENCES public.schedules(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.schedule_runs
    ADD CONSTRAINT schedule_runs_run_id_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.schedule_runs
    ADD CONSTRAINT schedule_runs_schedule_id_schedules_id_fk FOREIGN KEY (schedule_id) REFERENCES public.schedules(id);

