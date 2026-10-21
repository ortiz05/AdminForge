# ADR-001: Backend-for-frontend holds all tokens

Status: accepted (2026-10-15)

> Context, options and consequences back-filled on 2026-10-21 from the master plan it came from
> (`docs/plans/2026-10-15-adminforge-master-plan.md` §3, §4.3, §5.5, §5.10). The decision is unchanged.

## Context

AdminForge works with admin-grade delegated scopes — `User.ReadWrite.All`, `Exchange.Manage`, ARM
`user_impersonation` — for engineers who are often directory or subscription administrators. Whoever holds those
tokens can do what the engineer can. A browser is the easiest place to steal them from: a cross-site scripting bug, a
compromised dependency or a malicious extension reads anything JavaScript can read. The IETF guidance for OAuth in
browser-based apps recommends a backend-for-frontend for exactly this risk profile.

## Options considered

- **SPA with MSAL.js, tokens in browser storage** — the default for single-page apps. Rejected: access and refresh
  tokens sit where any script on the page can read them, and the blast radius is the engineer's whole admin access.
- **A token-mediating backend** (the server runs the OAuth flow, then hands access tokens to the browser). Rejected:
  shorter-lived, but the tokens still reach JavaScript.
- **Backend-for-frontend** — the server runs the sign-in, keeps every token and makes every Microsoft call; the
  browser holds a session cookie. Chosen.

## Decision

The browser only holds an HttpOnly session cookie; the API owns MSAL caches (encrypted at rest).

## Consequences

- More server state: sessions, pending sign-ins and the token cache live in the database (`sessions`, `preauth`,
  `token_cache`; one SQLite file since ADR-016). Session ids are stored hashed; the cookie is `__Host-adminforge`
  (HttpOnly, Secure, SameSite=Lax) in production.
- The MSAL cache is sealed with AES-256-GCM under `TOKEN_CACHE_KEY`, bound to its partition (`read:<session>`,
  `write:<session>`), so a blob can't be replayed under another session. Losing the key signs everyone out; a stolen
  database without it yields no tokens.
- The API is the only path to Microsoft: every call goes through the outbound executor, which is also where the
  request policy (ADR-003), correlation ids and error mapping live. Same origin, so no CORS; state-changing requests
  carry a CSRF header (`X-AdminForge-CSRF`) because the cookie rides along automatically.
- Claims challenges (Continuous Access Evaluation, Conditional Access) come back to the browser as a structured
  re-authentication answer, not as a token.
- Amended by ADR-014: a schedule that runs as its creator keeps that person's sealed refresh token in the schedule's
  own partition, beyond any session. `SECURITY.md` › Sessions and tokens describes the model as built.
