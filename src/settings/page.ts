import type { PlatformId } from "../report/types.js";
import { platformLabel } from "../report/types.js";
import { escapeHtml } from "../util.js";
import { PLATFORM_FIELDS } from "./fields.js";
import type { PublicConnection } from "./public.js";

export type PageNotice = {
  tone: "ok" | "error";
  text: string;
};

const HELP: Record<PlatformId, { summary: string; docs: string }> = {
  instagram: {
    summary:
      "Paste a long-lived token for your professional Instagram account, plus the app secret from the same Meta app. The secret is used to exchange a short-lived token and to refresh the long-lived one before the 60-day expiry. Host: graph.instagram.com.",
    docs: "https://developers.facebook.com/docs/instagram-platform/reference/access_token/",
  },
  facebook: {
    summary:
      "Paste a Page access token for a Page you can ANALYZE. Mint it from a long-lived user token so it does not expire in an hour. The token needs read_insights and pages_read_engagement. Leave Page id blank if the token is already a Page token.",
    docs: "https://developers.facebook.com/docs/pages-api/getting-started",
  },
  tiktok: {
    summary:
      "Save the client key and secret, register the redirect below on the TikTok app, then use Sign in. Scopes: user.info.basic, user.info.stats, video.list. Access tokens expire in 24 hours; this server refreshes them and stores the rotated refresh token.",
    docs: "https://developers.tiktok.com/doc/login-kit-web",
  },
  youtube: {
    summary:
      "Enable YouTube Data API v3 and YouTube Analytics API. Create an OAuth client, register the redirect below, then save the client id and secret. Leave the refresh token blank and use Sign in. That sign-in stores the refresh token. Scopes: youtube.readonly and yt-analytics.readonly.",
    docs: "https://developers.google.com/youtube/analytics/reference/reports/query",
  },
};

