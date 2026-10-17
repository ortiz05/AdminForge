import { act, renderHook, waitFor } from '@testing-library/react';
import { useWhen } from '@adminforge/widgets';

// A page block's `when` (`sticky`) keeps its last decision while a new scope re-evaluates: flipping to "unknown"
// unmounted visible blocks (focus, scroll and table state lost; focus return from the inspector landed on <body>).
// Actions are not sticky: a button gated on the current selection is never offered on an older answer.
describe('useWhen', () => {
  // A function call keeps the template off the synchronous fast path, like real conditions that use functions.
  const when = '${ $count(items) > 0 }';

  it('sticky: undefined only until the first answer, then keeps it while a new scope evaluates', async () => {
    const { result, rerender } = renderHook(({ scope }) => useWhen(when, scope, { sticky: true }), {
      initialProps: { scope: { items: [1] } as Record<string, unknown> },
    });
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(true));
    const seen: Array<boolean | undefined> = [];
    act(() => rerender({ scope: { items: [1, 2] } }));
    seen.push(result.current);
    await waitFor(() => expect(result.current).toBe(true));
    expect(seen).toEqual([true]);
  });

  it('follows a changed answer once it is known', async () => {
    const { result, rerender } = renderHook(({ scope }) => useWhen(when, scope), {
      initialProps: { scope: { items: [1] } as Record<string, unknown> },
    });
    await waitFor(() => expect(result.current).toBe(true));
    act(() => rerender({ scope: { items: [] } }));
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('not sticky (actions): unknown again while a new scope evaluates, then the new answer', async () => {
    const { result, rerender } = renderHook(({ scope }) => useWhen(when, scope), {
      initialProps: { scope: { items: [1] } as Record<string, unknown> },
    });
    await waitFor(() => expect(result.current).toBe(true));
    act(() => rerender({ scope: { items: [] } }));
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('absent `when` is shown at once', () => {
    const { result } = renderHook(() => useWhen(undefined, {}));
    expect(result.current).toBe(true);
  });
});
