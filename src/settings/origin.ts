import { SettingsError } from "./save.js";

export function productionOrigin(): string {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return `https://${vercel}`;
  return "https://get-social-analytics.vercel.app";
}

export function requestOrigin(requestUrl: string, headers: Headers): string {
  const forwardedHost = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  if (forwardedHost) return `${forwardedProto || "https"}://${forwardedHost}`;
  try {
    const url = new URL(requestUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return productionOrigin();
  }
}

export function isAllowedOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.pathname !== "" && url.pathname !== "/") return false;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return url.protocol === "http:" || url.protocol === "https:";
  }
  if (url.protocol !== "https:") return false;
  if (origin === productionOrigin()) return true;
  const vercelUrl = process.env.VERCEL_URL?.trim();
  return Boolean(vercelUrl) && url.host === vercelUrl;
}

export function assertAllowedOrigin(origin: string): void {
  if (!isAllowedOrigin(origin)) {
    throw new SettingsError("Sign-in is only available on the hosted site.");
  }
}
