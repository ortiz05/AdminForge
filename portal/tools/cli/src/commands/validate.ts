/**
 * `adminforge validate [--scopes] [--env <name>]` — checks portal/content before it is committed or published.
 *
 * Without options: the offline check in content/check.ts (schema, references, expressions, injection lint, datasource
 * rules, runner script pins, env keys); prints `✗` errors and `⚠` warnings with file:line, then a summary. Reads
 * files only.
 *
 * `--scopes`: also compares the permissions content declares (`requires.scopes`) with what is granted to the Read
 * and Write apps and the automation identity in Entra, using the same expectation as `provision entra` (baseline,
 * content, permission ceilings), so the two never disagree. Signs in as the provisioner identity and only reads
 * (service principals, grants, app-role assignments). Reads AF_TENANT_ID, AF_PROVISIONER_CLIENT_ID / _SECRET,
 * AF_READ_CLIENT_ID, AF_WRITE_CLIENT_ID, AF_AUTOMATION_CLIENT_ID and the ceiling opt-ins.
 *
 * Exit code 1 on any error, or with --scopes on a missing scope or an app without a service principal; warnings and
 * unused scopes don't fail.
 */
import { provisionerClients } from '../provision/clients';
import { ceilingSettings, provisionSettings, scheduleIdentityNames } from '../provision/settings';
import { identityEnvPrefix } from '@adminforge/schemas';
import { checkContent } from '../content/check';
import { relPath, type ContentCliContext } from '../content/context';
import {
  compareScopes,
  consentedScopes,
  declaredScopes,
  provisionedScopes,
  type ScopeApp,
} from '../content/scopes';

const LABELS: Record<string, string> = {
  read: 'Read app',
  write: 'Write app',
  automation: 'Automation identity',
};
/** "Read app", "Automation identity", "App identity reports-team" (ADR-014). */
const appLabel = (app: ScopeApp) =>
  LABELS[app] ?? (app.startsWith('identity:') ? `App identity ${app.slice('identity:'.length)}` : app);

/** `adminforge validate [--scopes]` — true when there are no errors (warnings and unused scopes don't fail). */
export async function validateContent(
  ctx: ContentCliContext,
  opts: { scopes?: boolean } = {},
): Promise<boolean> {
  const report = await checkContent(ctx);
  for (const e of report.errors) ctx.out(`✗ ${e}`);
  for (const w of report.warnings) ctx.out(`⚠ ${w}`);
  let ok = report.errors.length === 0;
  ctx.out(
    ok
      ? `✓ ${report.definitions} definitions valid (schema, references, expressions, lint, env keys).`
      : `✗ ${report.errors.length} problem(s) in ${relPath(ctx, ctx.contentDir)}.`,
  );
  if (!opts.scopes) return ok;

  const declared = declaredScopes(report.loaded);
  const apps: Partial<Record<ScopeApp, string>> = {
    read: ctx.env.AF_READ_CLIENT_ID,
    write: ctx.env.AF_WRITE_CLIENT_ID,
    automation: ctx.env.AF_AUTOMATION_CLIENT_ID,
    // Named app identities (AF_SCHEDULE_IDENTITIES): their own app registrations.
    ...Object.fromEntries(
      scheduleIdentityNames(ctx.env).map((n) => [
        `identity:${n}`,
        ctx.env[`${identityEnvPrefix(n)}CLIENT_ID`],
      ]),
    ),
  };
  const graph =
    ctx.graph ??
    provisionerClients(
      { env: ctx.env, writeEnv: () => undefined, out: ctx.out, fetch: ctx.fetch },
      provisionSettings(ctx.env),
    ).graph;
  const { scopes: consented, notFound, present } = await consentedScopes(graph, apps);
  // Same expectation as `provision entra` (baseline, content, ceilings), so the two never disagree.
  const provisioned = provisionedScopes(ceilingSettings(ctx.env), declared.scopes);
  const { missing, unused, withheld, unlicensed, baseline } = compareScopes(
    declared,
    consented,
    provisioned,
    present,
  );
  const files = (f?: string[]) =>
    f?.length ? `  (${f.slice(0, 3).join(', ')}${f.length > 3 ? ', …' : ''})` : '';
  ctx.out('');
  ctx.out('Scopes declared by content vs. granted in Entra:');
  for (const app of Object.keys(apps) as ScopeApp[])
    if (!apps[app]) ctx.out(`  ⚠ ${appLabel(app)}: client id not set in the env file; not checked.`);
  for (const app of notFound)
    ctx.out(`  ✗ ${appLabel(app)}: no service principal found for the configured client id.`);
  for (const m of missing)
    ctx.out(`  ✗ missing  ${appLabel(m.app)} · ${m.service} · ${m.scope}${files(m.files)}`);
  for (const w of withheld)
    ctx.out(`  ⚠ withheld ${appLabel(w.app)} · ${w.service} · ${w.scope} — ${w.reason}${files(w.files)}`);
  for (const u of unlicensed)
    ctx.out(
      `  ⚠ skipped  ${appLabel(u.app)} · ${u.service} · ${u.scope} — workload not in this tenant (not licensed)${files(u.files)}`,
    );
  for (const u of unused)
    ctx.out(
      `  · unused   ${appLabel(u.app)} · ${u.service} · ${u.scope}  (not expected by provisioning: ${u.app === 'automation' || u.app.startsWith('identity:') ? '`provision entra --prune` removes the app role assignment' : '`provision entra` removes it'})`,
    );
  for (const b of baseline)
    ctx.out(
      b.builtin
        ? `  · built-in ${appLabel(b.app)} · ${b.service} · ${b.scope}  (${b.builtin})`
        : `  · unused   ${appLabel(b.app)} · ${b.service} · ${b.scope}  (baseline in provision/catalog.ts; no content declares it)`,
    );
  if (declared.connections.length)
    ctx.out(`  · not checked (own audiences): connections ${declared.connections.join(', ')}`);
  if (!missing.length && !notFound.length)
    ctx.out('  ✓ every declared scope provisioning grants is granted.');
  ok &&= missing.length === 0 && notFound.length === 0;
  return ok;
}
