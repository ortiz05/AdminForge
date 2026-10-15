import axe from 'axe-core';

/**
 * Runs axe-core and returns readable violations (empty = pass).
 * `color-contrast` needs real layout (covered by Playwright); `region` is a page-level rule.
 * Radix portals render into document.body, so overlays are checked against the whole body.
 */
export async function axeViolations(node: Element = document.body): Promise<string[]> {
  const results = await axe.run(node, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return results.violations.map(
    (v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}
