import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { me } from '../../support/web/fixtures/session';
import { reportsApi } from '../../support/web/mock-reports';
import { axeViolations } from '../axe';
import { renderApp } from './automation/render';

// What a sighted person reads: the form also announces its state in a screen-reader-only live region, 500 ms after
// typing stops, and on a busy machine that announcement lands before these assertions run.
const VISIBLE_ONLY = 'script, style, [role="status"].sr-only';

// Schedule times in plain English: the schedule editor and the report schedule form take a sentence ("Type it in
// English"), echo what they understood, name what they didn't, move a typed zone into the time zone field, offer every
// IANA zone through a searchable field, and show the next runs the API worked out (POST /api/schedules/preview).
// Component tests run as en-US, so times show the 12-hour clock.

const definitions = ({ method, path }: { method: string; path: string }) =>
  method === 'GET' && path === '/api/definitions'
    ? { body: { items: [{ kind: 'report', key: 'identity.inactive-guests', title: 'Inactive guests' }] } }
    : method === 'POST' && path === '/api/schedules/scaffold'
      ? {
          body: {
            yaml: 'kind: schedule\n',
            path: 'portal/content/schedules/reports/monthly-guests.schedule.yaml',
            key: 'reports.monthly-guests',
          },
        }
      : undefined;

async function openEditor() {
  const app = renderApp({ path: '/schedules/new', handlers: [definitions] });
  expect(await screen.findByRole('heading', { name: 'New schedule' })).toBeInTheDocument();
  return app;
}

async function chooseRepeats(name: string | RegExp) {
  await userEvent.click(screen.getByRole('combobox', { name: 'Repeats' }));
  await userEvent.click(await screen.findByRole('option', { name }));
}

