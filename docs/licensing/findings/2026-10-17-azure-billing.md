# Azure Billing (2026-10-17)

> Licensing finding of 2026-10-17: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

Cost across subscriptions (docs/operations.md › Azure Billing). **Fixture-validated only**: the validation tenant has
no Azure subscription, so no Cost Management, forecast or Billing request below has run against Azure yet (the
subscription-scope query of `azure.monthly-cost` was checked against the earlier tenant on 2026-10-15). Run each view
once against a subscription with cost before relying on it.

- **Cost Management query and forecast (`POST …/Microsoft.CostManagement/query`, `/forecast`)**
  - Requirement / finding: An offer with Cost Management: Enterprise Agreement, Microsoft Customer Agreement,
    pay-as-you-go (MOSP). Not most CSP, sponsorship or Azure in Open offers. Free
  - Affects: Every Azure Billing view
- **Management-group scope (default: the tenant root group)**
  - Requirement / finding: Cost Management Reader (or Reader) on the group. Adds up EA and pay-as-you-go
    subscriptions; for MCA billing accounts, check once that management-group cost answers (not every MCA setup
    supports it) and use the billing-account scope if it doesn't. At most 3,000 subscriptions per group
  - Affects: Overview, cost analysis, this month and last, trend, chargeback, top resources
- **Billing-account scope (`AF_BILLING_ACCOUNT_ID`)**
  - Requirement / finding: EA: Enterprise administrator (read only) or department/account reader; MCA: Billing account
    reader / owner. The read policy now allows query and forecast at billing account and billing profile scope
  - Affects: The same views with "Billing account"
- **Forecast**
  - Requirement / finding: Not offered for every offer or for scopes without enough history: the overview falls back
    to a straight-line projection
  - Affects: Overview "Forecast this month"
- **Amortized cost**
  - Requirement / finding: EA and MCA; pay-as-you-go returns actual cost for it
  - Affects: Cost analysis, chargeback (amortized by default), trend
- **Tags in cost (`TagKey` grouping)**
  - Requirement / finding: Resource tags only, unless tag inheritance is on in Cost Management settings
  - Affects: Chargeback by tag, cost analysis by tag
- **Budgets (`Microsoft.Consumption/budgets`)**
  - Requirement / finding: Reader on the subscription; subscription-scope budgets only (one subscription per view)
  - Affects: Azure budgets
- **Invoices (`GET /providers/Microsoft.Billing/billingAccounts/{id}/invoices`)**
  - Requirement / finding: MCA and pay-as-you-go billing accounts; Billing account reader or Invoice manager. EA
    invoices aren't listed there
  - Affects: Invoices page
- **Throttling**
  - Requirement / finding: A few queries a minute per scope (the earlier tenant answered 429 after two calls): every
    view caches for an hour
  - Affects: All views
