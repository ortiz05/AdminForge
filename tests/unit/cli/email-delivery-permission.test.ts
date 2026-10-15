import { desiredPermissions } from '@adminforge/cli/src/provision/entra-desired';
import { ceilingSettings } from '@adminforge/cli/src/commands/context';

// Email delivery sends as AF_MAIL_SENDER with the automation identity's Mail.Send application permission. Nothing in
// content declares it, so provisioning asks for it when a sender is configured — still behind the write opt-in.
const automationGraph = (env: Record<string, string>) => {
  const { requests, withheld } = desiredPermissions(ceilingSettings(env));
  const granted = requests.automation.filter((r) => r.resource === 'graph').flatMap((r) => r.values);
  return { granted, withheld: withheld.filter((w) => w.app === 'automation').map((w) => w.value) };
};

describe('Mail.Send for email delivery', () => {
  it('is not requested without a sender', () => {
    const { granted, withheld } = automationGraph({});
    expect(granted).not.toContain('Mail.Send');
    expect(withheld).not.toContain('Mail.Send');
  });

  it('is requested for a sender but withheld without the write opt-in', () => {
    const { granted, withheld } = automationGraph({ AF_MAIL_SENDER: 'adminforge@example.com' });
    expect(granted).not.toContain('Mail.Send');
    expect(withheld).toContain('Mail.Send');
  });

  it('is granted for a sender with AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true', () => {
    const { granted } = automationGraph({
      AF_MAIL_SENDER: 'adminforge@example.com',
      AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS: 'true',
    });
    expect(granted).toContain('Mail.Send');
  });
});
