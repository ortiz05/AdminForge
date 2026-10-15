import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouteError } from '@adminforge/web/src/app/RouteError';
import { ApiRequestError } from '@adminforge/web/src/lib/api';

// The router's default error component: designed panel, plain words, a next step and a reference — never a stack.
describe('RouteError', () => {
  it('a rendering crash shows a reference (also logged) and Try again, not the error text', async () => {
    const reset = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <RouteError error={new TypeError("Cannot read properties of undefined (reading 'x')")} reset={reset} />,
    );
    expect(screen.getByText('This page hit a problem')).toBeInTheDocument();
    expect(screen.queryByText(/Cannot read properties/)).toBeNull();
    const ref = String(log.mock.calls[0]?.[0]).match(/reference ([0-9a-f-]{36})/)?.[1];
    expect(ref).toBeTruthy();
    expect(screen.getByRole('button', { name: `Copy Reference ${ref}` })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalled();
    log.mockRestore();
  });

  it('an API failure shows its message, next step and the server reference', () => {
    render(
      <RouteError
        error={
          new ApiRequestError(
            403,
            'forbidden',
            'Audit needs the Portal.Admin role.',
            'Ask a portal administrator…',
            'abc-123',
          )
        }
        reset={() => {}}
      />,
    );
    expect(screen.getByText('You don’t have access to this page')).toBeInTheDocument();
    expect(screen.getByText('Audit needs the Portal.Admin role.')).toBeInTheDocument();
    expect(screen.getByText('Ask a portal administrator…')).toBeInTheDocument();
  });
});
