---
type: "query"
date: "2026-11-07T10:21:41.923631+00:00"
question: "Give me a plan with Todos we can check off as we go for what's left in this project."
contributor: "graphify"
source_nodes: ["missing()", "settings", "clampLookback()", "comparisonStatus()", "notConfiguredReport()", "oauthRedirect()", "UnavailableMetric", "createSettingsApp()"]
---

# Q: Give me a plan with Todos we can check off as we go for what's left in this project.

## Answer

Expanded from original query via vocab: gap, missing, unavailable, notes, clamp, configured, comparison, oauth, settings, test, standing, status. Traversal started at missing(), settings, clampLookback(), comparisonStatus(), notConfiguredReport(), addGap(), withNotes(), oauthRedirect(), standingGap(), UnavailableMetric. The graph shows a finished four-platform pipeline. Remaining work is alignment and untested edges: settings page caps days at 365 while periodForDays allows 730; last_30_days exists in period.ts and the MCP schema but is absent from README and the tool description; YouTube emits period_average while AGENTS.md lists only three aggregations; store-turso.ts, mcp/server.ts, and Instagram/Facebook/TikTok saves have no dedicated tests; no CI workflow.

## Source Nodes

- missing()
- settings
- clampLookback()
- comparisonStatus()
- notConfiguredReport()
- oauthRedirect()
- UnavailableMetric
- createSettingsApp()