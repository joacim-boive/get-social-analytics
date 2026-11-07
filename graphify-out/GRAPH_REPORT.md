# Graph Report - .  (2026-11-07)

## Corpus Check
- Corpus is ~33,547 words - fits in a single context window. You may not need a graph.

## Summary
- 477 nodes · 1422 edges · 17 communities (11 shown, 6 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 9 edges (avg confidence: 0.58)
- Token cost: 13,370 input · 1,608 output

## Community Hubs (Navigation)
- HTTP API Query Args
- Platform Error Mapping
- Local HTTP Server
- TikTok Client Fetch
- Credential Parsing
- NPM Dependencies
- Comparison Reports
- Clerk Auth OAuth
- Period Date Helpers
- TypeScript Config
- API Report Layout
- Clerk Product
- MCP Protocol
- Platforms Module
- Settings Module
- Turso Cloud

## God Nodes (most connected - your core abstractions)
1. `isRecord()` - 50 edges
2. `readString()` - 37 edges
3. `CredentialStore` - 31 edges
4. `asNumber()` - 28 edges
5. `createSettingsApp()` - 23 edges
6. `metric()` - 21 edges
7. `requireConnection()` - 15 edges
8. `toPlatform()` - 15 edges
9. `requestJson()` - 14 edges
10. `formatIsoDate()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `registerDataRoutes()` --references--> `hono`  [EXTRACTED]
  src/api/routes.ts → package.json
- `createSettingsApp()` --references--> `hono`  [EXTRACTED]
  src/settings/routes.ts → package.json
- `tempStore()` --calls--> `openStore()`  [EXTRACTED]
  test/refresh.test.ts → src/store.ts
- `tempStore()` --calls--> `openStore()`  [EXTRACTED]
  test/youtube-save.test.ts → src/store.ts
- `handleMcp()` --calls--> `createMcpServer()`  [EXTRACTED]
  src/http.ts → src/mcp/server.ts

## Import Cycles
- None detected.

## Communities (17 total, 6 thin omitted)

### Community 0 - "HTTP API Query Args"
Cohesion: 0.06
Nodes (69): ApiQueryError, argsFromBody(), argsFromQuery(), readBodyPeriod(), readBodyPlatforms(), readBodyTiming(), readDayCount(), readFormat() (+61 more)

### Community 1 - "Platform Error Mapping"
Cohesion: 0.09
Nodes (63): googleMessage(), googleReason(), mapGoogleError(), mapMetaError(), mapTikTokError(), PlatformApiError, DAILY_METRICS, fetchPage() (+55 more)

### Community 2 - "Local HTTP Server"
Cohesion: 0.07
Nodes (53): app, handleMcp(), listener, port, server, store, getClient(), exchangeTikTokCode() (+45 more)

### Community 3 - "TikTok Client Fetch"
Cohesion: 0.09
Nodes (56): pushCount(), toContentItem(), requestJson(), rememberAccount(), requireConnection(), assertTikTokOk(), buildSummary(), ensureTikTokAccess() (+48 more)

### Community 4 - "Credential Parsing"
Cohesion: 0.08
Nodes (40): CredentialMap, expectRecord(), FacebookCredentials, InstagramCredentials, parseCredentials(), parseFacebook(), parseInstagram(), parseTikTok() (+32 more)

### Community 5 - "NPM Dependencies"
Cohesion: 0.05
Nodes (37): better-sqlite3, @clerk/backend, hono, @hono/node-server, @libsql/client, @modelcontextprotocol/sdk, dependencies, better-sqlite3 (+29 more)

### Community 6 - "Comparison Reports"
Cohesion: 0.10
Nodes (36): addGap(), addStandingGaps(), appliedPeriod(), buildDaily(), buildSummary(), classifyGap(), ComparisonAccount, ComparisonContent (+28 more)

### Community 7 - "Clerk Auth OAuth"
Cohesion: 0.17
Nodes (29): allowedEmail(), authorizationServerMetadata(), clerk(), clerkAccountPortal(), clerkAuthorizedParties(), clerkFrontendApi(), ClerkKeys, clerkRedirect() (+21 more)

### Community 8 - "Period Date Helpers"
Cohesion: 0.21
Nodes (15): loadInstagram(), addDays(), clampLookback(), daysBefore(), formatIsoDate(), localDateFromIso(), parseIsoDate(), PeriodError (+7 more)

### Community 9 - "TypeScript Config"
Cohesion: 0.12
Nodes (16): node, src/**/*.ts, test/**/*.ts, compilerOptions, esModuleInterop, module, moduleResolution, noEmit (+8 more)

## Knowledge Gaps
- **89 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+84 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `hono` connect `NPM Dependencies` to `HTTP API Query Args`, `Local HTTP Server`?**
  _High betweenness centrality (0.136) - this node is a cross-community bridge._
- **Why does `createSettingsApp()` connect `Local HTTP Server` to `HTTP API Query Args`, `NPM Dependencies`, `Clerk Auth OAuth`?**
  _High betweenness centrality (0.101) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _89 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `HTTP API Query Args` be split into smaller, more focused modules?**
  _Cohesion score 0.05647517039922103 - nodes in this community are weakly interconnected._
- **Should `Platform Error Mapping` be split into smaller, more focused modules?**
  _Cohesion score 0.08637747336377473 - nodes in this community are weakly interconnected._
- **Should `Local HTTP Server` be split into smaller, more focused modules?**
  _Cohesion score 0.06634615384615385 - nodes in this community are weakly interconnected._
- **Should `TikTok Client Fetch` be split into smaller, more focused modules?**
  _Cohesion score 0.09117475160724722 - nodes in this community are weakly interconnected._