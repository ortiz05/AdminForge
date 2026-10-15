import type { ActionBarConfig } from './schema';

/** Story data for the actionBar widget. */
export const actionBarFixtures = {
  user: {
    config: {
      widget: 'actionBar',
      actions: [
        {
          playbook: 'identity.disable-user',
          label: 'Disable sign-in',
          icon: 'prohibit',
          inputs: { userId: '${ params.id }' },
        },
        {
          playbook: 'identity.reset-mfa',
          label: 'Reset MFA',
          inputs: { userId: '${ params.id }' },
          when: '${ user.accountEnabled = true }',
        },
        { href: 'https://entra.microsoft.com/', label: 'Open in Entra admin center', external: true },
      ],
    } satisfies ActionBarConfig,
  },
};
