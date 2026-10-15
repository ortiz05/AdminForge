import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { Toast as T } from 'radix-ui';
import { STATUS_ICON, type StatusTone } from '../lib/status';
import { toast } from '../recipes/toast';

export interface ToastOptions {
  title: string;
  description?: ReactNode;
  tone?: StatusTone;
  /** One follow-up action, e.g. { label: 'Extend', onClick }. */
  action?: { label: string; onClick: () => void };
  /** Milliseconds; Infinity keeps it until dismissed. */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  open: boolean;
}

interface ToastApi {
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

/** Mount once near the root. Toasts are announced politely ("crit" assertively). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback(
    (id: number) => setItems((all) => all.map((t) => (t.id === id ? { ...t, open: false } : t))),
    [],
  );
  const show = useCallback((options: ToastOptions) => {
    const id = nextId++;
    setItems((all) => [...all.slice(-4), { ...options, id, open: true }]);
    return id;
  }, []);
  const api = useMemo(() => ({ toast: show, dismiss }), [show, dismiss]);
  const s = toast();
  return (
    <ToastContext.Provider value={api}>
      <T.Provider swipeDirection="right" duration={6000} label="Notifications">
        {children}
        {items.map((t) => {
          const tone = t.tone ?? 'neutral';
          const Glyph = STATUS_ICON[tone];
          const c = toast({ tone });
          return (
            <T.Root
              key={t.id}
              open={t.open}
              duration={t.duration}
              type={tone === 'crit' ? 'foreground' : 'background'}
              onOpenChange={(open) => {
                if (!open) {
                  dismiss(t.id);
                  window.setTimeout(() => setItems((all) => all.filter((x) => x.id !== t.id)), 300);
                }
              }}
              className={c.root()}
            >
              <Glyph size={18} weight="fill" aria-hidden className={c.icon()} />
              <div className="min-w-0 flex-1">
                <T.Title className={c.title()}>{t.title}</T.Title>
                {t.description && <T.Description className={c.description()}>{t.description}</T.Description>}
                {t.action && (
                  <T.Action altText={t.action.label} asChild>
                    <button
                      type="button"
                      onClick={t.action.onClick}
                      className="mt-2 inline-flex h-7 items-center rounded-md border border-line-strong bg-panel px-2.5 text-xs font-semibold text-fg hover:bg-hover"
                    >
                      {t.action.label}
                    </button>
                  </T.Action>
                )}
              </div>
              <T.Close aria-label="Dismiss notification" className={c.close()}>
                <XIcon size={14} aria-hidden />
              </T.Close>
            </T.Root>
          );
        })}
        <T.Viewport className={s.viewport()} />
      </T.Provider>
    </ToastContext.Provider>
  );
}

/** `const { toast } = useToast(); toast({ title: 'Sign-in disabled for j.doe@example.com', tone: 'ok' })` */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast() needs a <ToastProvider> above it.');
  return api;
}
