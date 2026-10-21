import { render, screen } from '@testing-library/react';
import { ProvenanceFooter } from '@adminforge/ui';

// Design review L13 (2026-10-21): on a phone the provenance line of a Graph beta chart ("preview API graph · /reports/…
// · 14 ms · cached 51 s ago") was wider than its panel and widened the whole page to 427 px. The line stays one line
// and never pushes past its container: the path is cut off first (it takes no room until the rest is placed), the
// request time is left out on a phone (it is in the hover text), and a part that still doesn't fit drops to a second
// line that the footer's fixed height hides.

const footer = () => screen.getByText('Data source:').parentElement!;

describe('ProvenanceFooter in a narrow panel', () => {
  it('stays one line inside its own box instead of widening the page', () => {
    render(
      <ProvenanceFooter
        service="graph"
        path="/reports/getOffice365ActiveUserCounts(period='D30')"
        ms={14}
        preview
      />,
    );
    expect(footer()).toHaveClass('h-4', 'min-w-0', 'flex-wrap', 'overflow-hidden');
  });

  it('cuts the path first and leaves the request time out on a phone, keeping it in the hover text', () => {
    render(
      <ProvenanceFooter
        service="graph"
        path="/admin/serviceAnnouncement/healthOverviews"
        ms={1200}
        cachedAt="2026-10-21T08:00:00Z"
      />,
    );
    expect(screen.getByText('/admin/serviceAnnouncement/healthOverviews').closest('span')).toHaveClass(
      'min-w-0',
      'basis-0',
      'grow',
      'max-w-max',
      'truncate',
    );
    expect(screen.getByText('1.2 s').closest('span')).toHaveClass('max-sm:hidden');
    expect(footer().title).toMatch(/Took 1\.2 s/);
  });
});
