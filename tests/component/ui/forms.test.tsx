import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Checkbox, SegmentedControl, Select, Switch, Textarea, TextField } from '@adminforge/ui';
import { axeViolations } from '../axe';

describe('TextField', () => {
  it('associates label, hint and error, and marks the field invalid', async () => {
    const { container } = render(
      <div>
        <TextField label="Display name" hint="Shown in the global address list." defaultValue="Adele Vance" />
        <TextField
          label="User principal name"
          defaultValue="adele.vance@"
          error="Enter a full address, like name@example.com."
        />
      </div>,
    );
    const name = screen.getByRole('textbox', { name: 'Display name' });
    expect(name).toHaveAccessibleDescription('Shown in the global address list.');
    expect(name).not.toHaveAttribute('aria-invalid');
    const upn = screen.getByRole('textbox', { name: 'User principal name' });
    expect(upn).toHaveAttribute('aria-invalid', 'true');
    expect(upn).toHaveAccessibleDescription('Enter a full address, like name@example.com.');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('types, supports a visually hidden label and leading content', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <TextField
        label="Search users"
        hideLabel
        placeholder="Search users…"
        leading={<svg aria-hidden />}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Search users' });
    expect(screen.getByText('Search users')).toHaveClass('sr-only');
    await user.click(input);
    await user.keyboard('adele');
    expect(input).toHaveValue('adele');
    expect(onChange).toHaveBeenCalledTimes(5);
    expect(await axeViolations(container)).toEqual([]);
  });

  it('marks optional fields with a readable name', () => {
    render(<TextField label="Nickname" optional />);
    expect(screen.getByRole('textbox', { name: 'Nickname (optional)' })).toBeInTheDocument();
  });
});

describe('Textarea', () => {
  it('is labelled, typed into, and reports errors', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Textarea
        label="Reason"
        error="Give a reason of at least 5 characters."
        hint="Recorded in the audit log."
      />,
    );
    const area = screen.getByRole('textbox', { name: 'Reason' });
    expect(area.tagName).toBe('TEXTAREA');
    expect(area).toHaveAttribute('aria-invalid', 'true');
    expect(area).toHaveAccessibleDescription(
      'Give a reason of at least 5 characters. Recorded in the audit log.',
    );
    await user.type(area, 'INC-4821');
    expect(area).toHaveValue('INC-4821');
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('Select', () => {
  const OPTIONS = [
    { value: 'GB', label: 'United Kingdom' },
    { value: 'US', label: 'United States' },
    { value: 'DE', label: 'Germany', description: 'EU data boundary' },
  ];

  function Harness({ onChange }: { onChange: (v: string) => void }) {
    const [value, setValue] = useState('GB');
    return (
      <Select
        label="Usage location"
        hint="Required before assigning licences."
        value={value}
        onValueChange={(v) => {
          setValue(v);
          onChange(v);
        }}
        options={OPTIONS}
      />
    );
  }

  it('is a labelled combobox showing the current value', async () => {
    const { container } = render(<Harness onChange={() => {}} />);
    const combo = screen.getByRole('combobox', { name: 'Usage location' });
    expect(combo).toHaveTextContent('United Kingdom');
    expect(combo).toHaveAccessibleDescription('Required before assigning licences.');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('opens from the keyboard and chooses an option', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const combo = screen.getByRole('combobox', { name: 'Usage location' });
    combo.focus();
    await user.keyboard('{Enter}');
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /United Kingdom/ })).toHaveAttribute('aria-selected', 'true');
    expect(await axeViolations()).toEqual([]);
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('US'));
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(combo).toHaveTextContent('United States');
  });

  it('shows a placeholder when empty', () => {
    render(<Select label="Region" options={OPTIONS} placeholder="Choose a region…" />);
    expect(screen.getByRole('combobox', { name: 'Region' })).toHaveTextContent('Choose a region…');
  });
});

describe('Switch', () => {
  it('toggles with Space and click on its label', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <Switch label="Block sign-in" description="Takes effect within minutes." onCheckedChange={onChange} />,
    );
    const sw = screen.getByRole('switch', { name: 'Block sign-in' });
    expect(sw).toHaveAccessibleDescription('Takes effect within minutes.');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await user.tab();
    await user.keyboard(' ');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(onChange).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByText('Block sign-in'));
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('works without a visible label when given aria-label', async () => {
    const { container } = render(<Switch aria-label="Send summary email" defaultChecked />);
    expect(screen.getByRole('switch', { name: 'Send summary email' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('Checkbox', () => {
  it('toggles from the keyboard and from its label, reporting a boolean', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <Checkbox
        label="Require MFA re-registration"
        description="At next sign-in."
        onCheckedChange={onChange}
      />,
    );
    const box = screen.getByRole('checkbox', { name: 'Require MFA re-registration' });
    expect(box).toHaveAccessibleDescription('At next sign-in.');
    await user.tab();
    await user.keyboard(' ');
    expect(box).toHaveAttribute('aria-checked', 'true');
    expect(onChange).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByText('Require MFA re-registration'));
    expect(box).toHaveAttribute('aria-checked', 'false');
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(await axeViolations(container)).toEqual([]);
  });

  it('indeterminate is announced as mixed', async () => {
    const { container } = render(<Checkbox label="Some groups selected" checked="indeterminate" />);
    expect(screen.getByRole('checkbox', { name: 'Some groups selected' })).toHaveAttribute(
      'aria-checked',
      'mixed',
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it('disabled does not toggle', async () => {
    const user = userEvent.setup();
    render(<Checkbox label="Hide from the address list" disabled />);
    const box = screen.getByRole('checkbox', { name: 'Hide from the address list' });
    await user.click(box);
    expect(box).toHaveAttribute('aria-checked', 'false');
  });

  it('bare checkbox needs and uses aria-label', async () => {
    const { container } = render(<Checkbox aria-label="Select Adele Vance" />);
    expect(screen.getByRole('checkbox', { name: 'Select Adele Vance' })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('SegmentedControl', () => {
  function Harness({ onChange }: { onChange: (v: string) => void }) {
    const [value, setValue] = useState('chart');
    return (
      <SegmentedControl
        aria-label="View"
        value={value}
        onValueChange={(v) => {
          setValue(v);
          onChange(v);
        }}
        options={[
          { value: 'chart', label: 'Chart' },
          { value: 'table', label: 'Table' },
          { value: 'raw', label: 'Raw' },
        ]}
      />
    );
  }

  it('is a labelled radiogroup; arrows move, Space selects', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<Harness onChange={onChange} />);
    expect(screen.getByRole('radiogroup', { name: 'View' })).toBeInTheDocument();
    const chart = screen.getByRole('radio', { name: 'Chart' });
    expect(chart).toHaveAttribute('aria-checked', 'true');
    await user.tab();
    expect(chart).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Table' })).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith('table');
    expect(screen.getByRole('radio', { name: 'Table' })).toHaveAttribute('aria-checked', 'true');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('clicking the selected option does not deselect it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: 'Chart' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Chart' })).toHaveAttribute('aria-checked', 'true');
  });
});
