import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  confirmationMatches,
  isGuid,
  unusualCharacters,
  withoutBidiControls,
  type UnusualCharacter,
} from '@adminforge/schemas';
import { errorText } from '../lib/errors';
import {
  Button,
  CodeBlock,
  Dialog,
  TextField,
  IdChip,
  LockKeyOpenIcon,
  Skeleton,
  STATUS_ICON,
  formatRelative,
  formatTimestamp,
  useNow,
} from '@adminforge/ui';
import { WriteAction } from '../app/WriteAction';
import { useShell } from '../app/shell-context';
import { ApiRequestError } from '../lib/api';
import { useMe } from '../lib/session';
import { Callout, Facts } from '../ops/ui';
import { labelOf as stepLabelOf, latestSteps, type RunDetail, type StepIndex } from '../runs/contracts';
import { PlanView } from '../runs/PlanView';
import { MaskedSecret } from '../runs/SecretPanel';
import { isSecretMask, maskSecrets } from '../runs/secrets';
import { stepIndex } from '../runs/RunTimeline';
import { RunStatusPill, STEP_STATUS_VIEW, StatusGlyph } from '../runs/status';
import { humanize, labelOf } from './form';
import { InputsForm } from './InputsForm';
import { Requirements, RiskBanner } from './Preflight';
import { isConfirmationError, isPreviewError, type PlaybookFlow } from './usePlaybookFlow';
import { itemInputs, itemLabel } from './url';

function Value({ value }: { value: unknown }) {
  if (value === undefined || value === null || value === '') return <span className="text-fg-3">—</span>;
  if (typeof value === 'string' && isGuid(value))
    return <IdChip value={value} showLabel={false} label="Id" />;
  if (Array.isArray(value)) return <span className="font-mono text-xs">{value.map(String).join(', ')}</span>;
  if (typeof value === 'object')
    return <code className="font-mono text-xs break-all">{JSON.stringify(value)}</code>;
  return <span className="break-all">{String(value)}</span>;
}

