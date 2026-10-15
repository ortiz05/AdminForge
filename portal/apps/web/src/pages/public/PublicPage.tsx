import type { ReactNode } from 'react';
import { Brand, button, cn, useCopy } from '@adminforge/ui';
import { ACTION_LABEL, actionHref, problemCopy, type ProblemAction } from './sign-in-problems';

/** Pages that render without a session (the shell would otherwise send the browser straight back to sign-in). */
export const PUBLIC_PATHS = new Set(['/signed-out', '/sign-in-problem']);

function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-canvas p-6">
      <Brand size="lg" />
      <section className="w-full max-w-xl rounded-lg border border-line bg-panel p-6 shadow-sm sm:p-8">
        {children}
      </section>
    </main>
  );
}

function ActionLink({ action, primary }: { action: ProblemAction; primary?: boolean }) {
  return (
    <a href={actionHref(action)} className={button({ intent: primary ? 'primary' : 'secondary' })}>
      {ACTION_LABEL[action]}
    </a>
  );
}

/** After sign-out: never auto-redirect to sign-in (SSO would sign the person straight back in). */
export function SignedOutPage() {
  return (
    <PublicLayout>
      <h1 className="font-display text-xl font-semibold text-fg">You’re signed out</h1>
      <p className="mt-3 text-fg-2">
        Your AdminForge session has ended and write access is off. On a shared computer, close the browser as
        well.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <ActionLink action="sign-in" primary />
        <ActionLink action="choose-account" />
      </div>
    </PublicLayout>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-x-4">
      <dt className="w-28 shrink-0 text-fg-3">{label}</dt>
      <dd className="min-w-0 flex-1 font-mono text-xs break-all">{value}</dd>
    </div>
  );
}

export interface ProblemSearch {
  code?: string;
  ref?: string;
  during?: 'arm' | 'download';
  detail?: string;
}

const SAFE = /^[A-Za-z0-9_-]{1,64}$/;

/** Only short identifiers are accepted from the URL; the copy itself never comes from the query string. */
export function validateProblemSearch(search: Record<string, unknown>): ProblemSearch {
  const pick = (v: unknown) => (typeof v === 'string' && SAFE.test(v) ? v : undefined);
  return {
    code: pick(search.code),
    ref: pick(search.ref),
    during: search.during === 'arm' || search.during === 'download' ? search.during : undefined,
    detail: pick(search.detail),
  };
}

/** A failed sign-in or write-access verification, explained (the API redirects here instead of showing JSON). */
export function SignInProblemPage({ search, now = new Date() }: { search: ProblemSearch; now?: Date }) {
  const during = search.during ?? 'sign-in';
  const copy = problemCopy(search.code, during);
  const [copied, copyText] = useCopy();
  const details = [
    `What happened: ${copy.title}`,
    search.code && `Error code: ${search.code}`,
    search.detail && `Microsoft code: ${search.detail}`,
    search.ref && `Reference: ${search.ref}`,
    `Time: ${now.toISOString()}`,
    `Address: ${window.location.origin}`,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <PublicLayout>
      <p className="text-xs font-semibold tracking-wide text-fg-3 uppercase">
        {during === 'arm' ? 'Write access' : during === 'download' ? 'Report download' : 'Sign-in'}
      </p>
      <h1 className="mt-1 font-display text-xl font-semibold text-fg">{copy.title}</h1>
      <p className="mt-3 text-fg-2">{copy.body}</p>
      <p className="mt-3 text-fg">{copy.next}</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <ActionLink action={copy.primary} primary />
        {copy.secondary && <ActionLink action={copy.secondary} />}
      </div>

      <details className="mt-6 border-t border-line pt-4 text-sm">
        <summary className="cursor-pointer text-fg-2 select-none">Details for your administrator</summary>
        <dl className="mt-3 flex flex-col gap-2 text-fg-2">
          {search.code && <DetailRow label="Error code" value={search.code} />}
          {search.detail && <DetailRow label="Microsoft code" value={search.detail} />}
          {search.ref && <DetailRow label="Reference" value={search.ref} />}
          <DetailRow label="Time" value={now.toISOString()} />
        </dl>
        {copy.admin && <p className="mt-3 text-fg-2">{copy.admin}</p>}
        <button
          type="button"
          className={cn(button({ intent: 'ghost', size: 'sm' }), 'mt-3')}
          onClick={() => void copyText(details)}
        >
          {copied ? 'Copied' : 'Copy details'}
        </button>
      </details>
    </PublicLayout>
  );
}
