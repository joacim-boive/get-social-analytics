# Social analytics

A hosted server that gives agents current numbers from your own Instagram, Facebook, TikTok, and YouTube accounts. You sign in with Clerk, connect each account once, and an agent signs in with that same account.

The site and the MCP endpoint run on Vercel. Platform tokens live in Turso. Only the Clerk user in `ALLOWED_CLERK_EMAIL` can open them.

## Requirements

- Node.js 22 or newer
- Accounts you administer:
  - Instagram professional account
  - Facebook Page you can analyze
  - TikTok account, plus a TikTok developer app
  - YouTube channel, plus a Google Cloud OAuth client

## Run

```bash
npm install
npm start
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). Set `PORT` if you need a different port. The settings page, the JSON API, and the HTTP MCP endpoint share that port, so the redirect URIs on the TikTok and YouTube cards change with it.

Each card has the fields, a short note on where the credential comes from, **Save**, and **Test connection**. Test saves the fields, calls the platform, and shows the account name or the exact error. After a secret is saved, the field is cleared and the placeholder shows the last four characters. Leave a secret blank to keep the saved value.

**Copy for an agent** pulls the platforms and day count you choose, then shows the same JSON as `GET /api/analytics`. Copy that text and paste it into the agent.

## Connect an agent

Stdio and the settings page share the same database. Add this to Cursor, Claude Desktop, or Claude Code, and replace the path:

```json
{
  "mcpServers": {
    "social-analytics": {
      "command": "npm",
      "args": ["run", "stdio"],
      "cwd": "/absolute/path/to/get-social-analytics"
    }
  }
}
```

Agents that speak [streamable HTTP](https://modelcontextprotocol.io) use `https://get-social-analytics.vercel.app/mcp`. Add that URL and choose sign-in. Cursor, Claude, and other clients open Clerk and you approve access with the same account as the website.

Stdio writes protocol messages to stdout. Leave that stream alone if you are debugging the server.

## HTTP API

The API returns the same report as the MCP tools. A platform that is not connected, or that fails upstream, stays inside the report as `status: "error"` or `status: "not_configured"`. A bad query is HTTP 400. An unknown platform path is HTTP 404.

| Method | Path                       | What it returns                                                               |
| ------ | -------------------------- | ----------------------------------------------------------------------------- |
| `GET`  | `/api/platforms`           | Saved accounts, expiry, and capabilities. No live social call and no secrets. |
| `GET`  | `/api/analytics`           | Every platform.                                                               |
| `GET`  | `/api/analytics/:platform` | One of `instagram`, `facebook`, `tiktok`, `youtube`.                          |
| `GET`  | `/api/content`             | Ranked posts or videos for every platform.                                    |
| `GET`  | `/api/content/:platform`   | Ranked posts or videos for one platform.                                      |

`POST /api/analytics` and `POST /api/content` take the same JSON body as the matching MCP tool. A platform in the path overrides `platforms` in the body.

Query parameters match the tool arguments:

| Parameter      | Default       | Values                                                                                      |
| -------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `platforms`    | `all`         | Comma-separated ids, or `all`. Ignored when the path names one platform.                    |
| `period`       | `last_7_days` | `yesterday`, `last_7_days`, `last_28_days`, `last_90_days`, `this_month`, `last_month`      |
| `start`, `end` |               | Inclusive `YYYY-MM-DD`. Use these instead of `period`.                                      |
| `days`         |               | Whole number from 1 to 730, ending today and including today. Use this instead of `period`. |
| `include`      | `both`        | `summary`, `content`, `both`. Content routes always return content.                         |
| `contentLimit` | `10`          | `1`–`50`                                                                                    |
| `format`       | `json`        | `json`, or `markdown` (`text/markdown`, daily series omitted)                               |

```bash
curl "http://127.0.0.1:8787/api/analytics/youtube?period=last_7_days"
curl "http://127.0.0.1:8787/api/analytics?platforms=instagram,tiktok&start=2026-10-01&end=2026-10-07&include=summary"
curl -X POST "http://127.0.0.1:8787/api/content/youtube" \
  -H "Content-Type: application/json" \
  -d '{"period":{"preset":"last_28_days"},"contentLimit":5}'
```

## Tools

Call `list_platforms` first. It reports which accounts are saved, the account name, token expiry, and what a later call can and cannot answer. It does not call the social APIs and it never returns secrets.

`get_analytics` is the decision tool. `get_content` returns posts or videos only, ranked by views, then engagements.

