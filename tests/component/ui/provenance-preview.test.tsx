import { render, screen } from '@testing-library/react';
import { ProvenanceFooter } from '@adminforge/ui';

// Graph beta endpoints are flagged where the data is shown, not just in `adminforge validate`.
describe('ProvenanceFooter: preview APIs', () => {
  it('flags Graph beta data and explains it on hover', () => {
    const { container } = render(<ProvenanceFooter service="graph" path="/reports/{id}" ms={120} preview />);
    expect(screen.getByText('preview API')).toBeInTheDocument();
    expect(container.querySelector('p')!.title).toMatch(/beta.*can change without notice/);
  });

  it('shows nothing extra for v1.0 data', () => {
    render(<ProvenanceFooter service="graph" path="/users" ms={80} />);
    expect(screen.queryByText('preview API')).toBeNull();
  });
});
