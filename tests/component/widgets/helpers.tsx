import { render } from '@testing-library/react';
import type { ComponentType } from 'react';
import {
  createWidgetRuntime,
  type WidgetData,
  type WidgetProps,
  type WidgetRuntime,
} from '@adminforge/widgets';

/** Ready data with a provenance line (`graph · /users · …`). */
export function ready(value: unknown, extra: Partial<WidgetData> = {}): WidgetData {
  return { status: 'ready', value, provenance: { service: 'graph', path: '/users', ms: 184 }, ...extra };
}

export const loading: WidgetData = { status: 'loading', value: undefined };

export function failed(retry = vi.fn()): WidgetData {
  return {
    status: 'error',
    value: undefined,
    error: {
      code: 'forbidden',
      message: 'Microsoft Graph refused this request (403).',
      hint: 'Activate Global Reader in PIM, or ask a Portal Admin.',
      correlationId: '5f0c2e81-7a4d-4b39-8c6e-1d2f3a4b5c6d',
    },
    retry,
  };
}

/** A runtime whose actions are spies. */
export function spyRuntime(overrides: Partial<WidgetRuntime> & { data?: Record<string, unknown> } = {}) {
  const openPlaybook = vi.fn();
  const inspect = vi.fn();
  const navigate = vi.fn();
  const runtime = createWidgetRuntime({ openPlaybook, inspect, navigate, ...overrides });
  return { runtime, openPlaybook, inspect, navigate };
}

export function renderWidget<C>(
  Component: ComponentType<WidgetProps<C>>,
  config: C,
  data: WidgetData,
  runtime: WidgetRuntime = createWidgetRuntime(),
  extra: Partial<WidgetProps<C>> = {},
) {
  return render(<Component config={config} data={data} runtime={runtime} instanceId="w0" {...extra} />);
}
