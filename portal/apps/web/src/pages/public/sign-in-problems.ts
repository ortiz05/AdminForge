/** What the person can do next from the problem page. */
export type ProblemAction = 'sign-in' | 'choose-account' | 'back';

export interface ProblemCopy {
  title: string;
  /** What happened, from the person's side of the screen. */
  body: string;
  /** What to do about it. */
  next: string;
  /** For the administrator they forward the details to. */
  admin?: string;
  primary: ProblemAction;
  secondary?: ProblemAction;
}

export const ACTION_LABEL: Record<ProblemAction, string> = {
  'sign-in': 'Sign in again',
  'choose-account': 'Use a different account',
  back: 'Back to AdminForge',
};

const STILL_READ_ONLY = 'You’re still signed in with read-only access.';
const REPORT = 'If it keeps happening, send the details below to a portal administrator.';

/** Copy for each failure the API redirects here with (`?code=`). Codes come from portal/apps/api/src/auth. */
const SIGN_IN: Record<string, ProblemCopy> = {
  no_portal_role: {
    title: 'You don’t have access to AdminForge yet',
    body: 'You signed in with Microsoft, but your account isn’t a member of an AdminForge group.',
    next: 'Ask a portal administrator to add you to the AdminForge Reader group (to view) or the Operator group (to make changes). Membership can take a few minutes to apply. Then sign in again.',
    admin:
      'Add the account to SG-AdminForge-<environment>-Portal.Reader or -Portal.Operator. The sign-in is recorded in the audit log under this reference.',
    primary: 'sign-in',
    secondary: 'choose-account',
  },
  guest_account: {
    title: 'Guest accounts can’t use AdminForge',
    body: 'You signed in with an account that is a guest in this organisation.',
    next: 'Sign in with your own account in this organisation.',
    admin:
      'AdminForge refuses accounts that are guests in the tenant (acct claim 1). Members — including a personal Microsoft account that is a member of the tenant — can sign in.',
    primary: 'choose-account',
  },
  wrong_tenant: {
    title: 'That account isn’t part of this organisation',
    body: 'AdminForge only accepts work accounts from the organisation it manages.',
    next: 'Sign in with your work account for this organisation.',
    primary: 'choose-account',
  },
  invalid_token: {
    title: 'Microsoft didn’t identify your account',
    body: 'The sign-in response didn’t include your account details. Guest accounts can’t use AdminForge.',
    next: 'Sign in with your work account for this organisation.',
    primary: 'choose-account',
  },
  consent_required: {
    title: 'AdminForge isn’t approved in your organisation yet',
    body: 'Microsoft Entra needs an administrator to approve AdminForge before anyone can sign in.',
    next: 'Ask a Global Administrator to grant consent, then sign in again.',
    admin:
      'Run `pnpm adminforge provision entra` on the AdminForge host. It grants consent to the AdminForge apps.',
    primary: 'sign-in',
  },
  blocked_by_policy: {
    title: 'Your organisation’s sign-in policy blocked this sign-in',
    body: 'A Conditional Access policy didn’t allow this sign-in, for example because of the device or network you’re using.',
    next: 'Try again from a device and network your organisation allows, or contact your identity team.',
    admin: 'Look up the sign-in in the Entra sign-in logs using the Microsoft error code below.',
    primary: 'sign-in',
  },
  signin_cancelled: {
    title: 'Sign-in was cancelled',
    body: 'The Microsoft sign-in didn’t finish, so you aren’t signed in to AdminForge.',
    next: 'Sign in again when you’re ready.',
    primary: 'sign-in',
    secondary: 'choose-account',
  },
  invalid_state: {
    title: 'This sign-in link has expired',
    body: 'Sign-ins time out after 10 minutes and work only once, in the tab that started them.',
    next: 'Start again from AdminForge.',
    primary: 'sign-in',
  },
  entra_unavailable: {
    title: 'Microsoft Entra couldn’t complete the sign-in',
    body: 'Microsoft’s sign-in service had a temporary problem.',
    next: 'Wait a moment and try again.',
    primary: 'sign-in',
  },
  signin_busy: {
    title: 'AdminForge is busy with other sign-ins',
    body: 'Too many sign-ins were started in the last few minutes, so AdminForge didn’t start yours.',
    next: 'Wait a few minutes, then sign in again.',
    admin:
      'More than 5,000 sign-ins are pending at once, which usually means requests are flooding the sign-in address. Check the Ingress logs for where they come from.',
    primary: 'sign-in',
  },
  rate_limited: {
    title: 'Too many sign-in attempts',
    body: 'AdminForge paused sign-ins from this browser for a moment.',
    next: 'Wait a minute, then try again.',
    primary: 'sign-in',
  },
  account_status_missing: {
    title: 'AdminForge couldn’t confirm your account type',
    body: 'Microsoft’s response didn’t say whether your account is a member or a guest, so AdminForge didn’t sign you in.',
    next: 'Ask a portal administrator to update the AdminForge apps, then sign in again.',
    admin: 'Run `pnpm adminforge provision entra`. It adds the acct claim to the Read and Write apps.',
    primary: 'sign-in',
  },
};