export function renderSettingsPage(args: {
  origin: string;
  connections: PublicConnection[];
  notice: PageNotice | null;
  viewer?: string | null;
  publishableKey?: string | null;
}): string {
  const cards = args.connections
    .map((connection) => renderCard(connection, args.origin))
    .join("");
  const notice = args.notice
    ? `<p class="notice ${args.notice.tone}" role="status">${escapeHtml(args.notice.text)}</p>`
    : "";
  const boot = JSON.stringify(args.connections).replaceAll("<", "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Social analytics</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,560;9..144,650&family=Familjen+Grotesk:wght@420;560;650&family=IBM+Plex+Mono:wght@400&display=swap" rel="stylesheet" />
  <style>
    :root {
      --paper: #f3ecdf;
      --ink: #1c1712;
      --muted: #6f655c;
      --line: #ddcfc0;
      --card: #fffaf3;
      --stamp: #9d1c1c;
      --ok: #1d6b45;
      --shadow: 0 18px 50px rgba(48, 32, 16, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(157, 28, 28, 0.08), transparent 32%),
        repeating-linear-gradient(-12deg, transparent, transparent 22px, rgba(28, 23, 18, 0.03) 23px),
        var(--paper);
      font-family: "Familjen Grotesk", "Avenir Next", sans-serif;
      font-size: 16px;
      line-height: 1.45;
    }
    .shell {
      display: grid;
      grid-template-columns: minmax(240px, 320px) minmax(0, 760px);
      gap: 48px;
      max-width: 1160px;
      margin: 0 auto;
      padding: 48px 28px 80px;
    }
    .intro { position: sticky; top: 28px; align-self: start; }
    .kicker {
      margin: 0 0 12px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-size: 12px;
      color: var(--stamp);
    }
    h1 {
      margin: 0;
      font-family: Fraunces, "Iowan Old Style", Palatino, serif;
      font-size: clamp(44px, 6vw, 68px);
      font-weight: 560;
      letter-spacing: -0.04em;
      line-height: 0.92;
    }
    .lede { margin: 18px 0 0; color: var(--muted); max-width: 34ch; }
    .endpoint {
      margin-top: 28px;
      padding-top: 18px;
      border-top: 1px solid var(--line);
      font-size: 14px;
    }
    .endpoint code { display: block; margin-top: 8px; }
    .endpoint code, .docs code {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 12px;
      word-break: break-all;
    }
    .cards { display: grid; gap: 18px; }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 18px;
      box-shadow: var(--shadow);
      padding: 22px 22px 18px;
      animation: rise 0.45s ease both;
    }
    .card:nth-child(2) { animation-delay: 0.05s; }
    .card:nth-child(3) { animation-delay: 0.1s; }
    .card:nth-child(4) { animation-delay: 0.15s; }
    .card-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    h2 {
      margin: 0;
      font-family: Fraunces, Palatino, serif;
      font-size: 32px;
      font-weight: 560;
      letter-spacing: -0.03em;
    }
    .pill {
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      border: 1px solid var(--line);
      color: var(--muted);
      white-space: nowrap;
    }
    .pill.ok { color: var(--ok); border-color: rgba(29, 107, 69, 0.35); }
    .pill.bad { color: var(--stamp); border-color: rgba(157, 28, 28, 0.35); }
    .account { margin: 8px 0 0; color: var(--muted); min-height: 1.2em; }
    details { margin: 14px 0; }
    summary { cursor: pointer; color: var(--stamp); }
    .docs { color: var(--muted); font-size: 14px; }
    .docs a { color: var(--ink); }
    label { display: block; margin: 12px 0 6px; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; }
    input {
      width: 100%;
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 10px;
      padding: 12px 12px;
      font: inherit;
      color: var(--ink);
    }
    input:focus { outline: 2px solid rgba(157, 28, 28, 0.35); border-color: var(--stamp); }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 16px; }
    button, .text-button {
      border-radius: 999px;
      padding: 10px 16px;
      font: inherit;
      cursor: pointer;
      text-decoration: none;
    }
    button.primary { background: var(--ink); color: var(--paper); border: 1px solid var(--ink); }
    button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--ink); }
    button.text-button { background: transparent; border: 0; color: var(--stamp); padding-left: 4px; }
    .result { min-height: 1.2em; margin: 12px 0 0; font-size: 14px; }
    .result.error { color: var(--stamp); }
    .result.ok { color: var(--ok); }
    .tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 18px; }
    button.tab { background: transparent; color: var(--muted); border: 1px solid transparent; padding: 8px 14px; }
    button.tab.is-active { color: var(--ink); background: var(--card); border-color: var(--ink); }
    .choices { border: 0; margin: 14px 0 0; padding: 0; }
    .choices legend { padding: 0; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; }
    .choice-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .choice {
      position: relative;
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 8px 14px;
      background: #fff;
      cursor: pointer;
    }
    .choice input { position: absolute; opacity: 0; width: 1px; height: 1px; }
    .choice:has(input:checked) { background: var(--ink); color: var(--paper); border-color: var(--ink); }
    .choice:has(input:focus-visible) { outline: 2px solid rgba(157, 28, 28, 0.35); }
    .day-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .day-row input { width: 96px; }
    button.day-pick { background: #fff; color: var(--ink); border: 1px solid var(--line); padding: 10px 14px; }
    button.day-pick.is-active { background: var(--ink); color: var(--paper); border-color: var(--ink); }
    .hint { margin: 8px 0 0; color: var(--muted); font-size: 14px; }
    textarea.report {
      width: 100%;
      min-height: 320px;
      margin-top: 16px;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 13px;
      line-height: 1.5;
      background: #fffdf8;
      color: var(--ink);
      resize: vertical;
    }
    .notice { margin: 0 0 16px; padding: 12px 14px; border-radius: 12px; background: var(--card); border: 1px solid var(--line); }
    .notice.error { color: var(--stamp); }
    .notice.ok { color: var(--ok); }
    @keyframes rise {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: none; }
    }
    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; padding-top: 28px; }
      .intro { position: static; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="intro">
      <p class="kicker">Private ledger</p>
      <h1>Social analytics</h1>
      <p class="lede">Connect your accounts once. An agent signs in with this same account and gets one report shape for every platform.</p>
      <div class="endpoint">
        <div>${args.viewer ? `Signed in as ${escapeHtml(args.viewer)}` : "Signed in"}</div>
        <code>MCP ${escapeHtml(args.origin)}/mcp</code>
        <code>API ${escapeHtml(args.origin)}/api/analytics</code>
        ${args.publishableKey ? `<button class="text-button" type="button" id="sign-out">Sign out</button>` : ""}
      </div>
    </header>
    <section class="workspace">
      <div class="tabs" role="tablist" aria-label="Sections">
        <button class="tab is-active" type="button" role="tab" id="tab-connections" aria-selected="true" aria-controls="panel-connections" data-tab="connections">Connections</button>
        <button class="tab" type="button" role="tab" id="tab-report" aria-selected="false" aria-controls="panel-report" data-tab="report">Copy for an agent</button>
      </div>
      <div id="panel-connections" role="tabpanel" aria-labelledby="tab-connections">
        ${notice}
        <div class="cards">${cards}</div>
      </div>
      <div id="panel-report" role="tabpanel" aria-labelledby="tab-report" hidden>
        ${renderReportPanel(args.connections)}
      </div>
    </section>
  </main>
  ${clerkScript(args.publishableKey ?? null)}
  <script>
    const signOut = document.getElementById("sign-out");
    if (signOut) {
      signOut.addEventListener("click", async () => {
        if (!window.Clerk) return;
        await window.Clerk.load();
        await window.Clerk.signOut({ redirectUrl: window.location.origin + "/" });
      });
    }
    const initial = ${boot};
    const forms = document.querySelectorAll("form[data-platform]");
    for (const form of forms) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const submitter = event.submitter;
        const action = submitter && submitter.dataset.action === "test" ? "test" : "save";
        const platform = form.dataset.platform;
        const result = form.querySelector(".result");
        result.textContent = action === "test" ? "Saving and testing…" : "Saving…";
        result.className = "result";
        try {
          const response = await fetch(action === "test" ? "/api/connections/" + platform + "/test" : "/api/connections/" + platform, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(formPayload(form)),
          });
          const data = await response.json();
          if (data.connection) applyConnection(form, data.connection);
          result.textContent = data.message || (data.ok === false ? "Something went wrong." : "Saved.");
          result.className = "result " + (data.ok === false || !response.ok ? "error" : "ok");
        } catch (error) {
          result.textContent = "The settings server did not respond.";
          result.className = "result error";
        }
      });
      const signIn = form.querySelector("[data-action=signin]");
      if (!signIn) continue;
      signIn.addEventListener("click", async () => {
        const result = form.querySelector(".result");
        result.textContent = "Saving, then opening sign-in…";
        result.className = "result";
        try {
          const response = await fetch("/api/connections/" + form.dataset.platform, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(formPayload(form)),
          });
          const data = await response.json();
          if (data.connection) applyConnection(form, data.connection);
          if (!response.ok || data.ok === false) {
            result.textContent = data.message || "Save the client id and secret before signing in.";
            result.className = "result error";
            return;
          }
          window.location.href = "/oauth/" + form.dataset.platform + "/start";
        } catch (error) {
          result.textContent = "The settings server did not respond.";
          result.className = "result error";
        }
      });
    }

    function formPayload(form) {
      const payload = {};
      for (const element of form.elements) {
        if (!element.name || element.type === "submit" || element.type === "button") continue;
        payload[element.name] = element.value;
      }
      return payload;
    }

    const tabButtons = document.querySelectorAll("[data-tab]");
    for (const button of tabButtons) {
      button.addEventListener("click", () => showTab(button.dataset.tab));
    }

    function showTab(name) {
      for (const button of tabButtons) {
        const selected = button.dataset.tab === name;
        button.classList.toggle("is-active", selected);
        button.setAttribute("aria-selected", selected ? "true" : "false");
      }
      document.getElementById("panel-connections").hidden = name !== "connections";
      document.getElementById("panel-report").hidden = name !== "report";
    }

    const reportForm = document.getElementById("report-form");
    const daysInput = document.getElementById("days");
    const reportText = document.getElementById("report-text");
    const copyButton = document.getElementById("copy-report");
    const reportStatus = document.getElementById("report-status");
    const dayPicks = document.querySelectorAll("[data-days]");

    for (const pick of dayPicks) {
      pick.addEventListener("click", () => {
        daysInput.value = pick.dataset.days;
        syncDayPicks();
      });
    }
    daysInput.addEventListener("input", syncDayPicks);
    syncDayPicks();

    reportForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const selected = [];
      for (const box of reportForm.querySelectorAll("input[name=platform]:checked")) selected.push(box.value);
      const days = Number(daysInput.value);
      if (selected.length === 0) {
        reportStatus.textContent = "Choose at least one platform.";
        reportStatus.className = "result error";
        return;
      }
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        reportStatus.textContent = "Days must be a whole number from 1 to 365.";
        reportStatus.className = "result error";
        return;
      }
      reportStatus.textContent = "Pulling the report…";
      reportStatus.className = "result";
      copyButton.disabled = true;
      try {
        const params = new URLSearchParams({
          platforms: selected.join(","),
          days: String(days),
          include: "both",
          contentLimit: "30",
        });
        const response = await fetch("/api/analytics?" + params.toString());
        const data = await response.json();
        if (!response.ok) {
          reportStatus.textContent = data.error || "The report could not be built.";
          reportStatus.className = "result error";
          return;
        }
        reportText.value = JSON.stringify(data, null, 2);
        copyButton.disabled = false;
        reportStatus.textContent = "Ready to paste.";
        reportStatus.className = "result ok";
      } catch (error) {
        reportStatus.textContent = "The settings server did not respond.";
        reportStatus.className = "result error";
      }
    });

    copyButton.addEventListener("click", async () => {
      if (!reportText.value) return;
      try {
        await navigator.clipboard.writeText(reportText.value);
        reportStatus.textContent = "Copied. Paste it into the agent.";
        reportStatus.className = "result ok";
      } catch (error) {
        reportText.focus();
        reportText.select();
        reportStatus.textContent = "Clipboard is blocked. The report is selected — copy it from there.";
        reportStatus.className = "result error";
      }
    });

    function syncDayPicks() {
      for (const pick of dayPicks) pick.classList.toggle("is-active", pick.dataset.days === daysInput.value);
    }

    function applyConnection(form, connection) {
      const pill = form.querySelector(".pill");
      const account = form.querySelector(".account");
      pill.textContent = connection.account ? "Connected" : connection.configured ? "Saved" : "Not connected";
      pill.className = "pill" + (connection.account ? " ok" : "");
      const handle = connection.account && connection.account.handle ? " @" + connection.account.handle.replace(/^@/, "") : "";
      const expiry = connection.tokenExpiresAt ? " · token until " + connection.tokenExpiresAt.slice(0, 10) : "";
      account.textContent = connection.account ? connection.account.name + handle + expiry : expiry;
      for (const [name, field] of Object.entries(connection.fields)) {
        const input = form.elements.namedItem(name);
        if (!input) continue;
        if (field.publicValue) {
          input.value = field.publicValue;
          continue;
        }
        input.value = "";
        const emptyHint = input.dataset.emptyHint || "Paste value";
        input.placeholder = field.set && field.last4 ? "Saved · ends in " + field.last4 : emptyHint;
      }
    }
  </script>
