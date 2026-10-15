# ADR-001: Backend-for-frontend holds all tokens

Status: accepted (2026-10-15)

## Context

Admin-grade delegated scopes must not be stealable by XSS.

## Decision

The browser only holds an HttpOnly session cookie; the API owns MSAL caches (encrypted at rest).

## Consequences

More server state; simpler, safer browser.
