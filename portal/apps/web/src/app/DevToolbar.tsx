import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PORTAL_ROLES, type MeResponse } from '@adminforge/schemas';
import {
  BugBeetleIcon,
  Button,
  Checkbox,
  Popover,
  PopoverContent,
  PopoverTrigger,
  useToast,
} from '@adminforge/ui';
import { api } from '../lib/api';
import { meQuery } from '../lib/session';

/** Body of POST /auth/mock/state (mock mode only). */
export interface MockState {
  roles?: string[];
  /** Minutes of write access from now; null disarms. */
  armedMinutes?: number | null;
}

/**
 * Mock mode only: switch roles and write access without a tenant. Never rendered when authMode is "entra",
 * and the API refuses /auth/mock/* outside mock mode anyway.
 */
export function DevToolbar({ me }: { me: MeResponse }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  if (me.authMode !== 'mock') return null;

  const send = async (state: MockState) => {
    setPending(true);
    try {
      await api('/auth/mock/state', { method: 'POST', body: state });
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    } catch (e) {
      toast({ tone: 'crit', title: 'Mock state was not changed', description: (e as Error).message });
    } finally {
      setPending(false);
    }
  };

  const toggleRole = (role: string, on: boolean) => {
    const roles = on ? [...new Set([...me.roles, role])] : me.roles.filter((r) => r !== role);
    void send({ roles });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-dashed border-line-strong px-2 text-2xs font-semibold text-fg-3 hover:border-fg-3 hover:text-fg"
        >
          <BugBeetleIcon size={12} aria-hidden />
          Mock session
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-72">
        <div className="flex flex-col gap-3 p-3" aria-busy={pending || undefined}>
          <div>
            <p className="af-eyebrow">Developer toolbar</p>
            <p className="mt-1 text-xs text-fg-3">
              Mock sign-in is on. These switches change your session on the local API only.
            </p>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium text-fg">Portal roles</legend>
            {PORTAL_ROLES.map((role) => (
              <Checkbox
                key={role}
                label={role}
                checked={me.roles.includes(role)}
                disabled={pending}
                onCheckedChange={(on) => toggleRole(role, on)}
              />
            ))}
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-fg">Write access</span>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" disabled={pending} onClick={() => void send({ armedMinutes: 30 })}>
                Arm 30 min
              </Button>
              <Button size="sm" disabled={pending} onClick={() => void send({ armedMinutes: 6 })}>
                Arm 6 min
              </Button>
              <Button
                size="sm"
                intent="ghost"
                disabled={pending || me.mode === 'read'}
                onClick={() => void send({ armedMinutes: null })}
              >
                Disarm
              </Button>
            </div>
            <span className="text-2xs text-fg-3">
              “Arm 6 min” reaches the 5-minute warning a minute later.
            </span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
