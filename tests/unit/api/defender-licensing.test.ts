import { ApiError } from '@adminforge/connectors';
import { featureStates } from '@adminforge/api/src/capabilities/features';
import {
  missingLicences,
  parseSubscribedSkus,
  requiresBadge,
} from '@adminforge/api/src/capabilities/licences';
import {
  DEFENDER_NOT_PROVISIONED,
  errorHint,
  OutboundError,
  outboundAppError,
} from '@adminforge/api/src/execution/outbound';
import { probeFailure } from '@adminforge/api/src/probes/checks';

// Office 365 E5 brings Defender for Office 365 Plan 2 (THREAT_INTELLIGENCE) and the Defender XDR plan (MTP), but no
// Defender for Endpoint: incidents, alerts, advanced hunting on email tables and Secure Score — not device data.
// Plan names as Graph `subscribedSkus` returned them for an Office 365 E5 tenant (2026-10-16, Defender-related subset);
// the SKU part number is a placeholder.

const sku = (skuPartNumber: string, plans: string[]) => ({
  skuPartNumber,
  capabilityStatus: 'Enabled',
  consumedUnits: 1,
  prepaidUnits: { enabled: 1 },
  servicePlans: plans.map((servicePlanName) => ({ servicePlanName, provisioningStatus: 'Success' })),
});
const OFFICE_E5 = parseSubscribedSkus({
  value: [
    sku('O365_E5', [
      'EXCHANGE_S_ENTERPRISE',
      'MTP',
      'THREAT_INTELLIGENCE',
      'ATP_ENTERPRISE',
      'ADALLOM_S_O365',
      'COMMON_DEFENDER_PLATFORM_FOR_OFFICE',
    ]),
  ],
});
const M365_E5 = parseSubscribedSkus({ value: [sku('SPE_E5', ['MTP', 'WINDEFATP', 'THREAT_INTELLIGENCE'])] });
const MDE_P1 = parseSubscribedSkus({ value: [sku('DEFENDER_ENDPOINT_P1', ['MDE_LITE'])] });

const delegated = { kind: 'delegated' as const, mode: 'read' as const };
const automation = { kind: 'automation' as const, mode: 'read' as const };

describe('Defender licence features', () => {
  it('Office 365 E5 has Defender (incidents, alerts, hunting) but not Defender for Endpoint device data', () => {
    const f = featureStates(OFFICE_E5);
    expect(f.defender).toMatchObject({ available: true, sku: 'O365_E5' });
    expect(f.defenderEndpoint).toMatchObject({
      available: false,
      reason: 'Requires Microsoft Defender for Endpoint Plan 2 (WINDEFATP)',
      sku: 'WINDEFATP',
    });
    expect(missingLicences(OFFICE_E5, ['defender'])).toEqual([]);
    expect(missingLicences(OFFICE_E5, ['defenderEndpoint'])).toEqual(['defenderEndpoint']);
    // Plan names in content keep working as before.
    expect(missingLicences(OFFICE_E5, ['WINDEFATP', 'TVM_PREMIUM_1'])).toEqual([
      'WINDEFATP',
      'TVM_PREMIUM_1',
    ]);
    expect(requiresBadge(['defenderEndpoint'])).toBe(
      'Requires Microsoft Defender for Endpoint Plan 2 (WINDEFATP)',
    );
  });

  it('Microsoft 365 E5 has both; Defender for Endpoint Plan 1 has no advanced hunting or vulnerability data', () => {
    expect(featureStates(M365_E5).defenderEndpoint).toMatchObject({ available: true, sku: 'SPE_E5' });
    expect(featureStates(MDE_P1).defender.available).toBe(true);
    expect(featureStates(MDE_P1).defenderEndpoint.available).toBe(false);
  });
});

describe('Defender XDR not set up for the tenant ("Account is not provisioned")', () => {
  const notProvisioned = () =>
    new ApiError(403, 'Unauthorized', 'Unauthorized request - Account is not provisioned.');

  it('says what happened and who can fix it, without claiming a missing licence', () => {
    const h = errorHint(notProvisioned(), 'graph', delegated, { licences: ['defender'] });
    expect(h.licence).toBe(false);
    expect(h.message).toBe(DEFENDER_NOT_PROVISIONED);
    expect(h.hint).toMatch(
      /Global Administrator or Security Administrator opens the Microsoft Defender portal/,
    );
    expect(h.hint).not.toMatch(/licences don't include/);
  });

  it('reaches the browser as the written message (not Microsoft text), and probes as not_configured', () => {
    const base = notProvisioned();
    const h = errorHint(base, 'graph', automation, { licences: ['defender'] });
    const err = new OutboundError(base, 'graph', h.hint, h.licence, undefined, h.message);
    const app = outboundAppError(err);
    expect(app.message).toBe(DEFENDER_NOT_PROVISIONED);
    expect(app.code).not.toBe('licence_required');
    expect(probeFailure(err, 'graph', 20_000, false)).toMatchObject({
      status: 'error',
      code: 'not_configured',
      message: expect.stringContaining(DEFENDER_NOT_PROVISIONED),
    });
  });

  it('leaves real licence errors and filter syntax errors alone', () => {
    expect(
      errorHint(new ApiError(403, 'Forbidden', 'Tenant does not have a SPO license.'), 'graph', delegated)
        .licence,
    ).toBe(true);
    const bad = errorHint(
      new ApiError(400, 'BadRequest', "Invalid filter clause: Could not find a property named 'x'."),
      'graph',
      delegated,
    );
    expect(bad).toMatchObject({ licence: false });
    expect(bad.message).toBeUndefined();
  });
});
