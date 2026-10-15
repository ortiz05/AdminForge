import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import { safeEqual } from './tokens';

export const CSRF_HEADER = 'x-adminforge-csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const isSafeMethod = (method: string) => SAFE_METHODS.has(method.toUpperCase());

/** Throws 403 unless the request carries X-AdminForge-CSRF matching the session's token. */
export function assertCsrf(request: FastifyRequest) {
  const header = request.headers[CSRF_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (!request.session || !safeEqual(value, request.session.csrf)) {
    throw new AppError(403, 'csrf', 'Missing or invalid X-AdminForge-CSRF header. Reload the page and try again.');
  }
}
