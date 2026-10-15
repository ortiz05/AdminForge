import type { MarkdownConfig } from './schema';

/** Story data for the markdown widget, including content that must stay inert. */
export const markdownFixtures = {
  guidance: {
    config: {
      widget: 'markdown',
      title: 'About this page',
      text: [
        '## What you see',
        'Every **member** and *guest* account. Use `Disable sign-in` for leavers.',
        '',
        '- Filter by type and status',
        '- Open a user with Enter',
        '',
        'See the [offboarding runbook](/runbooks/identity.offboarding) or the [Entra docs](https://learn.microsoft.com/entra/).',
      ].join('\n'),
    } satisfies MarkdownConfig,
  },
  hostile: {
    config: {
      widget: 'markdown',
      text: '<img src=x onerror="alert(1)"> [click](javascript:alert(1)) <script>alert(2)</script>',
    } satisfies MarkdownConfig,
  },
};
