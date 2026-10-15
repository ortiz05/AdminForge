import { base32Decode, totp } from '../../live/lib/totp';

// RFC 6238 Appendix B test vector (SHA-1, secret "12345678901234567890").
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totp', () => {
  it('decodes base32', () => expect(base32Decode(RFC_SECRET).toString()).toBe('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches RFC 6238 at T=%i', (t, code) => expect(totp(RFC_SECRET, t * 1000)).toBe(code));
});
