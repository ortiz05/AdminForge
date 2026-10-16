/**
 * The validation user's password (`provision test-identities`): random from a CSPRNG, all four character classes
 * Entra requires, and only symbols that survive env files, shells and compose. Written to the admin env file by the
 * caller, never printed.
 */
import { randomInt } from 'node:crypto';

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
// No quotes, spaces, '#', '$', '\\' or '`': the value goes into an env file and may pass through shells/compose.
const SYMBOLS = '!%*+-.:=?@^_~';

/**
 * Strong random password meeting Entra complexity (all four character classes), from a CSPRNG.
 * `pick` is injectable for tests; the default uses crypto.randomInt.
 */
export function generatePassword(
  length = 28,
  pick: (max: number) => number = (max) => randomInt(max),
): string {
  if (length < 16) throw new Error('Password length must be at least 16');
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  const chars = [UPPER, LOWER, DIGITS, SYMBOLS].map((set) => set[pick(set.length)]!);
  while (chars.length < length) chars.push(all[pick(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