const ARM: Record<string, ProblemCopy> = {
  arm_cancelled: {
    title: 'Write access wasn’t turned on',
    body: `The verification was cancelled. ${STILL_READ_ONLY}`,
    next: 'Arm write access again when you’re ready.',
    primary: 'back',
  },
  no_write_access: {
    title: 'Your account can’t turn on write access',
    body: `Write access needs the AdminForge Operator role. ${STILL_READ_ONLY}`,
    next: 'Ask a portal administrator to add you to the AdminForge Operator group.',
    admin: 'Add the account to SG-AdminForge-<environment>-Portal.Operator.',
    primary: 'back',
  },
  forbidden: {
    title: 'Your account can’t turn on write access',
    body: `Write access needs the AdminForge Operator role. ${STILL_READ_ONLY}`,
    next: 'Ask a portal administrator to add you to the AdminForge Operator group.',
    admin: 'Add the account to SG-AdminForge-<environment>-Portal.Operator.',
    primary: 'back',
  },
  user_mismatch: {
    title: 'You verified with a different account',
    body: `Write access must be verified by the account that’s signed in. ${STILL_READ_ONLY}`,
    next: 'Arm again and verify with the account shown in the top-right corner of AdminForge.',
    primary: 'back',
  },
  session_mismatch: {
    title: 'Your session changed while you were verifying',
    body: 'Write access was requested from a different sign-in session, for example after signing in again in another tab.',
    next: 'Go back to AdminForge and arm again from that tab.',
    primary: 'back',
  },
  step_up_required: {
    title: 'Your verification didn’t meet the write-access policy',
    body: `Your organisation requires a stronger verification for write access. ${STILL_READ_ONLY}`,
    next: 'Arm again and complete every prompt, for example on a compliant device or with phishing-resistant MFA.',
    primary: 'back',
  },
  step_up_stale: {
    title: 'Write access needs a fresh verification',
    body: `Microsoft reused an earlier sign-in instead of asking you again. ${STILL_READ_ONLY}`,
    next: 'Arm again and enter your credentials when Microsoft asks.',
    primary: 'back',
  },
  account_status_missing: {
    title: 'AdminForge couldn’t confirm your account type',
    body: `Microsoft’s response didn’t say whether your account is a member or a guest, so write access stayed off. ${STILL_READ_ONLY}`,
    next: 'Ask a portal administrator to update the AdminForge Write app, then arm again.',
    admin: 'Run `pnpm adminforge provision entra`. It adds the acct claim to the Write app.',
    primary: 'back',
  },
  step_up_unverified: {
    title: 'AdminForge couldn’t confirm your verification',
    body: `Microsoft’s response didn’t say when you last verified, so write access stayed off. ${STILL_READ_ONLY}`,
    next: 'Ask a portal administrator to update the AdminForge Write app, then arm again.',
    admin: 'Run `pnpm adminforge provision entra`. It adds the auth_time claim to the Write app.',
    primary: 'back',
  },
  consent_required: {
    title: 'Write access isn’t approved in your organisation yet',
    body: `Microsoft Entra needs an administrator to approve the AdminForge Write app. ${STILL_READ_ONLY}`,
    next: 'Ask a Global Administrator to grant consent.',
    admin: 'Run `pnpm adminforge provision entra` on the AdminForge host.',
    primary: 'back',
  },
  invalid_state: {
    title: 'This write-access request has expired',
    body: `Verification has to finish within 10 minutes, in the tab that started it. ${STILL_READ_ONLY}`,
    next: 'Arm write access again.',
    primary: 'back',
  },
};

