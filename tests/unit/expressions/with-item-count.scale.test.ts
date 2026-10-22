import { evaluate } from '@adminforge/expressions';

// The Groups page's member views count every group's expanded members (Graph expands at most 20): 50,000 groups,
// counted and filtered natively, within the 250 ms budget. `scale` project, one file at a time.
describe('$withItemCount at scale', () => {
  it(
    '50,000 groups with up to 20 members: count and filter within the 250 ms budget',
    { retry: 2 },
    async () => {
      const groups = Array.from({ length: 50_000 }, (_, i) => ({
        id: `g${i}`,
        members: Array.from({ length: i % 21 }, (_, j) => ({ id: `u${j}` })),
      }));
      const lt5 = { join: 'and', clauses: [{ path: 'memberCount', type: 'number', op: 'lt', value: 5 }] };
      const t0 = performance.now();
      const n = await evaluate('$count($applyAdvanced($withItemCount(rows, "members", "memberCount"), f))', {
        rows: groups,
        f: lt5,
      });
      expect(performance.now() - t0).toBeLessThan(250);
      // 0–4 members: 5 of every 21 groups.
      expect(n).toBe(groups.filter((g) => g.members.length < 5).length);
    },
  );
});
