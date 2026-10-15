import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { Playbook } from '@adminforge/schemas';
import { useNow, useToast } from '@adminforge/ui';
import { useShell } from '../app/shell-context';
import { activeRunsQueryKey } from '../runs/keys';
import { api, ApiRequestError } from '../lib/api';
import { useMe } from '../lib/session';
import { isParked, isTerminal, StartRunResponse, type RunDetail } from '../runs/contracts';
import { runDetailQuery } from '../runs/queries';
import { bulkConfirmationText, confirmationText } from './confirm';
import { inputsOf } from './contracts';
import { initialValues, previewMatches, validateForm, type FormValues } from './form';
import { encodeParam, itemInputs, type ParsedLaunch } from './url';

export type SearchPatch = Partial<Record<'inputs' | 'preview', string | undefined>>;

/** The server refuses a preview older than this ("preview then confirm"). */
export const PREVIEW_TTL_MS = 15 * 60_000;

export interface PlaybookFlowOptions {
  def: Playbook;
  version: string;
  launch: ParsedLaunch;
  /** Writes drawer state back to the URL (replace), so arming and reloads return to the same place. */
  setSearch: (patch: SearchPatch) => void;
  /** Called once a real run has started (the drawer closes; the page navigates). */
  onStarted?: (runId: string) => void;
}

export interface ConfirmState {
  /** What to type (typed confirmation), or null for a click-through confirmation. */
  text: string | null;
  description: string;
}

/** Errors that mean "preview again" rather than "something broke". */
const PREVIEW_CODES = new Set(['preview_required', 'preview_stale']);
export const isPreviewError = (e: unknown) =>
  e instanceof ApiRequestError && e.status === 409 && PREVIEW_CODES.has(e.code);
export const isConfirmationError = (e: unknown) =>
  e instanceof ApiRequestError && e.status === 422 && e.code === 'confirmation_mismatch';

