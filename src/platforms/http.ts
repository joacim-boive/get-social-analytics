import { PlatformApiError } from "./errors.js";
import { isRecord } from "../util.js";

export async function requestJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new PlatformApiError(
      "network",
      timedOut ? "The platform took too long to respond." : "The platform could not be reached.",
      "Check your connection and try again.",
    );
  }

  const text = await response.text();
  if (!text) return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, body: { raw: text.slice(0, 300) } };
  }
}

export function formBody(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

export function nestedRecord(body: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  const value = body[key];
  return isRecord(value) ? value : null;
}