const DOWNLOAD: Record<string, ProblemCopy> = {
  forbidden: {
    title: 'You can’t download this report',
    body: 'Scheduled reports are collected with AdminForge’s own permissions, so they’re limited to the roles the schedule names (Operator by default).',
    next: 'Ask a portal administrator for access, or for a copy of the report.',
    admin:
      'Add the account to SG-AdminForge-<environment>-Portal.Operator, or set requires.portalRoles on the schedule.',
    primary: 'back',
  },
  artifact_not_found: {
    title: 'This report file is no longer available',
    body: 'Report files are kept for a limited time, and this one has been removed.',
    next: 'Open the schedule and select Run now for a fresh copy.',
    primary: 'back',
  },
  unauthenticated: {
    title: 'Sign in to download this report',
    body: 'Your AdminForge session ended before the download started.',
    next: 'Sign in, then select the report again.',
    primary: 'sign-in',
  },
  rate_limited: {
    title: 'Too many downloads this minute',
    body: 'AdminForge paused downloads from this browser for a moment.',
    next: 'Wait a minute, then try again.',
    primary: 'back',
  },
};

const FALLBACK_DOWNLOAD: ProblemCopy = {
  title: 'The report didn’t download',
  body: 'AdminForge couldn’t send this file.',
  next: `Try again from the schedule’s run history. ${REPORT}`,
  primary: 'back',
};

const FALLBACK_SIGN_IN: ProblemCopy = {
  title: 'AdminForge couldn’t complete your sign-in',
  body: 'Something went wrong between AdminForge and Microsoft Entra.',
  next: `Sign in again. ${REPORT}`,
  primary: 'sign-in',
  secondary: 'choose-account',
};

const FALLBACK_ARM: ProblemCopy = {
  title: 'Write access wasn’t turned on',
  body: `AdminForge couldn’t complete the write-access verification. ${STILL_READ_ONLY}`,
  next: `Arm write access again. ${REPORT}`,
  primary: 'back',
};

/** The copy for a failure code; unknown codes get a general explanation rather than the code itself. */
export function problemCopy(code: string | undefined, during: 'sign-in' | 'arm' | 'download'): ProblemCopy {
  if (during === 'download') return (code && DOWNLOAD[code]) || FALLBACK_DOWNLOAD;
  if (during === 'arm') {
    if (code === 'blocked_by_policy' || code === 'entra_unavailable' || code === 'rate_limited') {
      const base = SIGN_IN[code]!;
      return { ...base, body: `${base.body} ${STILL_READ_ONLY}`, primary: 'back', secondary: undefined };
    }
    return (code && ARM[code]) || FALLBACK_ARM;
  }
  return (code && SIGN_IN[code]) || FALLBACK_SIGN_IN;
}

/** Where each action goes. Sign-in routes are server routes, so these are plain links (full navigations). */
export function actionHref(action: ProblemAction): string {
  if (action === 'choose-account') return '/auth/login?account=choose&returnTo=%2F';
  if (action === 'sign-in') return '/auth/login?returnTo=%2F';
  return '/';
}
