# AGENTS.md

This repo is a local analytics server for one person's Instagram, Facebook, TikTok, and YouTube accounts. Humans configure credentials in the browser. Agents call MCP tools and receive one report shape.

Read `README.md` for setup, tool arguments, and what each platform can honestly return. This file is for changing the code.

## Commands

```bash
npm install
npm start          # settings UI, JSON API, and streamable HTTP MCP on 127.0.0.1:8787
npm run stdio      # stdio MCP, same SQLite database
npm test           # Vitest, mocked fetch, no live API calls
npm run typecheck
```

Node.js 22 or newer. `npm run stdio` must not write logs to stdout. Protocol traffic owns that stream. Errors go to stderr.

## Layout

- `src/http.ts` — local HTTP entry. Settings routes, `/api/analytics`, and `/mcp`. Binds to `127.0.0.1`.
- `src/server.ts` — Vercel entry. Same settings app, exported for the Hono builder. On Vercel the database is `/tmp/get-social-analytics/analytics.sqlite` and does not survive a new instance.
- `src/stdio.ts` — stdio entry.
- `src/api/` — HTTP analytics and content routes. JSON is the comparison document. `format=markdown` stays the agent markdown report.
- `src/mcp/server.ts` — `list_platforms`, `get_analytics`, `get_content`.
- `src/settings/` — the settings page, the copy-for-agent tab, credential merge, and localhost OAuth.
- `src/store.ts` — SQLite credentials, masked reads, and the cross-process refresh lock.
- `src/report/` — shared types, period presets, report builders, JSON and markdown.
- `src/platforms/` — one client per platform, plus Meta insight parsing and error mapping.
- `test/` — period clamping, formatting, error mapping, refresh persistence.

A platform client implements `test`, `analytics`, and `content` in `src/platforms/client.ts`. Register a new one in the `clients` map and in `PLATFORM_IDS`.

## Report rules

These are product rules. A change that makes the JSON easier to produce by weakening them is a bug.

- Every platform block uses the same fields. Shared metric keys are `followers`, `followers_gained`, `followers_lost`, `views`, `reach`, `engagements`, and `watch_time_minutes`. Fill one only when the mapping is real.
- `aggregation` is `period_total`, `snapshot`, or `content_lifetime_sum`. Keep `source` set to the upstream metric name.
- TikTok has no period analytics. Views and engagements for a range are lifetime totals of videos published in that range. Label them `content_lifetime_sum`. Do not describe them as views during the week.
- Do not sum daily unique counts into period reach. Facebook reach comes from a range unique. If that call fails, leave `reach` in `unavailable`.
- An empty Instagram insight set is unavailable, not zero. YouTube may return no daily rows; totals of zero stay, with a note that recent days often lag.
- Instagram media, Facebook posts, and TikTok videos use `metricWindow: "lifetime"`. YouTube videos ranked by the Analytics API use `metricWindow: "period"`.
- Clamp a range the API cannot store, and say so in `period.notes`. Do not mutate a shared period object across platforms. `collectReports` runs them together.
- One platform error becomes `status: "error"` or `status: "not_configured"` with `code`, `message`, and `action`. It must not reject the whole `platforms: "all"` call.
- Markdown omits daily `series`. JSON includes series when the API returned daily points.
- Deprecated Facebook metrics (`page_fans`, `page_impressions`, and the later impression replacements) stay unrequested.

## Credentials and security

- Secrets live only in `data/`, which is gitignored. Never log tokens, put them in errors, or return them from tools or `/api/connections`.
- The settings API returns `last4` for secrets and the full value only for public ids (Page id, TikTok client key, YouTube client id).
- A blank secret on save means "keep the stored value". A newly pasted access token or refresh token clears `tokenExpiresAt`. Replacing the YouTube refresh token also clears the cached access token.
- YouTube can be saved with only the client id and secret. `refreshToken` stays null until sign-in or a pasted token. Do not call Google's token endpoint without one.
- TikTok and YouTube refresh tokens are rotated under `store.withLock`. Re-read inside the lock. If another process already replaced the failed access token, keep that replacement and do not refresh again.
- OAuth redirects are `http://127.0.0.1:<port>/oauth/<provider>/callback` and the localhost equivalent. Reject any other host.
- Instagram and Facebook stay paste-only. Do not add a Meta login button unless that flow is actually configured.

## Code

TypeScript is strict. Use `type` aliases, not interfaces. Avoid `any`. HTTP calls use `async`/`await` and the shared `requestJson` helper, which strips network failures of their URL so a token in a query string cannot leak through an error.

Platform modules may type-import `src/platforms/client.ts`. They must not import it at runtime. The client module imports the platform modules.

Add or extend a Vitest file when you change period clamping, formatting, error mapping, or token refresh. Mock `fetch`. Do not call live social APIs from tests.

After a UI change, exercise the settings page in a browser: empty save, masked secret after save, a failed test, and sign-in before client credentials exist.