/** Bulk launches: the items and what each one will run with (per-item inputs + the shared ones asked below). */
function BulkItems({ flow }: { flow: PlaybookFlow }) {
  const items = flow.items ?? [];
  const keys = flow.perItemKeys;
  return (
    <section aria-label="Items" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="af-eyebrow">Items</h3>
        <span className="text-xs text-fg-3">
          {items.length} item{items.length === 1 ? '' : 's'} · one child run each
        </span>
      </div>
      {items.length === 0 ? (
        <Callout tone="warn" title="No items were selected">
          Go back to the list, select the rows to act on, and choose the action again.
        </Callout>
      ) : (
        <div className="max-h-72 overflow-auto rounded-(--af-panel-radius) border border-line bg-panel">
          <table className="w-full text-sm">
            <caption className="sr-only">Inputs per item</caption>
            <thead className="sticky top-0 bg-raised text-left text-xs text-fg-3">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Item
                </th>
                {keys.map((k) => (
                  <th key={k} scope="col" className="px-3 py-2 font-medium">
                    {labelOf(k, flow.params[k]!)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => {
                const inputs = itemInputs(item);
                return (
                  <tr key={i} className="border-t border-line">
                    <th scope="row" className="px-3 py-2 text-left font-medium text-fg">
                      {itemLabel(item, i)}
                    </th>
                    {keys.map((k) => (
                      <td key={k} className="px-3 py-2 text-fg-2">
                        <Value value={inputs[k]} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {keys.length > 0 && (
        <p className="text-xs text-fg-3">
          {keys.map((k) => labelOf(k, flow.params[k]!)).join(', ')} come{keys.length === 1 ? 's' : ''} from
          each item.
          {Object.keys(flow.params).some((k) => !keys.includes(k) && !flow.params[k]!.hidden)
            ? ' The inputs below apply to every item.'
            : ''}
        </p>
      )}
    </section>
  );
}

/** Steps a dry run passes over without running them: what people do (approvals, checklists) and waits. */
const NOT_A_CHECK = new Set(['approval', 'manual', 'wait']);

function ReadChecks({ detail, index }: { detail: RunDetail; index: StepIndex }) {
  const reads = latestSteps(detail.steps).filter(
    (s) => s.mode === 'read' && s.status !== 'planned' && !NOT_A_CHECK.has(s.type),
  );
  if (reads.length === 0) return null;
  return (
    <section aria-label="Checks that ran" className="flex flex-col gap-2">
      <h3 className="af-eyebrow">Checks that ran</h3>
      <ul className="flex flex-col gap-1.5 text-sm">
        {reads.map((s) => {
          const view = STEP_STATUS_VIEW[s.status];
          return (
            <li key={s.path} className="flex items-start gap-2">
              <StatusGlyph status={s.status} tone={view.tone} size={15} colored className="mt-0.5" />
              <span className="min-w-0">
                <span className="text-fg">{stepLabelOf(index, s.stepId)}</span>
                <span className="sr-only">: {view.label}</span>
                {s.error && <span className="block text-crit">{s.error.message}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** A run's outputs: scalars as label/value pairs (timestamps in UTC + relative), objects as JSON. */
export function Outputs({ outputs, now }: { outputs: Record<string, unknown>; now: number }) {
  const entries = Object.entries(outputs).filter(([, v]) => v !== undefined && v !== null);
  if (!entries.length) return null;
  const scalars = entries.filter(([, v]) => typeof v !== 'object' || isSecretMask(v));
  const objects = entries.filter(([, v]) => typeof v === 'object' && !isSecretMask(v));
  return (
    <section aria-label="Outputs" className="flex flex-col gap-2">
      <h3 className="af-eyebrow">Outputs</h3>
      {scalars.length > 0 && (
        <Facts
          items={scalars.map(([k, v]) => [
            humanize(k),
            isSecretMask(v) ? (
              <MaskedSecret key={k} value={v} />
            ) : typeof v === 'string' && ISO_RE.test(v) ? (
              <time key={k} dateTime={v}>
                {formatTimestamp(v)} <span className="text-fg-3">· {formatRelative(v, now)}</span>
              </time>
            ) : typeof v === 'number' ? (
              <span key={k} className="tabular-nums">
                {v.toLocaleString('en-US')}
              </span>
            ) : (
              String(v)
            ),
          ])}
        />
      )}
      {objects.map(([k, v]) => (
        <CodeBlock
          key={k}
          title={humanize(k)}
          language="json"
          code={JSON.stringify(maskSecrets(v), null, 2)}
          maxHeight={220}
        />
      ))}
    </section>
  );
}

/** Bulk dry run: what each item would do. */
function BulkPreview({ detail }: { detail: RunDetail }) {
  const failing = detail.children.filter((c) => c.status !== 'succeeded');
  return (
    <section aria-label="Items in the preview" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="af-eyebrow">Items</h3>
        <span className="text-xs text-fg-3">
          {detail.children.length - failing.length} of {detail.children.length} ready
          {failing.length ? ` · ${failing.length} would stop` : ''}
        </span>
      </div>
      <ul className="overflow-hidden rounded-(--af-panel-radius) border border-line bg-panel text-sm">
        {detail.children.map((c) => (
          <li
            key={c.id}
            className="flex items-center justify-between gap-3 border-t border-line px-3 py-2 first:border-t-0"
          >
            <span className="min-w-0 truncate text-fg">{c.title}</span>
            <RunStatusPill status={c.status} waitingReason={c.waitingReason} size="sm" />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PreviewSection({ flow }: { flow: PlaybookFlow }) {
  const now = useNow(15_000);
  const ref = useRef<HTMLElement>(null);
  const detail = flow.preview.detail;
  const shown = Boolean(flow.preview.id || flow.preview.pending);
  useEffect(() => {
    if (!shown) return;
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    ref.current?.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }, [shown, flow.preview.id]);
  if (!shown) return null;
  const failedStep = detail?.run.error?.stepId;
  const index = stepIndex(flow.def);
  return (
    <section
      ref={ref}
      aria-label="Preview"
      aria-busy={!flow.preview.done || undefined}
      className="flex flex-col gap-4 border-t border-line pt-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="af-display text-md font-semibold text-fg">
          Preview <span className="font-normal text-fg-3">· dry run</span>
        </h2>
        <span className="flex items-center gap-2 text-xs text-fg-3">
          {detail ? (
            <RunStatusPill status={detail.run.status} waitingReason={detail.run.waitingReason} size="sm" />
          ) : (
            <Skeleton className="h-5 w-20" />
          )}
          {detail?.run.endedAt && <span>{formatRelative(detail.run.endedAt, now)}</span>}
        </span>
      </div>
      {flow.preview.query.isError ? (
        <Callout tone="crit" role="alert" title="The preview couldn’t be loaded">
          {(flow.preview.query.error as Error).message}
        </Callout>
      ) : !detail || !flow.preview.done ? (
        <div className="flex flex-col gap-2" role="status">
          <p className="text-sm text-fg-2">Running the read steps and planning the changes…</p>
          {detail ? (
            <ReadChecks detail={detail} index={index} />
          ) : (
            <Skeleton className="h-16 w-full" shape="block" />
          )}
        </div>
      ) : (
        <>
          {detail.run.status !== 'succeeded' && (
            <Callout
              tone="crit"
              role="alert"
              title={
                failedStep
                  ? `The preview stopped at “${stepLabelOf(index, failedStep)}”`
                  : 'The preview didn’t finish'
              }
            >
              <p>{detail.run.error?.message ?? 'The dry run ended without a plan.'}</p>
              {detail.run.error?.hint && <p className="mt-1">{detail.run.error.hint}</p>}
            </Callout>
          )}
          {detail.run.status === 'succeeded' &&
            flow.writes &&
            (flow.preview.rejection || !flow.preview.fresh || flow.preview.stale) && (
              <Callout
                tone="warn"
                role="status"
                title={
                  flow.preview.rejection
                    ? flow.preview.rejection.message
                    : !flow.preview.fresh
                      ? 'Inputs changed — preview again'
                      : 'This preview expired'
                }
                action={
                  <Button size="sm" pending={flow.preview.pending} onClick={() => flow.preview.start()}>
                    Preview again
                  </Button>
                }
              >
                {flow.preview.rejection
                  ? (flow.preview.rejection.hint ?? 'Nothing ran. Preview again, then confirm.')
                  : !flow.preview.fresh
                    ? 'The plan below is for the earlier inputs. Nothing runs until you preview the current ones.'
                    : `Previews are good for 15 minutes. Select ${flow.def.kind === 'runbook' ? 'Start runbook' : 'Run'} to preview again and confirm.`}
              </Callout>
            )}
          {detail.run.status === 'succeeded' && <PlanView plan={detail.plan} />}
          {flow.bulk && detail.children.length > 0 && <BulkPreview detail={detail} />}
          <ReadChecks detail={detail} index={index} />
          {!flow.writes && detail.run.outputs && <Outputs outputs={detail.run.outputs} now={now} />}
        </>
      )}
    </section>
  );
}

/** Everything above the actions: risk, requirements, items, the generated form, the preview. */
export function PlaybookSections({ flow, problems }: { flow: PlaybookFlow; problems: string[] }) {
  const { def } = flow;
  const notes = [
    ...problems,
    ...(flow.unknownInputs.length
      ? [
          `The link included inputs this ${def.kind} doesn’t take (${flow.unknownInputs.join(', ')}); they were left out.`,
        ]
      : []),
  ];
  const sharedCount = Object.entries(flow.params).filter(
    ([k, p]) => !p.hidden && !flow.perItemKeys.includes(k),
  ).length;
  return (
    <div className="flex flex-col gap-6">
      {notes.length > 0 && (
        <Callout tone="warn" title="Check the prefilled values">
          <ul className="flex list-disc flex-col gap-0.5 pl-4">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Callout>
      )}
      <RiskBanner def={def} bulkCount={flow.bulk ? (flow.items?.length ?? 0) : undefined} />
      {flow.bulk && <BulkItems flow={flow} />}
      {(!flow.bulk || sharedCount > 0) && (
        <section aria-label={flow.bulk ? 'Shared inputs' : 'Inputs'} className="flex flex-col gap-3">
          <h3 className="af-eyebrow">{flow.bulk ? 'For every item' : 'Inputs'}</h3>
          <InputsForm
            params={flow.params}
            values={flow.values}
            errors={flow.errors}
            onChange={flow.setValue}
            omit={flow.perItemKeys}
            kind={def.kind}
          />
        </section>
      )}
      <Requirements requires={def.requires} writes={flow.writes} />
      <PreviewSection flow={flow} />
      {flow.failure && (
        <Callout tone="crit" role="alert" title="AdminForge couldn’t start that">
          <p>{(flow.failure as Error).message}</p>
          {flow.failure instanceof ApiRequestError && flow.failure.hint && (
            <p className="mt-1">{flow.failure.hint}</p>
          )}
          {flow.failure instanceof ApiRequestError && flow.failure.correlationId && (
            <p className="mt-2">
              <IdChip value={flow.failure.correlationId} label="Reference" />
            </p>
          )}
        </Callout>
      )}
    </div>
  );
}

/**
 * The text to type, with what could make it pass for another name marked where it sits: look-alike letters
 * underlined on a warn tint, invisible characters replaced by their code point (not selectable and hidden from screen
 * readers, so copying copies only the visible text, which confirms just the same; the note under the field names
 * them).
 */
function ConfirmText({ text, unusual }: { text: string; unusual: UnusualCharacter[] }) {
  const marked = new Map(unusual.filter((u) => u.misleading).map((u) => [u.char, u]));
  return (
    <code className="rounded-sm bg-sunken px-1 py-0.5 break-all text-fg">
      {Array.from(text).map((ch, i) => {
        const u = marked.get(ch);
        if (!u) return ch;
        // An invisible character is shown by its code point only: the comparison ignores it, and a bidi control
        // left in the text could reorder what follows.
        return u.invisible ? (
          <span
            key={i}
            aria-hidden
            className="mx-px rounded-sm bg-warn-subtle px-0.5 text-2xs text-fg-2 select-none"
          >
            {u.codePoint}
          </span>
        ) : (
          <span
            key={i}
            className="rounded-sm bg-warn-subtle px-px text-fg underline decoration-warn decoration-2 underline-offset-2"
          >
            {ch}
          </span>
        );
      })}
    </code>
  );
}

const MAX_LISTED = 5;
const article = (word: string) => (/^[AEIOU]/.test(word) ? 'an' : 'a');

/** One unusual character in words: "a Cyrillic “е” (U+0435)", "an invisible character (U+200B)". */
function describeCharacter(u: UnusualCharacter): string {
  if (u.invisible) return `an invisible character (${u.codePoint})`;
  if (u.kind === 'space') return `a space that isn’t a plain one (${u.codePoint})`;
  if (u.kind.startsWith('different form')) return `“${u.char}”, a ${u.kind} (${u.codePoint})`;
  if (u.script) return `${article(u.script)} ${u.script} “${u.char}” (${u.codePoint})`;
  return `“${u.char}” (${u.kind}, ${u.codePoint})`;
}

/** "x, y and z" — at most five, then "and 3 more". */
function listCharacters(list: UnusualCharacter[]): string {
  const shown = list.slice(0, MAX_LISTED).map(describeCharacter);
  const rest = list.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : (shown[0] ?? '');
}

/**
 * Under the field (its description): what in the text isn't plain. Characters that can make a name pass for another
 * one (an app named to imitate a trusted one) get a warning; others (accents, curly quotes, another writing system)
 * only a note that copying is easier than typing.
 */
function UnusualNote({ unusual }: { unusual: UnusualCharacter[] }) {
  const misleading = unusual.filter((u) => u.misleading);
  const other = unusual.filter((u) => !u.misleading);
  if (misleading.length === 0)
    return (
      <>
        It has characters a keyboard may not type: {listCharacters(other)}. To confirm, copy the name from the
        line above.
      </>
    );
  const Warn = STATUS_ICON.warn;
  return (
    <span className="flex flex-col gap-1 text-fg-2">
      <span className="flex items-start gap-1">
        <Warn size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0 text-warn" />
        <span>
          <span className="font-semibold text-fg">Check the name:</span> it has characters that can make it
          pass for another — {listCharacters(misleading)}.
          {other.length > 0 && ` It also has ${listCharacters(other)}.`}
        </span>
      </span>{' '}
      <span>
        Make sure it’s the one you meant to change. To confirm, copy the name from the line above; case,
        spaces and invisible characters don’t count.
      </span>
    </span>
  );
}

/**
 * The confirmation before a write: what will change, the playbook's message and (typed confirmation) the text to
 * type — both rendered by the API from the preview, never evaluated here. Typed text is compared the API's way
 * (`confirmationMatches`), and the API checks it again; its 422 message appears under the field and the dialog stays
 * open.
 */
function RunConfirmDialog({ flow, label }: { flow: PlaybookFlow; label: string }) {
  const { def } = flow;
  const confirm = flow.confirm!;
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const count = flow.items?.length ?? 0;
  const asksToType = confirm.kind === 'typed';
  const unusual = useMemo(() => (confirm.text ? unusualCharacters(confirm.text) : []), [confirm.text]);
  const matches = !asksToType || (confirm.text !== null && confirmationMatches(typed, confirm.text));
  const submit = async () => {
    if (!matches || pending) return;
    setPending(true);
    setError(null);
    setFailure(null);
    try {
      await flow.run.go(asksToType ? typed : undefined);
      flow.closeConfirm();
    } catch (e) {
      if (isConfirmationError(e)) setError((e as Error).message);
      else if (!isPreviewError(e)) setFailure(errorText(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && flow.closeConfirm()}
      size="sm"
      title={flow.bulk ? `${def.title} for ${count} items?` : `${def.title}?`}
      description={confirm.description}
      footer={
        <>
          <Button intent="ghost" onClick={flow.closeConfirm} aria-disabled={pending || undefined}>
            Cancel
          </Button>
          {/* Ember only in write mode: starting a runbook changes nothing itself (its write steps wait for write access). */}
          <Button
            intent={flow.writes && flow.armToRun && flow.armed ? 'armed' : 'primary'}
            pending={pending}
            aria-disabled={!matches || undefined}
            onClick={() => void submit()}
          >
            {label}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {!flow.bulk && flow.preview.detail && flow.preview.detail.plan.length > 0 && (
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-sm text-fg-2">
            {flow.preview.detail.plan.map((p, i) => (
              <li key={`${p.stepPath}-${i}`}>{withoutBidiControls(p.describe ?? p.stepId)}</li>
            ))}
          </ul>
        )}
        {confirm.message && <p className="text-sm text-fg-2">{confirm.message}</p>}
        {asksToType && confirm.text === null && (
          <Callout tone="crit" role="alert" title="This change can’t be confirmed">
            <p>
              The preview didn’t produce the text to type. Cancel, then select Preview again. If it keeps
              happening, tell the {def.kind}’s owner ({def.owner}).
            </p>
            {flow.preview.id && (
              <p className="mt-2">
                <IdChip value={flow.preview.id} label="Preview" />
              </p>
            )}
          </Callout>
        )}
        {asksToType && confirm.text !== null && (
          <TextField
            label={
              <>
                Type <ConfirmText text={confirm.text} unusual={unusual} /> to confirm
                {flow.bulk ? ` changing ${count} object${count === 1 ? '' : 's'}` : ''}
              </>
            }
            hint={unusual.length > 0 ? <UnusualNote unusual={unusual} /> : undefined}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setError(null);
            }}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            inputMode={flow.bulk ? 'numeric' : undefined}
            inputClassName="font-mono"
            error={error ?? undefined}
          />
        )}
        {failure && (
          <Callout tone="crit" role="alert" title="AdminForge couldn’t start that">
            {failure}
          </Callout>
        )}
      </form>
    </Dialog>
  );
}

/** "expires in 12 min" — the server refuses a preview after 15 minutes. `start`: what the run button is called. */
function expiryText(ms: number | null, start: 'Run' | 'Start runbook'): string | null {
  if (ms === null) return null;
  if (ms <= 0) return `Preview expired. Select ${start} to preview again and confirm.`;
  const min = Math.ceil(ms / 60_000);
  return `Preview expires in ${min} min.`;
}

/** Preview, Run (locked until armed for write playbooks; runbooks start without it), and the confirmation. */
export function PlaybookActions({ flow, align = 'end' }: { flow: PlaybookFlow; align?: 'end' | 'between' }) {
  const me = useMe();
  const { openArmDialog } = useShell();
  const { def } = flow;
  const statusId = useId();
  const runLabel = flow.runLabel;
  const needsArm = flow.writes && flow.armToRun && !flow.armed;
  // A runbook starts read-only, but one that writes still needs the role that runs changes (the API checks it too).
  const needsRole = flow.writes && !flow.armToRun && !me.roles.includes('Portal.Operator');
  const ready = flow.preview.ok && flow.preview.fresh && !flow.preview.rejection;
  const expiry =
    flow.writes && ready
      ? expiryText(flow.preview.expiresInMs, def.kind === 'runbook' ? 'Start runbook' : 'Run')
      : null;
  const status = flow.preview.refreshingForRun
    ? 'The preview expired: previewing again before you confirm…'
    : needsRole
      ? 'Starting this needs the Portal Operator role.'
      : needsArm
        ? me.canArm
          ? ready
            ? `Preview ready.${expiry ? ` ${expiry.replace(/^Preview /, '').replace(/^e/, 'E')}` : ''}`
            : 'Needs write access.'
          : 'Running this needs the Portal Operator role.'
        : (flow.run.blocked ?? expiry);

  const RunButton = flow.writes && flow.armToRun ? WriteAction : Button;
  // Invalid inputs keep the button pressable: pressing it shows what's missing. Other blockers lock it with a reason.
  const blockedNow = needsRole || (Boolean(flow.run.blocked) && flow.valid && !needsArm);

  return (
    <div
      className={`flex w-full flex-wrap items-center gap-2 ${align === 'between' ? 'justify-between' : 'justify-end'}`}
    >
      <p className="mr-auto min-w-0 flex-1 basis-48 text-xs text-fg-3">
        <span role="status" id={statusId}>
          {status}
        </span>
        {needsArm && me.canArm && (
          <button
            type="button"
            onClick={openArmDialog}
            className="ml-1.5 inline-flex items-center gap-1 rounded-sm font-semibold text-accent underline-offset-2 hover:underline"
          >
            <LockKeyOpenIcon size={12} aria-hidden />
            Arm write access
          </button>
        )}
      </p>
      {(!flow.bulk || flow.needsPreview) && (
        <Button intent="secondary" pending={flow.preview.pending} onClick={() => flow.preview.start()}>
          {flow.preview.id ? 'Preview again' : 'Preview (dry run)'}
        </Button>
      )}
      <RunButton
        intent="primary"
        pending={flow.run.pending || flow.preview.refreshingForRun}
        aria-disabled={blockedNow || undefined}
        aria-describedby={statusId}
        onClick={() => {
          if (!blockedNow) flow.run.request();
        }}
      >
        {runLabel}
      </RunButton>
      {flow.confirm && <RunConfirmDialog flow={flow} label={runLabel} />}
    </div>
  );
}

/** Which definition this is: key and pinned version, in mono (what runs and the audit log refer to). */
export function PlaybookMeta({ flow, version }: { flow: PlaybookFlow; version: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 font-mono text-2xs text-fg-3">
      <span>{flow.def.id}</span>
      <span aria-hidden>·</span>
      <span>v{version}</span>
    </span>
  );
}