const previewTime = (d: RunDetail | undefined) => {
  const t = d ? Date.parse(d.run.endedAt ?? d.run.startedAt ?? d.run.createdAt ?? '') : Number.NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * State machine of the playbook template (§6.6): generated form → Preview (dry run: read steps execute, write steps
 * are planned) → Run. The server enforces "preview then confirm": write runs send the dry run's id
 * (`previewRunId`, at most 15 minutes old, same inputs) and, for typed confirmation, what the engineer typed
 * (`confirmation`; bulk: the number of items). Any input edit invalidates the preview; a stale preview is refreshed
 * automatically when Run is pressed, and the confirmation is asked again.
 */
export function usePlaybookFlow({ def, version, launch, setSearch, onStarted }: PlaybookFlowOptions) {
  const me = useMe();
  const { arm } = useShell();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const now = useNow(15_000);
  const params = inputsOf(def);
  const items = launch.items;
  const bulk = items !== null;
  const writes = def.mode === 'write';
  const confirmType =
    def.confirm?.type ?? (def.risk === 'high' || def.risk === 'critical' ? 'typed' : 'none');
  /** Single write runs always preview first; bulk runs do when the playbook asks for a typed confirmation. */
  const needsPreview =
    writes && (!bulk || confirmType === 'typed' || def.risk === 'high' || def.risk === 'critical');

  // Bulk: inputs that every item supplies are not asked again.
  const perItemKeys = useMemo(
    () =>
      items
        ? Object.keys(params).filter(
            (k) => items.length > 0 && items.every((it) => itemInputs(it)[k] !== undefined),
          )
        : [],
    [items, params],
  );

  const [initial] = useState(() => initialValues(params, launch.inputs, perItemKeys));
  const [values, setValues] = useState<FormValues>(initial.values);
  const [showErrors, setShowErrors] = useState(false);
  const validation = useMemo(() => validateForm(params, values, perItemKeys), [params, values, perItemKeys]);
  const errors = showErrors ? validation.errors : {};

  // Any edit after a preview invalidates it (even one that is later undone): preview again.
  const [edited, setEdited] = useState(false);
  const setValue = useCallback((name: string, value: unknown) => {
    setValues((v) => ({ ...v, [name]: value }));
    setEdited(true);
  }, []);

  // Keep the URL in step with the form (debounced), so the arm round trip restores it.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const id = window.setTimeout(() => setSearch({ inputs: encodeParam(values) }), 400);
    return () => window.clearTimeout(id);
  }, [values, setSearch]);

  // ── Preview (dry run) ────────────────────────────────────────────────────────────────────────────
  const [previewId, setPreviewId] = useState<string | null>(bulk ? null : launch.preview);
  /** The server said the preview is missing or too old (409): treat it as stale until the next preview. */
  const [rejected, setRejected] = useState<string | null>(null);
  const preview = useQuery({
    ...runDetailQuery(previewId ?? 'none'),
    enabled: Boolean(previewId),
    refetchInterval: (q) => {
      const s = q.state.data?.run.status;
      return s && (isTerminal(s) || isParked(s)) ? false : 700;
    },
  });
  const detail = preview.data as RunDetail | undefined;
  const previewDone = Boolean(detail && (isTerminal(detail.run.status) || isParked(detail.run.status)));
  const previewOk = previewDone && detail?.run.status === 'succeeded';
  const sameInputs = Boolean(
    detail && validation.ok && (bulk || previewMatches(validation.values, detail.run.inputs)),
  );
  const previewFresh = Boolean(detail) && !edited && sameInputs;
  const at = previewTime(detail);
  const expiresInMs = at === null ? null : at + PREVIEW_TTL_MS - now;
  const previewStale =
    Boolean(detail) && (rejected === previewId || (expiresInMs !== null && expiresInMs <= 0));

  const startPreview = useMutation({
    mutationFn: (inputs: Record<string, unknown>) =>
      bulk
        ? api('/api/runs/bulk', {
            method: 'POST',
            body: {
              playbook: def.id,
              version,
              items: (items ?? []).map(itemInputs),
              inputsTemplate: inputs,
              dryRun: true,
            },
            schema: StartRunResponse,
          })
        : api('/api/runs', {
            method: 'POST',
            body: { playbook: def.id, version, inputs, dryRun: true },
            schema: StartRunResponse,
          }),
    onSuccess: ({ runId }) => {
      setPreviewId(runId);
      setRejected(null);
      if (!bulk) setSearch({ preview: runId });
    },
  });

  const runPreview = () => {
    setShowErrors(true);
    if (!validation.ok) return false;
    setEdited(false);
    startRun.reset();
    startBulk.reset();
    startPreview.mutate(validation.values);
    return true;
  };

  // ── Run ─────────────────────────────────────────────────────────────────────────────────────────
  const started = (runId: string, label: string) => {
    void queryClient.invalidateQueries({ queryKey: activeRunsQueryKey });
    toast({
      tone: 'info',
      title: `${label} started`,
      description: 'Follow it on the run page or in the run dock.',
    });
    if (onStarted) onStarted(runId);
    else void navigate({ to: '/runs/$id', params: { id: runId } });
  };

  const onRunError = (e: unknown) => {
    // 409: the server wants a (new) preview. Close the confirmation; the drawer explains and offers Preview again.
    if (isPreviewError(e)) {
      setRejected(previewId);
      setConfirm(null);
    }
  };

  const startRun = useMutation({
    mutationFn: (body: { inputs: Record<string, unknown>; confirmation?: string }) =>
      api('/api/runs', {
        method: 'POST',
        body: {
          playbook: def.id,
          version,
          inputs: body.inputs,
          dryRun: false,
          ...(writes && previewId ? { previewRunId: previewId } : {}),
          ...(body.confirmation !== undefined ? { confirmation: body.confirmation } : {}),
        },
        schema: StartRunResponse,
      }),
    onSuccess: ({ runId }) => started(runId, def.title),
    onError: onRunError,
  });

  const startBulk = useMutation({
    mutationFn: (body: { inputs: Record<string, unknown>; confirmation?: string }) =>
      api('/api/runs/bulk', {
        method: 'POST',
        body: {
          playbook: def.id,
          version,
          items: (items ?? []).map(itemInputs),
          inputsTemplate: body.inputs,
          ...(previewId ? { previewRunId: previewId } : {}),
          ...(body.confirmation !== undefined ? { confirmation: body.confirmation } : {}),
        },
        schema: StartRunResponse,
      }),
    onSuccess: ({ runId }) => started(runId, `${def.title} × ${items?.length ?? 0}`),
    onError: onRunError,
  });

  /** Why Run can't be pressed right now (null = it can). Locking for read mode is WriteAction's job. A stale preview
   * doesn't block: pressing Run refreshes it first. */
  const blocked: string | null = !validation.ok
    ? 'Fill in the required inputs first.'
    : bulk && items!.length === 0
      ? 'No items were selected.'
      : needsPreview && !detail
        ? 'Preview first: the plan shows every change before it runs.'
        : needsPreview && !previewDone
          ? 'Wait for the preview to finish.'
          : needsPreview && !previewOk
            ? 'The preview failed. Fix the problem, then preview again.'
            : needsPreview && !previewFresh
              ? 'Inputs changed — preview again.'
              : null;

  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  /** Run was pressed with a stale preview: it is refreshed first, then the confirmation is asked again. */
  const [refreshing, setRefreshing] = useState(false);

  /** Starts the run; rejects on a confirmation mismatch so the dialog can show the server's message. */
  const go = async (confirmation?: string) => {
    const body = { inputs: validation.values, ...(confirmation !== undefined ? { confirmation } : {}) };
    if (bulk) await startBulk.mutateAsync(body);
    else await startRun.mutateAsync(body);
  };

  const openConfirm = async (basis: RunDetail | undefined) => {
    const count = items?.length ?? 0;
    const changes = bulk
      ? `${count} object${count === 1 ? '' : 's'}`
      : `${basis?.plan.length ?? 0} change${basis?.plan.length === 1 ? '' : 's'}`;
    const description = writes
      ? bulk
        ? `This changes ${changes} in ${me.tenant.name} as ${me.user.upn}, one child run per item.`
        : `This makes ${changes} in ${me.tenant.name} as ${me.user.upn}. It’s audited${def.inputs && 'reason' in def.inputs ? ' with your reason' : ''}.`
      : `This runs the playbook’s read steps as ${me.user.upn}.`;
    if (!writes || confirmType === 'none') return void go().catch(() => undefined);
    if (confirmType === 'click') return setConfirm({ text: null, description });
    const text = bulk ? bulkConfirmationText(count) : await confirmationText(def, basis ?? null, me.user);
    setConfirm({ text, description });
  };

  /** Dry-runs again and waits for the result (used when Run finds the preview expired). */
  const refreshPreview = async (): Promise<RunDetail | null> => {
    setEdited(false);
    const { runId } = await startPreview.mutateAsync(validation.values);
    for (let i = 0; i < 240; i++) {
      const d = await queryClient.fetchQuery({ ...runDetailQuery(runId), staleTime: 0 });
      if (isTerminal(d.run.status) || isParked(d.run.status)) return d;
      await new Promise((r) => window.setTimeout(r, 700));
    }
    return null;
  };

  const requestRun = async () => {
    setShowErrors(true);
    if (blocked) return;
    if (writes && !arm.armed) return;
    if (needsPreview && previewStale) {
      setRefreshing(true);
      try {
        const fresh = await refreshPreview();
        if (fresh?.run.status === 'succeeded') await openConfirm(fresh);
      } catch {
        // The preview's own error is shown in the drawer.
      } finally {
        setRefreshing(false);
      }
      return;
    }
    await openConfirm(detail);
  };

  const runError = startRun.error ?? startBulk.error ?? null;
  const failure =
    startPreview.error ??
    (runError && !isConfirmationError(runError) && !isPreviewError(runError) ? runError : null);

  return {
    def,
    params,
    writes,
    bulk,
    items,
    perItemKeys,
    unknownInputs: initial.unknown,
    values,
    setValue,
    errors,
    valid: validation.ok,
    needsPreview,
    preview: {
      id: previewId,
      query: preview,
      detail,
      done: previewDone,
      ok: previewOk,
      fresh: previewFresh,
      stale: previewStale,
      /** Milliseconds until the server stops accepting this preview (null without one). */
      expiresInMs,
      /** Why the server refused the last run (409), in its words. */
      rejection: runError && isPreviewError(runError) ? (runError as ApiRequestError) : null,
      pending: startPreview.isPending || (Boolean(previewId) && !previewDone && !preview.isError),
      refreshingForRun: refreshing,
      start: runPreview,
    },
    run: {
      blocked,
      pending: startRun.isPending || startBulk.isPending,
      request: () => void requestRun(),
      go,
    },
    confirm,
    closeConfirm: () => setConfirm(null),
    failure,
    armed: arm.armed,
  };
}

export type PlaybookFlow = ReturnType<typeof usePlaybookFlow>;
