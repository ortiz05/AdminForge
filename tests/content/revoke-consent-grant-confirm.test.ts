import path from 'node:path';
import { renderTemplate } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// F-16: revoking a delegated permission grant is high risk (an admin consent stops the app for every user), so one
// click isn't enough: the person types the app's name, which the plan shows them. The message says which app, which
// API and permissions, and for whom.

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const def = loaded.definitions.find((d) => d.def.id === 'identity.revoke-consent-grant')!.def as any;

const steps = (consentType: 'AllPrincipals' | 'Principal') => ({
  grant: { output: { consentType, scope: 'Mail.Read offline_access' } },
  client: { output: { displayName: 'PDF Converter Online' } },
  resource: { output: { displayName: 'Microsoft Graph' } },
});

describe('identity.revoke-consent-grant confirmation', () => {
  it('is high risk with a typed confirmation of the app name', async () => {
    expect(def.risk).toBe('high');
    expect(def.confirm.type).toBe('typed');
    expect(await renderTemplate(def.confirm.value, { steps: steps('Principal') })).toBe(
      'PDF Converter Online',
    );
  });

  it('says who loses access, and asks for the name to be typed', async () => {
    const all = await renderTemplate<string>(def.confirm.message, { steps: steps('AllPrincipals') });
    expect(all).toBe(
      'Revoke the access of PDF Converter Online to Microsoft Graph (Mail.Read offline_access) for every user in the ' +
        'tenant? Features that use these permissions stop working for everyone. Type the app name to confirm.',
    );
    const one = await renderTemplate<string>(def.confirm.message, { steps: steps('Principal') });
    expect(one).toBe(
      'Revoke the access of PDF Converter Online to Microsoft Graph (Mail.Read offline_access) for this user? ' +
        'Type the app name to confirm.',
    );
  });

  it('tests its refusals of AdminForge’s own and protected apps', () => {
    const refusals = (
      def.tests as Array<{ env?: Record<string, string>; expect: { failedStep?: string } }>
    ).filter((t) => t.expect.failedStep === 'notPortalApp');
    expect(refusals.map((t) => Object.keys(t.env ?? {}))).toEqual([
      ['AF_READ_CLIENT_ID'],
      ['AF_PROTECTED_APP_IDS'],
    ]);
  });
});
