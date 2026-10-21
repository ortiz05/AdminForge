# Hybrid Azure Arc servers at scale (2026-10-17)

> Licensing finding of 2026-10-17: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

Fleet dashboard, server list, extensions, Update Manager patching, Defender for Servers coverage and five Arc
configuration checks (docs/operations.md › Azure Arc servers). **Fixture-validated only**: the validation tenant has
no Azure subscription and no Arc-enabled server, so none of these Resource Graph queries has run against Azure yet.
Run each view and probe once against a subscription with Arc servers before relying on it. Function Apps and Azure
Arc-enabled Kubernetes are retired (not needed at this time; docs/backlog.md says how to bring them back).

- **Arc servers**
  - Tables and properties (how confirmed): `resources`, type `microsoft.hybridcompute/machines`: `properties.status`
    (Connected, Disconnected, Error, AwaitingConnection; Arc also reports Expired after 45 days offline),
    `agentVersion`, `lastStatusChange`, `agentUpgrade.enableAutomaticUpgrade` / `lastAttemptStatus` /
    `lastAttemptMessage`, `osProfile.windowsConfiguration` / `linuxConfiguration.patchSettings.assessmentMode` and
    `patchMode` — REST reference Machines – Get (2026-07-15); Arc Resource Graph samples
  - Needs: Reader. Arc itself is free; extensions and services bill separately
- **Agent currency**
  - Tables and properties (how confirmed): Relative to the newest agent version installed in the fleet (Resource Graph
    has no catalogue of releases). Microsoft supports only agent versions released within the last year; Advisor's
    "Upgrade to the latest version of the Azure Connected Machine agent" recommendation (`advisorresources`,
    `extendedProperties.latestVersion`) knows the real latest — Arc samples, Manage agent versions
  - Needs: Reader
- **Extensions**
  - Tables and properties (how confirmed): `resources`, type `microsoft.hybridcompute/machines/extensions`:
    `properties.type`, `publisher`, `typeHandlerVersion`, `provisioningState`, `enableAutomaticUpgrade`,
    `instanceView.status.level` / `code` / `message`; machine = the id before `/extensions/` — Arc Resource Graph
    samples, Troubleshoot VM extensions
  - Needs: Reader
- **Update Manager**
  - Tables and properties (how confirmed): `patchassessmentresources` (latest assessment, kept 7 days;
    `availablePatchCountByClassification.critical` / `security` / `updateRollup` / `featurePack` / `servicePack` /
    `definition` / `tools` / `updates` / `other`, `lastModifiedDateTime`, `rebootPending`, per-update records
    `patchName`, `kbId`, `classifications`, `publishedDateTime`) and `patchinstallationresources` (runs, kept 30 days;
    `status` NotStarted / InProgress / Failed / Succeeded / CompletedWithWarnings, `startDateTime`,
    `installedPatchCount`, `failedPatchCount`, `pendingPatchCount`, `rebootStatus`, `maintenanceWindowExceeded`).
    Summary records are the types without `softwarepatches`, as in Microsoft's samples. Confirmed in the query-logs
    property tables (2026-10-17): the summary record's `osType` (Windows / Linux) and `errorDetails`, and the
    per-update `rebootRequired` (whether the update needs a restart — `rebootBehavior` is the deployment's restart
    setting and isn't used); the assessment summary's `status` isn't in the documented table. The assessed servers are
    read from these records alone (name, subscription and resource group from the record's id and columns) because
    Resource Graph allows one join to another table per query — Update Manager query logs and sample queries
  - Needs: Reader. Periodic assessment (every 24 hours) must be on: Azure Policy "Configure periodic checking for
    missing system updates on Azure Arc-enabled servers"; the subscription registered for Microsoft.Compute. **Billed
    per Arc server per connected day** unless the server has ESUs enabled by Arc, its subscription has Defender for
    Servers Plan 2, or Windows Server Software Assurance / Windows Server pay-as-you-go by Arc covers it (Update
    Manager FAQ)
- **Defender for Servers**
  - Tables and properties (how confirmed): `securityresources`: subscription-level `microsoft.security/pricings`
    `VirtualMachines` (`pricingTier` Standard = on, `subPlan` P1/P2; read once per subscription and passed to the
    server queries as id lists — per-resource Defender for Servers plans aren't read) and
    `microsoft.security/assessments` under the machine's id (`status.code` Unhealthy, `metadata.severity`); the
    Defender for Endpoint extension `MDE.Windows` / `MDE.Linux` from `resources` — Defender for Cloud Resource Graph
    samples, Defender for Servers data collection. Nothing from the Microsoft Defender portal. Resource-level Defender
    for Servers pricing (per-machine plan) isn't read; servers onboarded to Defender for Endpoint without the
    extension show as "not installed"
  - Needs: Reader (or Security Reader); Defender for Servers Plan 1 or 2 per server
- **ESU (Windows Server 2012 / 2012 R2)**
  - Tables and properties (how confirmed): `properties.licenseProfile.esuProfile.esuEligibility` (Eligible /
    Ineligible / Unknown), `licenseAssignmentState` (Assigned / NotAssigned), `esuKeyState` (Active / Inactive) — REST
    reference Machines – Get; whether Resource Graph carries `licenseProfile` on every machine is unconfirmed. ESU
    licences themselves (`microsoft.hybridcompute/licenses`) aren't read
  - Needs: ESUs enabled by Azure Arc are paid per core

Sources (read 2026-10-17):
[Machines – Get (Hybrid Compute REST 2026-07-15)](https://learn.microsoft.com/rest/api/hybridcompute/machines/get),
[Resource Graph samples for Arc-enabled servers](https://learn.microsoft.com/azure/azure-arc/servers/resource-graph-samples),
[Manage agent versions](https://learn.microsoft.com/azure/azure-arc/servers/manage-agent),
[Troubleshoot VM extensions](https://learn.microsoft.com/azure/azure-arc/servers/troubleshoot-vm-extensions),
[Update Manager query logs](https://learn.microsoft.com/azure/update-manager/query-logs),
[Update Manager sample queries](https://learn.microsoft.com/azure/update-manager/sample-query-logs),
[Update Manager FAQ (pricing)](https://learn.microsoft.com/azure/update-manager/update-manager-faq),
[Periodic assessment with Azure Policy](https://learn.microsoft.com/azure/update-manager/periodic-assessment-at-scale),
[Defender for Cloud Resource Graph samples](https://learn.microsoft.com/azure/defender-for-cloud/resource-graph-samples),
[Defender for Servers data collection](https://learn.microsoft.com/azure/defender-for-cloud/plan-defender-for-servers-agents).
