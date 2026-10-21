import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  ShieldStarIcon,
  Tooltip,
} from '@adminforge/ui';
import { capabilitiesQuery } from '../playbooks/contracts';
import { playbookSearch } from '../playbooks/url';
import { ApiRequestError } from '../lib/api';

/** The in-portal activation playbook (content: identity.pim-activate). */
export const PIM_ACTIVATE_PLAYBOOK = 'identity.pim-activate';

type SearchPatch = Record<string, unknown>;

/**
 * Privileged roles in the session rail: how many Entra roles are active and eligible for you right now, and a menu that
 * opens the activation playbook for an eligible role. Hidden detail when PIM can't be read (no licence or permission).
 * Below `xl` only the word shows, so the session rail fits a phone and jump-to keeps its room on a small laptop. The
 * name starts with that word (label in name, WCAG 2.5.3).
 */
export function PimIndicator({ className }: { className?: string }) {
  const caps = useQuery(capabilitiesQuery);
  const navigate = useNavigate();
  const active = caps.data?.active ?? null;
  const eligible = caps.data?.eligible ?? null;

  if (caps.isPending || active === null || eligible === null) {
    const signIn = caps.error instanceof ApiRequestError && caps.error.status === 401;
    const why = caps.isPending
      ? 'Checking your privileged roles…'
      : signIn
        ? 'Privileged roles can’t be read until you sign in again.'
        : 'Privileged roles can’t be read: PIM needs Microsoft Entra ID P2 and permission to read role schedules.';
    return (
      <Tooltip content={why} side="bottom">
        <button
          type="button"
          className={className}
          aria-label={`PIM (privileged roles): ${why}`}
          aria-disabled
        >
          <ShieldStarIcon size={15} aria-hidden className="max-xl:hidden" />
          PIM
        </button>
      </Tooltip>
    );
  }

  const activate = (roleDefinitionId: string) =>
    void navigate({
      to: '.',
      search: ((prev: SearchPatch) => ({
        ...prev,
        ...playbookSearch({ playbook: PIM_ACTIVATE_PLAYBOOK, inputs: { roleDefinitionId } }),
      })) as never,
    });

  const summary = `${active.length} active · ${eligible.length} eligible`;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className={className} aria-label={`PIM (privileged roles): ${summary}`}>
          {/* Below `xl` the word only; the menu lists the roles and the name gives the counts. */}
          <ShieldStarIcon size={15} aria-hidden className="max-xl:hidden" />
          <span>PIM</span>
          <span className="font-mono tabular-nums max-xl:hidden">
            {active.length}·{eligible.length}
          </span>
        </button>
      </MenuTrigger>
      <MenuContent className="w-72">
        <MenuLabel>Active roles</MenuLabel>
        {active.length ? (
          active.map((r) => (
            <MenuItem key={`a-${r.roleDefinitionId}`} disabled>
              {r.displayName}
            </MenuItem>
          ))
        ) : (
          <p className="px-2 pb-2 text-sm text-fg-3">None active right now.</p>
        )}
        <MenuSeparator />
        <MenuLabel>Eligible — select to activate</MenuLabel>
        {eligible.length ? (
          eligible.map((r) => (
            <MenuItem key={`e-${r.roleDefinitionId}`} onSelect={() => activate(r.roleDefinitionId)}>
              {r.displayName}
            </MenuItem>
          ))
        ) : (
          <p className="px-2 pb-2 text-sm text-fg-3">No eligible roles.</p>
        )}
      </MenuContent>
    </Menu>
  );
}
