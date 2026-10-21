import { screen } from '@testing-library/react';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { IDS, runbookRunDetail } from '../../support/web/fixtures/automation';
import { FIXED_NOW } from '../../support/web/fixtures/session';
import { axeViolations } from '../axe';
import { renderApp } from './automation/render';

// L14 (design review): "Waiting for … to work through this checklist" was warn-coloured text alone. State is never
// colour alone: the waiting glyph (an hourglass, as in the run's status) sits before the words.

function someoneElsesRun() {
  const d = runbookRunDetail();
  return {
    ...d,
    run: {
      ...d.run,
      access: 'metadata',
      initiatorUpn: 'r.patel@example.com',
      initiatorOid: IDS.rPatel,
      inputs: {},
    },
    tasks: [],
  };
}

describe('runbook: a checklist waiting for someone else', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('says who it waits for with the waiting glyph, not colour alone', async () => {
    renderApp({
      path: `/runbooks/identity.offboard-leaver?run=${IDS.runbookRun}`,
      handlers: [
        ({ method, path }) =>
          method === 'GET' && path === `/api/runs/${IDS.runbookRun}`
            ? { body: someoneElsesRun() }
            : undefined,
      ],
    });
    const text = await screen.findByText('Waiting for r.patel@example.com to work through this checklist.');
    const line = text.closest('p')!;
    expect(line).toHaveClass('text-warn');
    expect(line.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(await axeViolations()).toEqual([]);
  });
});
