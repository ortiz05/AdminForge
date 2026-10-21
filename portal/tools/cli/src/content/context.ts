/**
 * The context the content commands (`validate`, `test`, `publish`, `new`, `fixtures record`) run in: where the
 * content, fixtures and repository are, the configuration, how to print — and, for tests, injectable stand-ins for
 * everything that would reach the network, the database, git or the playbook engine.
 *
 * `contentContext` builds the real one from the env (CONTENT_DIR and ADMINFORGE_FIXTURES_DIR override the default
 * directories); tests build their own `ContentCliContext` with temporary directories and fakes.
 */
import path from 'node:path';
import type { GraphClient } from '@adminforge/connectors';
import type { Out } from '../shared/output';
import type { AuditInput, AutomationTokenProvider, DbDefinitionStore } from './api-bridge';
import type { EngineModule } from './playbook-tests';
import type { ReviewState } from './review-state';

/** What the content commands need from the outside world (injected in tests). */
export interface ContentCliContext {
  env: Record<string, string | undefined>;
  out: Out;
  repoRoot: string;
  /** portal/content (CONTENT_DIR overrides). */
  contentDir: string;
  /** tests/fixtures (ADMINFORGE_FIXTURES_DIR overrides). */
  fixturesDir: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Tests: Graph client for --scopes instead of the provisioner identity. */
  graph?: GraphClient;
  /** Tests: automation identity for `fixtures record`. */
  automation?: Pick<AutomationTokenProvider, 'token'> | null;
  /** Tests: where publish records its audit event (default: the database's audit chain). */
  audit?: (input: AuditInput) => Promise<unknown>;
  /** Tests: publish target instead of the database at DATABASE_PATH. */
  openStore?: () => Promise<{ store: Pick<DbDefinitionStore, 'publish'>; close: () => Promise<void> }>;
  /** Tests: the engine module (runPlaybookTests). */
  engine?: EngineModule | null;
  /** Tests: the git review state of the content directory (default: reviewState, from git). */
  review?: (contentDir: string) => ReviewState;
}

/** The real context: directories from the env (or the repository defaults), output to `out`. */
export function contentContext(
  env: Record<string, string | undefined>,
  out: Out,
  repoRoot: string,
): ContentCliContext {
  return {
    env,
    out,
    repoRoot,
    contentDir: path.resolve(env.CONTENT_DIR || path.join(repoRoot, 'portal', 'content')),
    fixturesDir: path.resolve(env.ADMINFORGE_FIXTURES_DIR || path.join(repoRoot, 'tests', 'fixtures')),
  };
}

/** `file` relative to the repository, with forward slashes (for messages). */
export const relPath = (ctx: Pick<ContentCliContext, 'repoRoot'>, file: string) =>
  path.relative(ctx.repoRoot, file).split(path.sep).join('/');