</body>
</html>`;
}

function clerkScript(publishableKey: string | null): string {
  if (!publishableKey) return "";
  const encoded = publishableKey.replace(/^pk_(test|live)_/, "");
  const frontendApi = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
  const src = `https://${frontendApi}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`;
  return `<script async crossorigin="anonymous" data-clerk-publishable-key="${escapeHtml(publishableKey)}" src="${escapeHtml(src)}"></script>`;
}

function renderReportPanel(connections: PublicConnection[]): string {
  const anyConfigured = connections.some((connection) => connection.configured);
  const choices = connections
    .map((connection) => {
      const checked = !anyConfigured || connection.configured ? " checked" : "";
      return `<label class="choice"><input type="checkbox" name="platform" value="${connection.platform}"${checked} />${platformLabel(connection.platform)}</label>`;
    })
    .join("");
  return `<form class="card" id="report-form">
    <h2>Copy for an agent</h2>
    <p class="docs">Choose the accounts and how many days. The text below is the same JSON as <code>/api/analytics</code>.</p>
    <fieldset class="choices">
      <legend>Platforms</legend>
      <div class="choice-row">${choices}</div>
    </fieldset>
    <label for="days">Days</label>
    <div class="day-row">
      <input id="days" name="days" type="number" inputmode="numeric" min="1" max="365" value="30" />
      <button class="day-pick" type="button" data-days="7">7</button>
      <button class="day-pick" type="button" data-days="30">30</button>
      <button class="day-pick" type="button" data-days="28">28</button>
      <button class="day-pick" type="button" data-days="90">90</button>
    </div>
    <p class="hint">Includes today. A platform that cannot store the whole range says so in the report.</p>
    <div class="actions">
      <button class="primary" type="submit">Pull report</button>
      <button class="secondary" type="button" id="copy-report" disabled>Copy</button>
    </div>
    <p class="result" id="report-status" aria-live="polite"></p>
    <textarea class="report" id="report-text" readonly spellcheck="false" placeholder="The report will land here, ready to paste."></textarea>
  </form>`;
}

