# Report library: Azure (2026-10-15)

> Licensing finding of 2026-10-15: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

- **Cost Management query (`POST …/Microsoft.CostManagement/query`)**
  - Finding: Works (MonthToDate, custom period); `TheLastMonth` rejected for this offer; 429 after two calls (cached 1
    h)
  - Affects: Azure cost this month and last, weekly schedule
  - Built anyway?: Yes — active (Azure Billing, 2026-10-17)
  - To unblock: Cost Management Reader; EA/MCA/PAYG offer
- **Consumption budgets (`GET …/Microsoft.Consumption/budgets`)**
  - Finding: Works with Reader; subscription-scope budgets only
  - Affects: Azure budgets, daily schedule
  - Built anyway?: Yes
  - To unblock: Resource-group budgets need per-group calls
- **Azure Advisor (`advisorresources`)**
  - Finding: Free
  - Affects: Advisor recommendations
  - Built anyway?: Yes
  - To unblock: —
- **Defender for Cloud pricings (`securityresources`)**
  - Finding: Readable with Reader; Foundational CSPM is free
  - Affects: Defender plan coverage
  - Built anyway?: Yes
  - To unblock: Paid plans per subscription
- **Azure Backup (`recoveryservicesresources`)**
  - Finding: Empty in the validation tenant; query accepted
  - Affects: VMs without backup, probe
  - Built anyway?: Yes — fields from the documented schema
  - To unblock: Reader on the vaults
- **Scheduled Azure coverage**
  - Finding: The automation identity has Reader on `AF_SUBSCRIPTION_ID` only
  - Affects: All Azure schedules and probes
  - Built anyway?: Yes
  - To unblock: Reader at a management group
