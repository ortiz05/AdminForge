import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Invoices: Microsoft.Billing spells the overdue status "OverDue" (older answers "Overdue" or "PastDue") — all count;
// a credit note isn't "the latest invoice"; an Enterprise Agreement enrollment has no invoices API, so it isn't called.
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const page = loaded.definitions.find((d) => d.def.id === 'billing.invoices')!.def as any;
const invoice = (name: string, status: string, due: number, date: string, documentType = 'Invoice') => ({
  id: `/x/${name}`,
  name,
  properties: {
    status,
    documentType,
    invoiceDate: date,
    billedAmount: { value: due + 100, currency: 'EUR' },
    amountDue: { value: due, currency: 'EUR' },
  },
});

describe('billing invoices', () => {
  it('counts every spelling of overdue, and skips credit notes for the latest invoice', async () => {
    const value = {
      value: [
        invoice('A', 'OverDue', 10, '2026-07-05'),
        invoice('B', 'Overdue', 20, '2026-08-05'),
        invoice('C', 'PastDue', 30, '2026-09-05'),
        invoice('D', 'Due', 40, '2026-10-01'),
        invoice('E', 'Paid', 0, '2026-06-05'),
        invoice('F', 'Paid', 0, '2026-10-10', 'CreditNote'),
      ],
    };
    const out = (await renderString(page.datasources.invoices.transform, {
      value,
      params: {},
      env: {},
      now: '2026-10-15T12:00:00Z',
      ds: {},
    })) as Record<string, unknown> & { rows: Array<{ status: string }> };
    expect(out).toMatchObject({ overdue: 3, openAmount: 100, latest: 140 });
    expect(out.rows.map((r) => r.status)).toEqual(['Paid', 'Due', 'OverDue', 'OverDue', 'OverDue', 'Paid']);
  });

  it('does not call the invoices API for an Enterprise Agreement enrollment', async () => {
    const when = page.datasources.invoices.when as string;
    const scope = (agreementType: string) => ({
      ds: {
        account: {
          path: '/providers/Microsoft.Billing/billingAccounts/1',
          isEa: agreementType === 'EnterpriseAgreement',
        },
      },
    });
    expect(await renderString(when, scope('EnterpriseAgreement'))).toBe(false);
    expect(await renderString(when, scope('MicrosoftCustomerAgreement'))).toBe(true);
  });
});
