import { screen, within } from '@testing-library/react';
import { WIDGETS, keyValueFixtures, statusGridFixtures, type KeyValueConfig, type StatusGridConfig } from '@adminforge/widgets';
import { axeViolations } from '../axe';
import { ready, renderWidget } from './helpers';

const KeyValue = WIDGETS.keyValue!.component;
const StatusGrid = WIDGETS.statusGrid!.component;

const term = (name: string) => screen.getByText(name, { selector: 'dt' }).parentElement!;

describe('keyValue widget', () => {
  const config = WIDGETS.keyValue!.schema.parse(keyValueFixtures.user.config) as KeyValueConfig;

  it('label/value pairs with typed values (id chip, status, boolean, datetime)', async () => {
    const { container } = renderWidget(KeyValue, config, ready(keyValueFixtures.user.value));
    expect(term('Sign-in name')).toHaveTextContent('adele.vance@example.com');
    expect(within(term('Object id')).getByRole('button', { name: /Copy Object id/ })).toBeInTheDocument();
    expect(within(term('Sign-in')).getByText('Allowed').closest('[data-status]')).toHaveAttribute('data-status', 'ok');
    expect(term('Synced from on-premises')).toHaveTextContent('No');
    expect(within(term('Created')).getByRole('time')).toHaveTextContent(/UTC/);
    expect(await axeViolations(container)).toEqual([]);
  });

  it('tags from an array or an object (Azure tags), links, and blanks as an em dash', () => {
    const c = WIDGETS.keyValue!.schema.parse({
      widget: 'keyValue',
      data: 'r',
      fields: [
        { field: 'tags', label: 'Tags', kind: 'tags' },
        { field: 'groups', label: 'Groups', kind: 'tags' },
        { field: 'portal', label: 'Portal', kind: 'link' },
        { field: 'missing', label: 'Missing' },
      ],
    }) as KeyValueConfig;
    renderWidget(KeyValue, c, ready({ tags: { env: 'prod', owner: 'ops' }, groups: ['A', 'B'], portal: 'https://portal.azure.com/' }));
    expect(term('Tags')).toHaveTextContent('env: prod');
    expect(term('Tags')).toHaveTextContent('owner: ops');
    expect(term('Groups')).toHaveTextContent('AB');
    expect(within(term('Portal')).getByRole('link')).toHaveAttribute('target', '_blank');
    expect(term('Missing')).toHaveTextContent('—');
  });

  it('an object that no longer exists shows the empty state', () => {
    renderWidget(KeyValue, config, ready(null));
    expect(screen.getByText('No details to show')).toBeInTheDocument();
  });
});

describe('statusGrid widget', () => {
  const config = WIDGETS.statusGrid!.schema.parse(statusGridFixtures.health.config) as StatusGridConfig;

  it('tiles worst first, mapped status words, default for unknown values, and a summary pill', async () => {
    const { container } = renderWidget(StatusGrid, config, ready(statusGridFixtures.health.rows));
    const tiles = within(screen.getByRole('list', { name: 'Service health' })).getAllByRole('listitem');
    expect(tiles[0]).toHaveTextContent('OneDrive for Business');
    expect(tiles[0]).toHaveTextContent('Interrupted');
    expect(tiles[1]).toHaveTextContent('Exchange Online');
    expect(tiles[1]).toHaveTextContent('Degraded');
    expect(tiles[2]).toHaveTextContent('Microsoft Intune');
    expect(tiles[2]).toHaveTextContent('Advisory');
    expect(screen.getByText('2 need attention')).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('all healthy', () => {
    renderWidget(StatusGrid, config, ready([{ service: 'Teams', status: 'serviceOperational' }]));
    expect(screen.getByText('All healthy')).toBeInTheDocument();
  });
});
