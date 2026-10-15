import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  FIXTURE_NOW,
  LicenceGatePanel,
  WIDGETS,
  licenceGateFixtures,
  probeStatusFixtures,
  type LicenceGateConfig,
  type ProbeStatusConfig,
  type ProbesState,
} from '@adminforge/widgets';
import { axeViolations } from '../axe';
import { ready, renderWidget, spyRuntime } from './helpers';

const Gate = WIDGETS.licenceGate!.component;
const Probes = WIDGETS.probeStatus!.component;
const gateConfig = WIDGETS.licenceGate!.schema.parse(licenceGateFixtures.intune.config) as LicenceGateConfig;
const probeConfig = WIDGETS.probeStatus!.schema.parse(probeStatusFixtures.reachability.config) as ProbeStatusConfig;

describe('licenceGate widget', () => {
  it('renders nothing when the feature is licensed or its state is unknown', () => {
    const licensed = spyRuntime({ feature: () => ({ available: true, label: 'Microsoft Intune' }) });
    const a = renderWidget(Gate, gateConfig, ready(undefined), licensed.runtime);
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    const unknown = spyRuntime({ feature: () => ({ available: null, label: 'Microsoft Intune' }) });
    const b = renderWidget(Gate, gateConfig, ready(undefined), unknown.runtime);
    expect(b.container).toBeEmptyDOMElement();
    b.unmount();
    const missing = spyRuntime({ feature: () => undefined });
    expect(renderWidget(Gate, gateConfig, ready(undefined), missing.runtime).container).toBeEmptyDOMElement();
  });

  it('explains what is missing, with the SKU, when the feature is unavailable', async () => {
    const { runtime } = spyRuntime({ feature: () => licenceGateFixtures.intune.feature });
    const { container } = renderWidget(Gate, gateConfig, ready(undefined), runtime);
    const gate = screen.getByRole('region', { name: 'Microsoft Intune isn’t licensed in this tenant' });
    expect(gate).toHaveTextContent('Requires a licence');
    expect(gate).toHaveTextContent('This page shows managed devices and their compliance.');
    expect(gate).toHaveTextContent('Microsoft Intune Plan 1 (INTUNE_A)');
    expect(gate).toHaveTextContent('Ask your licensing admin');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('in mock mode it becomes a “Preview with sample data” banner', async () => {
    const { runtime } = spyRuntime({ feature: () => licenceGateFixtures.intune.feature, dataMode: 'fixtures' });
    const { container } = renderWidget(Gate, gateConfig, ready(undefined), runtime);
    const note = screen.getByRole('note', { name: 'Preview with sample data' });
    expect(note).toHaveTextContent('Microsoft Intune isn’t licensed in this tenant, so this page shows synthetic data');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('the panel names several missing features and their reasons', () => {
    const { container } = renderWidget(
      () => (
        <LicenceGatePanel
          missing={[
            { key: 'pim', state: { available: false, label: 'Privileged Identity Management', reason: 'No P2 plan is assigned.' } },
            { key: 'identityProtection' },
          ]}
        />
      ),
      null,
      ready(undefined),
    );
    expect(container).toHaveTextContent('Privileged Identity Management and Identity Protection aren’t licensed in this tenant');
    expect(container).toHaveTextContent('No P2 plan is assigned.');
    expect(container).toHaveTextContent('Microsoft Entra ID P2 (AAD_PREMIUM_P2)');
  });
});

describe('probeStatus widget', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: FIXTURE_NOW }));
  afterEach(() => vi.useRealTimers());
  const probes: ProbesState = { status: 'ready', probes: probeStatusFixtures.reachability.probes, provenance: { service: 'scheduler', path: '/probes', ms: 12 } };

  it('one row per probe in the configured order: status words, metric, last run; expands to the message', async () => {
    const user = userEvent.setup();
    const useProbes = vi.fn(() => probes);
    const { runtime } = spyRuntime({ useProbes });
    const { container } = renderWidget(Probes, probeConfig, ready(undefined), runtime);
    expect(useProbes).toHaveBeenCalledWith(probeConfig.probes);
    const list = screen.getByRole('list', { name: 'Reachability' });
    const rows = within(list).getAllByRole('button');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Microsoft Graph reachability'),
      expect.stringContaining('Azure Resource Manager reachability'),
      expect.stringContaining('Token acquisition · Exchange Online'),
    ]);
    expect(rows[0]).toHaveTextContent('Passing');
    expect(rows[0]).toHaveTextContent('182 ms');
    expect(rows[0]).toHaveTextContent('12 min ago');
    expect(rows[1]).toHaveTextContent('1.8 s');
    expect(rows[2]).toHaveTextContent('Error');
    expect(screen.getByText('1 failing')).toBeInTheDocument();
    expect(screen.getByText('scheduler')).toBeInTheDocument();
    expect(rows[2]).toHaveAttribute('aria-expanded', 'false');
    await user.click(rows[2]!);
    expect(rows[2]).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/AADSTS7000215: Invalid client secret provided/)).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('loading, error and the empty state', () => {
    const a = renderWidget(Probes, probeConfig, ready(undefined), spyRuntime({ useProbes: () => ({ status: 'loading', probes: [] }) }).runtime);
    expect(screen.getByText('Loading reachability')).toBeInTheDocument();
    a.unmount();
    const b = renderWidget(
      Probes,
      probeConfig,
      ready(undefined),
      spyRuntime({ useProbes: () => ({ status: 'error', probes: [], error: { code: 'not_found', message: 'The scheduler API is not running.' } }) }).runtime,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The scheduler API is not running.');
    b.unmount();
    renderWidget(Probes, probeConfig, ready(undefined), spyRuntime({ useProbes: () => ({ status: 'ready', probes: [] }) }).runtime);
    expect(screen.getByText('No probe results yet')).toBeInTheDocument();
  });
});
