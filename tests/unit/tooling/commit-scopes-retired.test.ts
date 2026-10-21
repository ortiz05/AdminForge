import { checkCommitMessage, SCOPES } from '../../../tooling/git/commit-message.mjs';

// O-13: two vague scopes went. `plan` (docs/plans is `docs`) is retired; `dev` became `tooling` (hooks, CI helpers, the
// lint and git tooling, build and workspace configuration). Only new messages are checked — the commit-msg hook sees
// the message being written and CI the pull request title — so commits already on main keep their old scopes.
describe('retired and renamed commit scopes', () => {
  it.each(['plan', 'dev'])('refuses the retired scope "%s"', (scope) => {
    expect(SCOPES).not.toContain(scope);
    const problems = checkCommitMessage(`docs(${scope}): mark the master plan historical\n`);
    expect(problems.join(' ')).toContain(`Unknown scope "${scope}"`);
    expect(
      checkCommitMessage(`docs(${scope}): mark the master plan historical`, { title: true }),
    ).not.toEqual([]);
  });

  it('accepts "tooling", alone and with other scopes', () => {
    expect(SCOPES).toContain('tooling');
    expect(checkCommitMessage('build(tooling): typecheck without building first\n')).toEqual([]);
    expect(
      checkCommitMessage('fix(tooling,deps): wait seven days for new versions', { title: true }),
    ).toEqual([]);
  });
});
