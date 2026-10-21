# Azure Virtual Desktop (2026-10-17)

> Licensing finding of 2026-10-17: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

Host pools, session hosts, user sessions, connection diagnostics, four reports, five checks and three write playbooks
(docs/operations.md › Azure Virtual Desktop). **Fixture-validated only**: the validation tenant has no Azure
subscription and no host pool, so none of these Resource Graph, Resource Manager or Log Analytics requests has run
against Azure yet. Run each view, probe and playbook (dry run first, then on a test host pool) once before relying on
it.

- **Host pools, application groups, workspaces, scaling plans**
  - Tables and properties (how confirmed): `resources`, types `microsoft.desktopvirtualization/hostpools`
    (`hostPoolType`, `loadBalancerType`, `maxSessionLimit` — 999999 when unset, `startVMOnConnect`,
    `validationEnvironment`, `preferredAppGroupType`, `personalDesktopAssignmentType`, `agentUpdate.type`),
    `applicationgroups` (`hostPoolArmPath`, `applicationGroupType`, `workspaceArmPath`), `workspaces`, `scalingplans`
    (`hostPoolReferences[].hostPoolArmPath` / `scalingPlanEnabled`) — Resource Graph table reference, Host Pools REST
  - Needs: Reader or Desktop Virtualization Reader. AVD resources are free; session host VMs (or Azure Local) bill as
    usual
- **Session hosts**
  - Tables and properties (how confirmed): `desktopvirtualizationresources`, type
    `microsoft.desktopvirtualization/hostpools/sessionhosts` (the only AVD type in that table): `status` (Available,
    Unavailable, Shutdown, Disconnected, Upgrading, UpgradeFailed, NoHeartbeat, NotJoinedToDomain,
    DomainTrustRelationshipLost, SxSStackListenerNotReady, FSLogixNotHealthy, NeedsAssistance), `allowNewSession`
    (drain mode is `false`), `sessions`, `assignedUser`, `agentVersion`, `sxSStackVersion`, `osVersion`,
    `updateState`, `updateErrorMessage`, `lastHeartBeat`, `statusTimestamp`, `resourceId` (the VM, or an Arc machine
    on Azure Local), `sessionHostHealthCheckResults[]` — Session Hosts REST (2024-04-03)
  - Needs: Reader or Desktop Virtualization Reader. How quickly Resource Graph follows a status change is unconfirmed:
    the session host page reads Resource Manager
- **User sessions**
  - Tables and properties (how confirmed): `GET …/hostPools/{pool}/userSessions` (`$filter` by `userPrincipalName`),
    `GET …/sessionHosts/{host}/userSessions`: `userPrincipalName`, `sessionState` (Active, Disconnected, Pending,
    LogOff, UserProfileDiskMounted), `applicationType`, `createTime`; `name` is `pool/host/id` — User Sessions REST
    (2024-04-03), Get-AzWvdUserSession
  - Needs: Desktop Virtualization Reader (or Reader)
- **Drain mode**
  - Tables and properties (how confirmed): `PATCH …/sessionHosts/{host}` with `properties.allowNewSession` — Session
    Hosts – Update
  - Needs: Desktop Virtualization Session Host Operator (or Contributor)
- **Messages and sign-outs**
  - Tables and properties (how confirmed): `POST …/userSessions/{id}/sendMessage` (`messageTitle`, `messageBody`);
    `DELETE …/userSessions/{id}?force=true` (log off) — User Sessions REST
  - Needs: Desktop Virtualization User Session Operator (or Contributor)
- **Connection diagnostics**
  - Tables and properties (how confirmed): Log Analytics `WVDConnections` (`State`, `CorrelationId`, `UserName`,
    `SessionHostName`, `ClientType`, `ClientOS`, `ClientVersion`, `TransportType`, `GatewayRegion`), `WVDErrors`
    (`CodeSymbolic`, `Code`, `Message`, `ServiceError`, `Source`, `ActivityType`, `UserName`),
    `WVDConnectionNetworkData` (`EstRoundTripTimeInMs`, `EstAvailableBandwidthKBps`) — Azure Monitor table reference
  - Needs: The host pools' diagnostic settings sending Connections, Errors and Network data to the workspace
    (`AF_AVD_LOG_ANALYTICS_WORKSPACE_ID`); Log Analytics ingestion is billed per GB
- **People who connect**
  - Tables and properties (how confirmed): Microsoft checks each user's AVD access right at connection (Microsoft 365
    E3/E5/A3/A5/F3/Business Premium, Windows Enterprise E3/E5 or VDA, or per-user access pricing for external users).
    AdminForge doesn't read or gate on it
  - Needs: —

Sources (read 2026-10-17):
[Resource Graph tables and resource types](https://learn.microsoft.com/azure/governance/resource-graph/reference/supported-tables-resources),
[Session Hosts – Get (2024-04-03)](https://learn.microsoft.com/rest/api/desktopvirtualization/session-hosts/get),
[User Sessions – List By Host Pool](https://learn.microsoft.com/rest/api/desktopvirtualization/user-sessions/list-by-host-pool),
[User Sessions – Send Message](https://learn.microsoft.com/rest/api/desktopvirtualization/user-sessions/send-message),
[Get-AzWvdUserSession](https://learn.microsoft.com/powershell/module/az.desktopvirtualization/get-azwvdusersession),
[WVDConnections](https://learn.microsoft.com/azure/azure-monitor/reference/tables/wvdconnections),
[WVDErrors](https://learn.microsoft.com/azure/azure-monitor/reference/tables/wvderrors),
[WVDConnectionNetworkData](https://learn.microsoft.com/azure/azure-monitor/reference/tables/wvdconnectionnetworkdata).