function renderCard(connection: PublicConnection, origin: string): string {
  const platform = connection.platform;
  const help = HELP[platform];
  const status = connection.account
    ? "Connected"
    : connection.configured
      ? "Saved"
      : "Not connected";
  const pillClass = connection.account ? "pill ok" : "pill";
  const handle = connection.account?.handle
    ? ` @${connection.account.handle.replace(/^@/, "")}`
    : "";
  const expiry = connection.tokenExpiresAt
    ? ` · token until ${connection.tokenExpiresAt.slice(0, 10)}`
    : "";
  const accountLine = connection.account
    ? `${connection.account.name}${handle}${expiry}`
    : expiry;
  const fields = PLATFORM_FIELDS[platform]
    .map((field) => {
      const state = connection.fields[field.name];
      const placeholder = field.secret
        ? state?.set && state.last4
          ? `Saved · ends in ${state.last4}`
          : (field.emptyHint ?? "Paste value")
        : "";
      const value =
        !field.secret && state?.publicValue
          ? ` value="${escapeHtml(state.publicValue)}"`
          : "";
      const type = field.secret ? "password" : "text";
      const emptyHint = field.emptyHint
        ? ` data-empty-hint="${escapeHtml(field.emptyHint)}"`
        : "";
      return `<label for="${platform}-${field.name}">${escapeHtml(field.label)}</label>
        <input id="${platform}-${field.name}" name="${field.name}" type="${type}" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(placeholder)}"${value}${emptyHint} />`;
    })
    .join("");
  const redirect =
    platform === "tiktok" || platform === "youtube"
      ? `<p class="docs">Redirect URI<br /><code>${escapeHtml(`${origin}/oauth/${platform}/callback`)}</code></p>`
      : "";
  const signIn =
    platform === "tiktok" || platform === "youtube"
      ? `<button class="text-button" type="button" data-action="signin">Sign in</button>`
      : "";
  return `<form class="card" data-platform="${platform}">
    <div class="card-head">
      <h2>${platformLabel(platform)}</h2>
      <span class="${pillClass}">${status}</span>
    </div>
    <p class="account">${escapeHtml(accountLine)}</p>
    <details>
      <summary>Where this comes from</summary>
      <p class="docs">${escapeHtml(help.summary)} <a href="${help.docs}">Official docs</a></p>
      ${redirect}
    </details>
    ${fields}
    <div class="actions">
      <button class="secondary" type="submit" data-action="save">Save</button>
      <button class="primary" type="submit" data-action="test">Test connection</button>
      ${signIn}
    </div>
    <p class="result" aria-live="polite"></p>
  </form>`;
}
