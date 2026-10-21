# Microsoft Defender with Office 365 E5 (2026-10-16)

> Licensing finding of 2026-10-16: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

**Retired (2026-10-17).** AdminForge no longer covers the Microsoft Defender portal (security.microsoft.com): every
definition below is retired (`status: retired`, kept for run and audit history), the security overview dashboard keeps
only risky users and Defender for Cloud, and `identity.compromised-account` 3.0 no longer comments on a Defender
incident. Retired content earns no permissions, so `provision entra` no longer grants `SecurityIncident.*`,
`SecurityAlert.Read.All`, `SecurityEvents.Read.All` or `ThreatHunting.Read.All` and drops them from the delegated
consent; application permissions the automation identity already holds are removed with `provision entra --prune`. The
findings stay for anyone who brings the content back.

The validation tenant now has Office 365 E5: Defender service plans `MTP`, `THREAT_INTELLIGENCE` (Defender for Office
365 Plan 2), `ATP_ENTERPRISE` and `ADALLOM_S_O365` (Office 365 Cloud App Security). No Defender for Endpoint
(`WINDEFATP`), Defender for Identity or full Defender for Cloud Apps. Checked read-only with the validation user
(Global Reader) and the automation identity.

- **Incidents and alerts: `security.incidents`, `security.incident`, `security.alerts`, `security.alert`, dashboard
  tiles, `security.open-high-severity-incidents` and `security.alerts-summary` with their schedules,
  `probes.defender-new-high-severity-alerts`**
  - Needs: `defender`. Graph `SecurityIncident.Read.All` / `SecurityAlert.Read.All` (delegated and application). Role:
    Security Reader or Global Reader
  - Live result: **Blocked by tenant set-up:** 403 "Account is not provisioned" for both identities, because Defender
    XDR isn't set up for the tenant yet. Graph checks `$filter` before this, and every filter the pages and reports
    build was accepted (a bad clause gets 400). Data, transforms and empty states can only be checked after set-up.
    The portal now says so in words instead of "licence missing", and the probes report `not_configured`.
- **Advanced hunting (`runHuntingQuery`): Query Studio, `probes.risky-oauth-consents` (CloudAppEvents)**
  - Needs: `defender` + `ThreatHunting.Read.All`. Office 365 E5 covers the email tables (EmailEvents,
    EmailAttachmentInfo, EmailUrlInfo, EmailPostDeliveryEvents, UrlClickEvents) and AlertInfo / AlertEvidence
  - Live result: Same 403 for every table, so the EmailEvents path is not confirmed yet. CloudAppEvents needs Defender
    for Cloud Apps data. Whether Office 365 Cloud App Security fills it for consent events is unverified.
- **Incident playbooks: `security.assign-incident`, `security.update-incident`**
  - Needs: Write app `SecurityIncident.ReadWrite.All`. Role: Security Operator
  - Live result: **Dry run only.** The tenant has no incidents, and a real incident must never be changed. The preview
    stops at the lookup with the "isn't set up" message.
- **Secure Score: `security.secure-score`, the dashboard KPI, `security.secure-score-summary` and its weekly
  schedule**
  - Needs: No licence gate. `SecurityEvents.Read.All` (delegated and application)
  - Live result: **Works.** There was no snapshot early on 2026-10-16 (the pages now say "not calculated yet"); the
    first one arrived later that day. The snapshot's `maxScore` equals the sum of its `controlScores` controls'
    maximum points (verified). `secureScoreControlProfiles` also lists controls for products the tenant lacks (462
    controls: 186 Defender for Endpoint, 79 Defender for Identity, SaaS connectors), so actions now come from
    `controlScores` only. Cost and impact come in mixed case or as "Unknown".
    `averageComparativeScores[].averageScore` is a percentage. The weekly schedule ran once with delivery suppressed
    and succeeded.
- **Device vulnerabilities (`security.device-vulnerabilities`), Defender device and CVE links**
  - Needs: `defenderEndpoint`: `WINDEFATP`, or the `TVM_PREMIUM_1` add-on
  - Live result: **Gated correctly:** the page shows "Requires Microsoft Defender for Endpoint Plan 2 (WINDEFATP)".
    Before this fix, the web gate mapped `WINDEFATP` to `defender`, which Office 365 E5 satisfies.

**To unblock incidents, alerts and hunting (if the content is brought back):** a Global Administrator or Security
Administrator signs in to the Microsoft Defender portal (security.microsoft.com) once. Microsoft then sets up the
tenant's Defender XDR data, which can take a few hours. After that, run `tests/live/scripts/check-page-datasources.ts`
again for the Defender pages and reports, and run the two probes and the alerts schedule with `run-schedule-once.ts`.

## If the content comes back

Open questions the backlog held when the content was retired (2026-10-17), kept with the finding:

- Confirm the Defender device link (`security.microsoft.com/machines/v2/<id>/overview`) and CVE link formats on a
  tenant with Defender for Endpoint. Unverified on 2026-10-16: the validation tenant has Office 365 E5 only, and
  `security.device-vulnerabilities` is gated on `defenderEndpoint`.
- Live-check Defender XDR once it is set up for the tenant (Graph answers 403 "Account is not provisioned" for
  incidents, alerts and advanced hunting, although Office 365 E5 licenses them). After a Global Administrator opens
  security.microsoft.com once, check `security.overview`, the incidents and alerts pages,
  `security.open-high-severity-incidents`, `security.alerts-summary` and their schedules, the two Defender probes and
  hunting on EmailEvents in Query Studio. Then run `security.assign-incident` / `security.update-incident` (dry run →
  run → compensate) only on a test incident (from an attack simulation or a user-reported test message), never a real
  one.
- `probes.risky-oauth-consents` reads CloudAppEvents: confirm whether Office 365 Cloud App Security (`ADALLOM_S_O365`,
  in Office 365 E5) fills it with consent events. If only Defender for Cloud Apps does, declare that licence on the
  probe.
- Narrow the `defender` plan list: it includes `ATP_ENTERPRISE` (Defender for Office 365 Plan 1), which probably
  doesn't give Defender XDR incidents or advanced hunting — confirm on a Plan 1 tenant.
- An email threats report (Defender for Office 365 Plan 2, licensed) on EmailEvents / EmailPostDeliveryEvents: phish
  and malware delivered, ZAP results, user-reported messages — once hunting works in the tenant.
- Teach `requiresText` (the navigation rail) a short name for `TVM_PREMIUM_1` (Defender Vulnerability Management): the
  badge shows the raw service plan name.
