import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { Playbook } from '@adminforge/schemas';
import { useToast } from '@adminforge/ui';
import { useShell } from '../app/shell-context';
import { activeRunsQueryKey } from '../runs/keys';
import { api } from '../lib/api';
import { useMe } from '../lib/session';
import { isParked, isTerminal, StartRunResponse, type RunDetail } from '../runs/contracts';
import { runDetailQuery } from '../runs/queries';
import { bulkConfirmationText, confirmationText } from './confirm';
import { inputsOf } from './contracts';
import { initialValues, previewMatches, validateForm, type FormValues } from './form';
import { encodeParam, itemInputs, type ParsedLaunch } from './url';

export type SearchPatch = Partial<Record<'inputs' | 'preview', string | undefined>>;

export interface PlaybookFlowOptions {
  def: Playbook;
  version: string;
  launch: ParsedLaunch;
  /** Writes drawer state back to the URL (replace), so arming and reloads return to the same place. */
  setSearch: (patch: SearchPatch) => void;
  /** Called once a real run has started (the drawer closes; the page navigates). */
  onStarted?: (runId: string) => void;
}

export type ConfirmState = { text: string | null; description: string } | null;

/**
 * State machine of the playbook template (§6.6): generated form → Preview (dry run: read steps execute, write steps
 * are planned) → Run, which for write playbooks needs write access (armed), a preview of exactly these inputs, and the
 * playbook's confirmation. Bulk launches (`items`) skip the preview and start one child run per item.
 */
export function usePlaybookFlow({ def, version, launch, setSearch, onStarted }: PlaybookFlowOptions) {
  const me = useMe();
  const { arm } = useShell();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = inputsOf(def);
  const items = launch.items;
  const bulk = items !== null;
  const writes = def.mode === 'write';

  // Bulk: inputs that every item supplies are not asked again.
  const perItemKeys = useMemo(
    () => (items ? Object.keys(params).filter((k) => items.length > 0 && items.every((it) => itemInputs(it)[k] !== undefined)) : []),
    [items, params],
  );

  const [initial] = useState(() => initialValues(params, launch.inputs, perItemKeys));
  const [values, setValues] = useState<FormValues>(initial.values);
  const [showErrors, setShowErrors] = useState(false);
  const validation = useMemo(() => validateForm(params, values, perItemKeys), [params, values, perItemKeys]);
  const errors = showErrors ? validation.errors : {};

  const setValue = useCallback((name: string, value: unknown) => {
    setValues((v) => ({ ...v, [name]: value }));
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
  const preview = useQuery({
    ...runDetailQuery(previewId ?? 'none'),
    enabled: Boolean(previewId),
    refetchInterval: (q) => {
      const s = q.state.data?.run.status;
      return s && (isTerminal(s) || isParked(s)) ? false : 700;
    },
  });
  const previewDone = Boolean(preview.data && (isTerminal(preview.data.run.status) || isParked(preview.data.run.status)));
  const previewOk = previewDone && preview.data?.run.status === 'succeeded';
  const previewFresh = Boolean(preview.data && validation.ok && previewMatches(validation.values, preview.data.run.inputs));

  const startPreview = useMutation({
    mutationFn: (inputs: Record<string, unknown>) =>
      api('/api/runs', { method: 'POST', body: { playbook: def.id, version, inputs, dryRun: true }, schema: StartRunResponse }),
    onSuccess: ({ runId }) => {
      setPreviewId(runId);
      setSearch({ preview: runId });
    },
  });

  const runPreview = () => {
    setShowErrors(true);
    if (!validation.ok) return false;
    startPreview.mutate(validation.values);
    return true;
  };

  // ── Run ─────────────────────────────────────────────────────────────────────────────────────────
  const started = (runId: string, label: string) => {
    void queryClient.invalidateQueries({ queryKey: activeRunsQueryKey });
    toast({ tone: 'info', title: `${label} started`, description: 'Follow it on the run page or in the run dock.' });
    if (onStarted) onStarted(runId);
    else void navigate({ to: '/runs/$id', params: { id: runId } });
  };

  const startRun = useMutation({
    mutationFn: (inputs: Record<string, unknown>) =>
      api('/api/runs', { method: 'POST', body: { playbook: def.id, version, inputs, dryRun: false }, schema: StartRunResponse }),
    onSuccess: ({ runId }) => started(runId, def.title),
  });

  const startBulk = useMutation({
    mutationFn: (inputsTemplate: Record<string, unknown>) =>
      api('/api/runs/bulk', {
        method: 'POST',
        body: { playbook: def.id, version, items: (items ?? []).map(itemInputs), inputsTemplate },
        schema: StartRunResponse,
      }),
    onSuccess: ({ runId }) => started(runId, `${def.title} × ${items?.length ?? 0}`),
  });

  /** Why Run can't be pressed right now (null = it can). Locking for read mode is WriteAction's job. */
  const blocked: string | null = !validation.ok
    ? 'Fill in the required inputs first.'
    : bulk
      ? items!.length === 0
        ? 'No items were selected.'
        : null
      : writes && !preview.data
        ? 'Preview first: the plan shows every change before it runs.'
        : writes && !previewDone
          ? 'Wait for the preview to finish.'
          : writes && !previewOk
            ? 'The preview failed. Fix the problem, then preview again.'
            : writes && !previewFresh
              ? 'The inputs changed since the preview. Preview again.'
              : null;

  const [confirm, setConfirm] = useState<ConfirmState>(null);

  const requestRun = async () => {
    setShowErrors(true);
    if (blocked) return;
    if (writes && !arm.armed) return;
    const type = def.confirm?.type ?? (def.risk === 'high' || def.risk === 'critical' ? 'typed' : 'none');
    const changes = bulk ? `once for each of ${items!.length} items` : `${preview.data?.plan.length ?? 0} change${preview.data?.plan.length === 1 ? '' : 's'}`;
    const description = writes
      ? `This makes ${changes} in ${me.tenant.name} as ${me.user.upn}. It’s audited${def.inputs && 'reason' in def.inputs ? ' with your reason' : ''}.`
      : `This runs the playbook’s read steps as ${me.user.upn}.`;
    if (!writes || type === 'none') return go();
    if (type === 'click') return setConfirm({ text: null, description });
    const text = bulk ? bulkConfirmationText(items!.length) : await confirmationText(def, preview.data ?? null, me.user);
    setConfirm({ text, description });
  };

  const go = async () => {
    if (bulk) await startBulk.mutateAsync(validation.values);
    else await startRun.mutateAsync(validation.values);
  };

  const failure = startPreview.error ?? startRun.error ?? startBulk.error ?? null;

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
    preview: {
      id: previewId,
      query: preview,
      detail: preview.data as RunDetail | undefined,
      done: previewDone,
      ok: previewOk,
      fresh: previewFresh,
      pending: startPreview.isPending || (Boolean(previewId) && !previewDone && !preview.isError),
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
