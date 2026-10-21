import { readdirSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../../lib/repo';
import { read } from './markdown';

// O-08: a plan in docs/plans says what state it is in, right under its title, so nobody (people or Claude Code)
// mistakes a finished or historical plan for work to do. Only a plan still proposed may carry an agent directive
// ("**For Claude:** REQUIRED SUB-SKILL: … implement this plan task-by-task"); once work starts or ends it is struck.
const PLANS = readdirSync(path.join(repoRoot, 'docs/plans'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => `docs/plans/${f}`)
  .sort();

/** `> **Status:** done (2026-10-20). …` within the first lines after the title. */
const STATUS =
  /^> \*\*Status:\*\* (proposed|in progress|done \(\d{4}-\d{2}-\d{2}\)|historical|superseded by [^.\n]+)[.;,( ]/im;
/** An instruction to an agent as a plan's own line (quoted mentions in prose don't count). */
const DIRECTIVE = /^>?\s*\*\*For Claude:\*\*/m;

function status(plan: string): string | undefined {
  const head = read(plan).split('\n').slice(0, 12).join('\n');
  return STATUS.exec(head)?.[1]?.toLowerCase();
}

describe('plans say what state they are in', () => {
  it('finds the plans', () => {
    expect(PLANS.length).toBeGreaterThan(5);
  });

  it.each(PLANS)('%s opens with a status line', (plan) => {
    expect(read(plan).startsWith('# ')).toBe(true);
    expect(
      status(plan),
      'add "> **Status:** proposed | in progress | done (YYYY-MM-DD) | historical"',
    ).toBeDefined();
  });

  it.each(PLANS)('%s carries an agent directive only while proposed', (plan) => {
    if (status(plan) === 'proposed') return;
    expect(
      DIRECTIVE.test(read(plan)),
      'strike the "For Claude" directive of a plan that is no longer proposed',
    ).toBe(false);
  });

  it('reads the status and the directive the way plans write them', () => {
    expect(STATUS.exec('# T\n\n> **Status:** done (2026-10-20). All tasks.')?.[1]).toBe('done (2026-10-20)');
    expect(STATUS.exec('# T\n\n> **Status:** historical. The original plan.')?.[1]).toBe('historical');
    expect(STATUS.exec('# T\n\n> **Status:** in progress (2026-10-21). Implements …')?.[1]).toBe(
      'in progress',
    );
    expect(STATUS.exec('# T\n\n**Status:** done')).toBeNull();
    expect(DIRECTIVE.test('> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans')).toBe(
      true,
    );
    expect(DIRECTIVE.test('reads "**For Claude:** REQUIRED SUB-SKILL: …" under the banner')).toBe(false);
  });
});
