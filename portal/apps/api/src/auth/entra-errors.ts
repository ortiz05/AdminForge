import { AppError } from '../errors';
import type { AppKind } from './types';

/** Query parameters of an authorization response (response_mode=query). */
export interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

const AADSTS = /\bAADSTS\d{4,7}\b/;

interface Outcome {
  status: number;
  code: string;
  message: string;
  hint: string;
}

const ASK_ADMIN = 'If it keeps happening, give a portal administrator the reference below.';

/** What an Entra error means for the person in front of the browser, by AADSTS number (or OAuth error). */
function outcome(kind: AppKind, aadsts: string | undefined, error: string): Outcome {
  const n = aadsts ? Number(aadsts.slice(6)) : undefined;
  const write = kind === 'write';
  if (n === 50105) {
    return write
      ? {
          status: 403,
          code: 'no_write_access',
          message: 'Your account isn’t allowed to turn on write access.',
          hint: 'Ask a portal administrator to add you to the AdminForge Operator group.',
        }
      : {
          status: 403,
          code: 'no_portal_role',
          message: 'Your account doesn’t have access to AdminForge yet.',
          hint: 'Ask a portal administrator to add you to an AdminForge group: Reader to view, Operator to make changes.',
        };
  }
  if (n === 65001 || n === 65004 || error === 'consent_required') {
    return {
      status: 403,
      code: 'consent_required',
      message: write
        ? 'The AdminForge Write app hasn’t been approved in your organisation.'
        : 'AdminForge hasn’t been approved in your organisation yet.',
      hint: 'A Global Administrator needs to grant consent (run `adminforge provision entra`).',
    };
  }
  if (n === 53000 || n === 53001 || n === 53002 || n === 53003 || n === 530034) {
    return {
      status: 403,
      code: 'blocked_by_policy',
      message: 'Your organisation’s sign-in policy blocked this sign-in.',
      hint: 'Sign in from a device and network your organisation allows, or contact your identity team with the reference below.',
    };
  }
  if (n === 50020 || n === 90072 || n === 50034) {
    return {
      status: 400,
      code: 'wrong_tenant',
      message: 'That account isn’t part of this organisation.',
      hint: 'Sign in with your work account for this organisation.',
    };
  }
  if (error === 'access_denied' && !n) {
    return write
      ? {
          status: 400,
          code: 'arm_cancelled',
          message: 'Write access wasn’t turned on because the verification was cancelled.',
          hint: 'You’re still signed in with read-only access. Arm again when you’re ready.',
        }
      : {
          status: 400,
          code: 'signin_cancelled',
          message: 'Sign-in was cancelled.',
          hint: 'Sign in again when you’re ready.',
        };
  }
  if (error === 'temporarily_unavailable' || error === 'server_error') {
    return {
      status: 503,
      code: 'entra_unavailable',
      message: 'Microsoft Entra couldn’t complete the sign-in just now.',
      hint: 'Wait a moment and try again.',
    };
  }
  return write
    ? {
        status: 400,
        code: 'arm_failed',
        message: 'Microsoft Entra couldn’t verify you for write access.',
        hint: `You’re still signed in with read-only access. Arm again. ${ASK_ADMIN}`,
      }
    : {
        status: 400,
        code: 'signin_failed',
        message: 'Microsoft Entra couldn’t complete the sign-in.',
        hint: `Sign in again. ${ASK_ADMIN}`,
      };
}

/**
 * Entra error redirect → a specific, plain-language AppError. The AADSTS number (or the OAuth error) travels as
 * `detail` so an administrator can look it up; Entra's own description is logged, never shown.
 */
export function providerError(kind: AppKind, query: CallbackQuery): AppError | undefined {
  if (!query.error) return undefined;
  const error = query.error.slice(0, 64);
  const description = (query.error_description ?? '').split(/\r?\n/)[0]!.slice(0, 300);
  const aadsts = AADSTS.exec(description)?.[0];
  const o = outcome(kind, aadsts, error);
  return new AppError(o.status, o.code, o.message, {
    hint: o.hint,
    detail: aadsts ?? error.replace(/[^a-z_]/gi, ''),
  });
}

/** Entra's description (first line, no trace) for logs and the audit trail. */
export const providerDescription = (query: CallbackQuery) =>
  (query.error_description ?? '')
    .split(/\r?\n/)[0]!
    .replace(/\s+Trace ID:.*$/i, '')
    .slice(0, 300);
