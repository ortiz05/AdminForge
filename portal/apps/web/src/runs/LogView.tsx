import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, codeBlock, CopyIcon, IconButton, Select, useCopy } from '@adminforge/ui';
import type { LogLine, RunStep } from './contracts';

const LEVEL_CLASS: Record<LogLine['level'], string> = {
  debug: 'text-fg-3',
  info: 'text-fg-3',
  warn: 'text-warn',
  error: 'text-crit',
};

const time = (ts: string | null) => (ts ? new Date(ts).toISOString().slice(11, 19) : '        ');

/**
 * Run logs (step events streamed over SSE): monospace, level words (not colour alone), filter by step and level,
 * follows the tail unless the reader scrolled up.
 */
export function LogView({ logs, steps, live }: { logs: LogLine[]; steps: RunStep[]; live?: boolean }) {
  const [step, setStep] = useState('all');
  const [level, setLevel] = useState('all');
  const [copied, copy] = useCopy();
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const s = codeBlock();

  const stepOf = useMemo(() => {
    const bySeq = new Map(steps.map((x) => [x.seq, x.stepId]));
    return (l: LogLine) => l.stepId ?? (l.stepSeq !== null ? bySeq.get(l.stepSeq) : undefined) ?? null;
  }, [steps]);
  const stepIds = useMemo(
    () => [...new Set(logs.map(stepOf).filter((x): x is string => !!x))],
    [logs, stepOf],
  );
  const shown = logs.filter(
    (l) =>
      (step === 'all' || stepOf(l) === step) &&
      (level === 'all' || (level === 'warn' ? l.level === 'warn' || l.level === 'error' : l.level === level)),
  );
  const text = shown
    .map(
      (l) =>
        `${time(l.ts)} ${l.level.toUpperCase().padEnd(5)} ${stepOf(l) ? `[${stepOf(l)}] ` : ''}${l.message}`,
    )
    .join('\n');

  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  return (
    <div className={s.root()}>
      <div className={s.bar({ className: 'h-auto min-h-10 flex-wrap gap-y-1 py-1' })}>
        <span className={s.title()}>
          {shown.length} line{shown.length === 1 ? '' : 's'}
          {live ? ' · live' : ''}
        </span>
        <span className="flex items-center gap-1.5">
          <Select
            aria-label="Show logs for step"
            value={step}
            onValueChange={setStep}
            triggerClassName="h-7 min-w-32 text-xs"
            options={[
              { value: 'all', label: 'All steps' },
              ...stepIds.map((id) => ({ value: id, label: id })),
            ]}
          />
          <Select
            aria-label="Minimum level"
            value={level}
            onValueChange={setLevel}
            triggerClassName="h-7 min-w-28 text-xs"
            options={[
              { value: 'all', label: 'All levels' },
              { value: 'warn', label: 'Warnings and errors' },
              { value: 'error', label: 'Errors only' },
            ]}
          />
          <IconButton
            size="sm"
            label={copied ? 'Copied' : 'Copy logs'}
            icon={copied ? <CheckIcon size={14} weight="bold" className="text-ok" /> : <CopyIcon size={14} />}
            onClick={() => void copy(text)}
          />
        </span>
      </div>
      <div
        ref={scroller}
        role="log"
        aria-label="Run logs"
        aria-live={live ? 'polite' : 'off'}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className={s.pre({ className: 'max-h-80 min-h-24' })}
      >
        {shown.length === 0 ? (
          <p className="text-fg-3">
            {logs.length
              ? 'No lines match these filters.'
              : live
                ? 'Waiting for output…'
                : 'This run wrote no log lines.'}
          </p>
        ) : (
          shown.map((l) => (
            <div key={l.id} className="flex gap-3 whitespace-pre-wrap">
              <span className="shrink-0 text-fg-3 tabular-nums">{time(l.ts)}</span>
              <span className={`w-11 shrink-0 font-semibold ${LEVEL_CLASS[l.level]}`}>
                {l.level.toUpperCase()}
              </span>
              {stepOf(l) && <span className="shrink-0 text-accent">[{stepOf(l)}]</span>}
              <span className="min-w-0 break-words text-fg-2">{l.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