describe('schedule editor: English', () => {
  beforeEach(() => __resetPrefsForTests());

  it(
    'understands a sentence, echoes it, previews the next five runs and sends `every` without a zone',
    { timeout: 30_000 },
    async () => {
      const { calls } = await openEditor();
      await chooseRepeats(/Type it in English/);
      const box = screen.getByRole('textbox', { name: 'When it runs, in English' });
      // It starts from what the builder had (every Monday at 06:00).
      expect(box).toHaveValue('every Monday at 6:00 am');
      await userEvent.clear(box);
      await userEvent.type(box, 'first Monday of the month at 8:30');
      expect(
        await screen.findByText('Understood: On the first Monday of every month at 8:30 am UTC'),
      ).toBeInTheDocument();
      const preview = screen.getByRole('region', { name: 'When it runs' });
      expect(
        await within(preview).findByText('On the first Monday of every month at 8:30 am UTC'),
      ).toBeInTheDocument();
      // The next five runs come from the API's preview.
      await waitFor(() =>
        expect(
          calls.some(
            (c) =>
              c.url === '/api/schedules/preview' && (c.body as { cron?: string }).cron === '30 8 * * 1#1',
          ),
        ).toBe(true),
      );
      await waitFor(() => expect(within(preview).getAllByRole('listitem')).toHaveLength(6));
      // Screen readers hear it once typing pauses (a visually hidden status, debounced).
      await waitFor(() =>
        expect(
          screen
            .getAllByRole('status')
            .some((s) => s.textContent === 'Understood: On the first Monday of every month at 8:30 am UTC'),
        ).toBe(true),
      );

      await userEvent.type(screen.getByLabelText('Title'), 'Monthly guests');
      await userEvent.click(screen.getByRole('combobox', { name: 'Report' }));
      await userEvent.click(await screen.findByRole('option', { name: /Inactive guests/ }));
      await userEvent.click(screen.getByRole('button', { name: 'Create YAML' }));
      await waitFor(() => expect(calls.some((c) => c.url === '/api/schedules/scaffold')).toBe(true));
      const sent = calls.find((c) => c.url === '/api/schedules/scaffold')!.body as Record<string, unknown>;
      expect(sent).toMatchObject({ every: 'On the first Monday of every month at 08:30', timezone: 'UTC' });
      expect(sent).not.toHaveProperty('cron');
      expect(await axeViolations()).toEqual([]);
    },
  );

  it(
    'names the word it didn’t understand once, on the field; the preview only points at it',
    { timeout: 30_000 },
    async () => {
      await openEditor();
      await chooseRepeats(/Type it in English/);
      const box = screen.getByRole('textbox', { name: 'When it runs, in English' });
      await userEvent.clear(box);
      expect(screen.getByText('Type when it should run, above.')).toBeInTheDocument();
      await userEvent.type(box, 'every tuesdy at 7');
      expect(await screen.findAllByText(/Didn’t understand “tuesdy”/, { ignore: VISIBLE_ONLY })).toHaveLength(
        1,
      );
      expect(box).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText('Fix the sentence above to see when it runs.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Create YAML/ })).toHaveAttribute('aria-disabled', 'true');
      expect(await axeViolations()).toEqual([]);
    },
  );

  it(
    'a zone typed at the end moves into the time zone field, and another zone takes it off the sentence',
    { timeout: 30_000 },
    async () => {
      await openEditor();
      await chooseRepeats(/Type it in English/);
      const box = screen.getByRole('textbox', { name: 'When it runs, in English' });
      await userEvent.clear(box);
      await userEvent.type(box, 'every weekday at 7:00 am Europe/London');
      const zone = screen.getByRole('combobox', { name: 'Time zone' });
      await waitFor(() => expect(zone).toHaveValue('Europe/London'));
      expect(
        await screen.findByText('Understood: Every weekday (Mon–Fri) at 7:00 am Europe/London'),
      ).toBeInTheDocument();
      await userEvent.click(zone);
      await userEvent.keyboard('kolk{Enter}');
      await waitFor(() => expect(zone).toHaveValue('Asia/Kolkata'));
      await waitFor(() => expect(box).toHaveValue('every weekday at 7:00 am'));
    },
  );
});

describe('schedule editor: builder', () => {
  beforeEach(() => __resetPrefsForTests());

  it(
    'weekly on several days, none (a problem, not Monday), and Monthly by weekday',
    { timeout: 30_000 },
    async () => {
      await openEditor();
      const preview = screen.getByRole('region', { name: 'When it runs' });
      await userEvent.click(screen.getByRole('checkbox', { name: 'Wednesday' }));
      await userEvent.click(screen.getByRole('checkbox', { name: 'Friday' }));
      expect(
        await within(preview).findByText('Every Monday, Wednesday and Friday at 6:00 am UTC'),
      ).toBeInTheDocument();
      for (const day of ['Monday', 'Wednesday', 'Friday'])
        await userEvent.click(screen.getByRole('checkbox', { name: day }));
      expect(screen.getByText('Tick at least one day.')).toBeInTheDocument();
      expect(
        within(preview).getByText('Tick at least one day above to see when it runs.'),
      ).toBeInTheDocument();
      await chooseRepeats(/Monthly by weekday/);
      await userEvent.click(screen.getByRole('combobox', { name: 'Which' }));
      await userEvent.click(await screen.findByRole('option', { name: 'Last' }));
      await userEvent.click(screen.getByRole('combobox', { name: 'Day' }));
      await userEvent.click(await screen.findByRole('option', { name: 'Friday' }));
      expect(
        await within(preview).findByText('On the last Friday of every month at 6:00 am UTC'),
      ).toBeInTheDocument();
    },
  );
});

describe('time zone field', () => {
  beforeEach(() => __resetPrefsForTests());

  it(
    'focus keeps and selects the zone; Enter before typing or arrowing doesn’t change it',
    { timeout: 30_000 },
    async () => {
      await openEditor();
      const zone = screen.getByRole('combobox', { name: 'Time zone' }) as HTMLInputElement;
      await userEvent.click(zone);
      expect(zone).toHaveValue('UTC');
      await waitFor(() => expect([zone.selectionStart, zone.selectionEnd]).toEqual([0, 3]));
      // The list opens with the current zone highlighted…
      const list = await screen.findByRole('listbox', { name: 'Time zone choices' });
      expect(within(list).getByRole('option', { selected: true })).toHaveTextContent(/^UTC/);
      expect(screen.getByText('Type a city or region to narrow the list.')).toBeInTheDocument();
      // …and Enter only closes it.
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
      expect(zone).toHaveValue('UTC');
    },
  );

  it(
    'finds any IANA zone by part of its name; arrows keep the highlight in view; Escape keeps the zone',
    { timeout: 30_000 },
    async () => {
      const scrolled = vi.spyOn(window.HTMLElement.prototype, 'scrollIntoView');
      await openEditor();
      const zone = screen.getByRole('combobox', { name: 'Time zone' });
      await userEvent.click(zone);
      await userEvent.keyboard('america');
      const list = await screen.findByRole('listbox', { name: 'Time zone choices' });
      expect(await axeViolations()).toEqual([]);
      scrolled.mockClear();
      await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
      expect(within(list).getAllByRole('option')[3]).toHaveAttribute('aria-selected', 'true');
      expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' });
      await userEvent.clear(zone);
      await userEvent.keyboard('kolk');
      expect(within(list).getByRole('option', { name: /Asia\/Kolkata/ })).toBeInTheDocument();
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(zone).toHaveValue('Asia/Kolkata'));
      // Escape keeps the zone it had.
      await userEvent.click(zone);
      await userEvent.keyboard('zzz');
      expect(await screen.findByText(/No time zone matches “zzz”/)).toBeInTheDocument();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(zone).toHaveValue('Asia/Kolkata'));
      scrolled.mockRestore();
    },
  );
});

describe('report schedule form: English', () => {
  beforeEach(() => __resetPrefsForTests());

  it(
    'refuses English that runs more often than once an hour on the field, before saving',
    { timeout: 30_000 },
    async () => {
      const reports = reportsApi();
      renderApp({
        path: '/reports?report=identity.inactive-guests&schedule=new',
        session: me(),
        handlers: [reports.handler],
      });
      const form = await screen.findByRole('dialog', { name: 'Schedule Inactive guests' });
      await userEvent.click(within(form).getByRole('combobox', { name: 'Repeats' }));
      await userEvent.click(await screen.findByRole('option', { name: /Type it in English/ }));
      const box = within(form).getByRole('textbox', { name: 'When it runs, in English' });
      await userEvent.clear(box);
      await userEvent.type(box, 'every 4 hours at :15');
      expect(await within(form).findByText(/Runs every 4 hours at :15 \(UTC\)/)).toBeInTheDocument();
      // A useful default name, not "…, scheduled".
      expect(within(form).getByRole('textbox', { name: 'Name' })).toHaveValue(
        'Inactive guests, every few hours',
      );
      await userEvent.clear(box);
      await userEvent.type(box, 'every 15 minutes');
      expect(
        await within(form).findByText(
          'Reports run at most once an hour. Try “every hour” or “every 2 hours”.',
        ),
      ).toBeInTheDocument();
      expect(within(form).getByText('Fix the sentence above to see when it runs.')).toBeInTheDocument();
      expect(within(form).queryByText(/^Understood/, { ignore: VISIBLE_ONLY })).not.toBeInTheDocument();
      expect(await axeViolations()).toEqual([]);
    },
  );
});
