import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CodeBlock, IdChip } from '@adminforge/ui';
import { axeViolations } from '../axe';

const GUID = '3f2a8c71-5d0e-4b6a-9e1f-0c4d2b7a9c1d';

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

describe('IdChip', () => {
  it('shows head…tail with the full value in the title', async () => {
    const { container } = render(<IdChip value={GUID} label="Object ID" />);
    const code = screen.getByText('3f2a…9c1d');
    expect(code.tagName).toBe('CODE');
    expect(code).toHaveAttribute('title', GUID);
    expect(screen.getByText('Object ID')).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('copies the full value from a button named "Copy <label> <value>"', async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    render(<IdChip value={GUID} label="Object ID" />);
    const copy = screen.getByRole('button', { name: `Copy Object ID ${GUID}` });
    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith(GUID);
    expect(await screen.findByText('Object ID copied')).toBeInTheDocument();
  });

  it('copies from the keyboard', async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    render(<IdChip value={GUID} />);
    await user.tab();
    expect(screen.getByRole('button', { name: `Copy value ${GUID}` })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(writeText).toHaveBeenCalledWith(GUID);
  });

  it('can show the full value and hide the label visually', () => {
    render(<IdChip value={GUID} label="Tenant ID" showLabel={false} full />);
    expect(screen.getByText(GUID)).toBeInTheDocument();
    expect(screen.queryByText('Tenant ID')).toBeNull();
    expect(screen.getByRole('button', { name: `Copy Tenant ID ${GUID}` })).toBeInTheDocument();
  });

  it('does not shorten short values', () => {
    render(<IdChip value="abc123" />);
    expect(screen.getByText('abc123')).toBeInTheDocument();
  });
});

describe('CodeBlock', () => {
  const KQL = 'SigninLogs\n| where ResultType != 0\n| take 20';

  it('renders a labelled, focusable region with the code', async () => {
    const { container } = render(<CodeBlock title="Failed sign-ins · KQL" language="kql" code={KQL} />);
    const region = screen.getByRole('region', { name: 'Failed sign-ins · KQL' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.textContent).toBe(KQL);
    expect(region.querySelector('code')).toHaveAttribute('data-language', 'kql');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('copies the code', async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    render(<CodeBlock language="kql" code={KQL} />);
    await user.click(screen.getByRole('button', { name: 'Copy kql' }));
    expect(writeText).toHaveBeenCalledWith(KQL);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });
});
