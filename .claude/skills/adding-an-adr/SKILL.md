---
name: adding-an-adr
description: Use when an AdminForge change makes or reverses an architectural decision someone could undo by accident — identities, token custody, storage, hosting, the security model, how content runs — or when asked to write an ADR or record a decision.
---

# Adding an ADR

## Overview

Architecture decisions are `docs/adr/NNN-<slug>.md`, one screen each, from the template
`docs/onboarding/templates/adr.md` (Context with the options considered, Decision, Consequences). Smaller decisions
are a line in `docs/decisions.md`. Where each kind of decision goes: `docs/onboarding/11-documentation.md`.

## When not to use

- A smaller choice (a default, a naming rule, a limit) → a line in `docs/decisions.md` under its group.
- A plan or a proposal still under discussion → a plan in `docs/plans/` with a status line; the ADR comes when it is
  decided.
- Changing an accepted ADR's decision — never edit it: write a new ADR that supersedes it.

## Steps

1. **Read what exists:** `ls docs/adr` and `rg -n "ADR-0" docs CLAUDE.md SECURITY.md` — the decision may already be
   recorded, or the new one supersedes an old one.
2. Copy `docs/onboarding/templates/adr.md` to `docs/adr/<next free number>-<slug>.md`; the title states the decision
   in one line; `Status: proposed` until a code owner accepts it, then `accepted (YYYY-MM-DD)`.
3. **Context:** what forces the decision now, the constraints, and each alternative considered with the reason it
   lost. **Decision:** what is done, where it lives (paths), what is allowed and refused, who can change it.
   **Consequences:** what gets easier and harder, follow-ups as `docs/backlog.md` entries, and which docs and skills
   now describe it.
4. When it supersedes an ADR, set the old one's status to `superseded by ADR-NNN` (the only edit an accepted ADR gets).
5. Link it from the code and docs that depend on it (`// ADR-0NN` in the module, the `SECURITY.md` or
   `docs/architecture.md` section), and add it wherever ADRs are indexed.
6. Nothing tenant-specific: no tenant names, hosts, addresses or licence holdings of one installation.

## Done when

- [ ] `docs/adr/NNN-<slug>.md` follows the template, fits one screen and lists the options that lost and why
- [ ] A superseded ADR says so; dependent code and docs link the new number
- [ ] Follow-ups are in `docs/backlog.md`; the docs and skills it changes are updated in the same change
- [ ] Prettier is clean on the file and `pnpm guard` passes

## Common mistakes

| Mistake                                              | Fix                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Rewriting an accepted ADR's decision                 | A new ADR that supersedes it                                             |
| A decision with no alternatives                      | Name each option considered and why it lost — that is what stops undoing |
| An ADR that cites a plan section as its reason       | State the reason in the ADR; plans are historical                        |
| Installation details (hosts, licences) in the record | Keep them in the operator's notes outside the repository                 |

## See also

- `docs/onboarding/templates/adr.md`, `docs/onboarding/11-documentation.md`, `docs/decisions.md`, `docs/adr/`