| Argument       | Default       | Values                                                        |
| -------------- | ------------- | ------------------------------------------------------------- |
| `platforms`    | `all`         | `instagram`, `facebook`, `tiktok`, `youtube`, `all`           |
| `period`       | `last_7_days` | A preset, or `{ "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" }` |
| `format`       | `json`        | `json`, `markdown`                                            |
| `include`      | `both`        | `summary`, `content`, `both` (`get_analytics` only)           |
| `contentLimit` | `10`          | `1`–`50`                                                      |

Presets: `yesterday`, `last_7_days`, `last_28_days`, `last_90_days`, `this_month`, `last_month`. Ranges are inclusive calendar days in the timezone of the machine running the server. `last_7_days` includes today.

Markdown leaves out the daily series. JSON includes it when the platform has daily points.

One platform's failure does not fail the others. That block comes back as `status: "error"` or `status: "not_configured"` with `error.code`, `error.message`, and `error.action`.

## How to read a report

Every successful platform block has the same fields: `account`, `period.requested`, `period.applied`, `period.notes`, `summary`, optional `series`, optional `content`, and `unavailable`.

Each metric has an `aggregation` and a `source`:

- `period_total` — measured during the applied range
- `snapshot` — the current value, such as follower count right now
- `content_lifetime_sum` — lifetime totals of items published in the range

`content[].metricWindow` is `period` or `lifetime`. Read `unavailable` and `period.notes` before treating a missing value, or a zero, as a result. A platform may clamp `period.applied` when the API does not store the range you asked for.

Shared summary keys, filled only when the mapping is real:

- `followers` — current snapshot
- `followers_gained` and `followers_lost` — period totals where the API has them
- `views`, `reach`, `engagements` — period totals where the API has them
- `watch_time_minutes` — YouTube only

### What each platform can actually return

**Instagram.** Account reach, views, and engagements for about the last 90 days. Daily follower totals cover about 30 days. Media counts are lifetime totals for posts published in the range. Accounts under 100 followers often get an empty insight set. That is reported as unavailable, rather than as zero. Needs a professional account and a long-lived user token. [Token docs](https://developers.facebook.com/docs/instagram-platform/reference/access_token/).

**Facebook.** Page views, post engagements, and follow changes, plus the current follower count. Reach is included only when Facebook returns one unique count for the whole range. Daily unique counts are not added together. Post reactions, comments, and shares are lifetime totals. Use a Page access token minted from a long-lived user token, with `read_insights` and `pages_read_engagement`. Page id is optional when the token is already a Page token. [Pages docs](https://developers.facebook.com/docs/pages-api/getting-started).

**TikTok.** Current follower count, plus lifetime view, like, comment, and share counts for public videos posted in the range. TikTok's display API has no period analytics, so "last 7 days" means videos published in those 7 days. Their view totals are labeled `content_lifetime_sum`. Scopes: `user.info.basic`, `user.info.stats`, `video.list`. The access token expires in 24 hours. This server refreshes it and stores the rotated refresh token. [Login Kit](https://developers.tiktok.com/doc/login-kit-web).

**YouTube.** Period views, watch time, likes, comments, shares, and subscriber gain and loss, plus the current subscriber count. Content is ranked by activity during the range, including older videos. Analytics often omits the most recent one or two days. An API key cannot supply these reports. Scopes: `youtube.readonly` and `yt-analytics.readonly`. Enable YouTube Data API v3 and YouTube Analytics API. [Reports.query](https://developers.google.com/youtube/analytics/reference/reports/query).

## Connect TikTok and YouTube

1. Create the developer app and add the redirect URI printed on the card. With the default port those are `http://127.0.0.1:8787/oauth/tiktok/callback` and `http://127.0.0.1:8787/oauth/youtube/callback`.
2. Save the client key or client id, and the client secret. Leave YouTube's refresh token blank.
3. Use **Sign in on this computer**. Sign-in stores the YouTube refresh token.

You can paste a YouTube refresh token instead of signing in. TikTok can be pasted the same way. Instagram and Facebook stay paste-only. A long-lived token from the [Graph API Explorer](https://developers.facebook.com/tools/explorer/) is the reliable personal setup for Meta.

If Google does not return a refresh token, remove the app's access at [Google Account permissions](https://myaccount.google.com/permissions) and sign in again.

## Development

```bash
npm test
npm run typecheck
```

Tests mock `fetch`. They cover period clamping, JSON and markdown formatting, API error mapping, and TikTok and YouTube refresh persistence.

`AGENTS.md` is the working agreement for changes in this repo: where the code lives, and which report rules have to stay intact.
