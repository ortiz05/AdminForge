import { requiresText } from '@adminforge/web/src/app/NavRail';
import { featureKeyFor, type Capabilities, type PageDefinition } from '@adminforge/web/src/renderer/api';
import { licenceState } from '@adminforge/web/src/renderer/page-model';

// An Office 365 E5 tenant: `defender` (Defender for Office 365 Plan 2) is licensed, `defenderEndpoint` is not. Content
// that needs Defender for Endpoint must be gated even when it names a plan (WINDEFATP) that the broader `defender`
// feature also lists.

const OFFICE_E5: Capabilities = {
  features: {
    defender: {
      available: true,
      label: 'Microsoft Defender (incidents and alerts)',
      sku: 'O365_E5',
      servicePlans: ['MTP', 'WINDEFATP', 'MDE_LITE', 'MDE_SMB', 'ATP_ENTERPRISE', 'THREAT_INTELLIGENCE'],
    },
    defenderEndpoint: {
      available: false,
      label: 'Microsoft Defender for Endpoint (device data)',
      sku: 'WINDEFATP',
      reason: 'Requires Microsoft Defender for Endpoint Plan 2 (WINDEFATP)',
      servicePlans: ['WINDEFATP', 'TVM_PREMIUM_1'],
    },
  },
};
const page = (licences: string[]) =>
  ({ kind: 'page', id: 'security.x', title: 'X', requires: { licences } }) as unknown as PageDefinition;

describe('Defender for Endpoint gating on an Office 365 E5 tenant', () => {
  it('resolves a service plan to the most specific feature that lists it', () => {
    expect(featureKeyFor('WINDEFATP', OFFICE_E5)).toBe('defenderEndpoint');
    expect(featureKeyFor('tvm_premium_1', OFFICE_E5)).toBe('defenderEndpoint');
    expect(featureKeyFor('THREAT_INTELLIGENCE', OFFICE_E5)).toBe('defender');
    expect(featureKeyFor('defenderEndpoint', OFFICE_E5)).toBe('defenderEndpoint');
  });

  it('gates device data and leaves incidents and alerts open', () => {
    expect(licenceState(page(['defenderEndpoint']), OFFICE_E5).missing.map((m) => m.key)).toEqual([
      'defenderEndpoint',
    ]);
    expect(licenceState(page(['WINDEFATP', 'TVM_PREMIUM_1']), OFFICE_E5).missing.length).toBe(2);
    expect(licenceState(page(['defender']), OFFICE_E5).missing).toEqual([]);
  });

  it('names the licence briefly in navigation badges', () => {
    expect(requiresText('Requires Microsoft Defender for Endpoint Plan 2 (WINDEFATP)')).toBe(
      'Defender for Endpoint',
    );
    expect(
      requiresText(
        'Requires Microsoft Defender XDR (MTP), Defender for Office 365 (THREAT_INTELLIGENCE) or Defender for Endpoint (WINDEFATP)',
      ),
    ).toBe('Defender');
    expect(requiresText('Requires Microsoft Intune Plan 1 (INTUNE_A)')).toBe('Intune');
    expect(requiresText('Requires Exchange Online (EXCHANGE_S_STANDARD or EXCHANGE_S_ENTERPRISE)')).toBe(
      'Exchange',
    );
  });
});
