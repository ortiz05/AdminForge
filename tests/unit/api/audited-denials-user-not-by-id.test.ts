import { AUDITED_DENIALS } from '@adminforge/api/src/errors';

// S-15: a declared Graph write that names a user by sign-in name instead of object id is refused before it is sent
// (`user_not_by_id`, the protected-object guard). Like `protected_object` from the same guard, the refusal is
// security-relevant — it is how a write aimed at a protected account by UPN shows up — so it reaches the audit log.
describe('audited denials from the protected-object guard', () => {
  it.each(['protected_object', 'user_not_by_id'])('%s is an audited denial', (code) => {
    expect(AUDITED_DENIALS.has(code)).toBe(true);
  });
});
