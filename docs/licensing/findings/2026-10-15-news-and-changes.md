# News and changes (2026-10-15)

> Licensing finding of 2026-10-15: what was checked that day and against which tenant state. The current feature →
> licence map is the [licensing and permission review](../../licensing-review.md); a later finding supersedes
> this one instead of editing it.

- **Message Center (`GET /admin/serviceAnnouncement/messages`)**
  - Finding: Application permission supported; data-privacy posts' app-only visibility undocumented (Portal.Admin
    only)
  - Licence: None
  - Permission / role: ServiceMessage.Read.All (application, admin consent) — in the automation baseline
- **Service health (`GET /admin/serviceAnnouncement/issues`)**
  - Finding: Application permission supported; no documented per-issue admin-center link (the service health page is
    cited)
  - Licence: None
  - Permission / role: ServiceHealth.Read.All (application, admin consent) — in the automation baseline
- **Azure Service Health (Resource Graph `servicehealthresources`)**
  - Finding: Readable with Reader; security advisory details need an elevated role; emerging issues aren't in Resource
    Graph
  - Licence: None (free)
  - Permission / role: Reader on each subscription (Service Health Security Reader for advisory details)
- **Public feeds (Azure Updates, Roadmap, MSRC, Graph changelog, Tech Community, Learn search, PowerShell Gallery)**
  - Finding: Anonymous https; only MSRC supports conditional requests; the Graph changelog has had no new items since
    August 2026
  - Licence: None
  - Permission / role: None (outbound https to the feed hosts)
