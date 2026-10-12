import { asNumber, isRecord, readString } from "../util.js";

export class PlatformApiError extends Error {
  readonly code: string;
  readonly action: string;
  readonly status: number | null;

  constructor(
    code: string,
    message: string,
    action: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = "PlatformApiError";
    this.code = code;
    this.action = action;
    this.status = status;
  }
}

export function mapMetaError(body: unknown, status: number): PlatformApiError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = error ? asNumber(error.code) : null;
  const message =
    error && typeof error.message === "string"
      ? error.message
      : `Meta API returned ${status}.`;
  if (code === 190 || status === 401) {
    return new PlatformApiError(
      "token_invalid",
      message,
      "Open the settings page and paste a new access token.",
      status,
    );
  }
  if (code === 200 || status === 403) {
    return new PlatformApiError(
      "permission_denied",
      message,
      "Regenerate the token with the permissions listed on the settings page.",
      status,
    );
  }
  if (
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 80001 ||
    status === 429
  ) {
    return new PlatformApiError(
      "rate_limited",
      message,
      "Wait a minute and call the tool again.",
      status,
    );
  }
  if (code === 100) {
    return new PlatformApiError(
      "invalid_metric",
      message,
      "This metric is not available for the account or media type.",
      status,
    );
  }
  return new PlatformApiError(
    "api_error",
    message,
    "Check the token on the settings page, then try again.",
    status,
  );
}

export function mapTikTokError(
  body: unknown,
  status: number,
): PlatformApiError {
  const nested = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code =
    (nested ? readString(nested, "code") : null) ??
    (isRecord(body) ? readString(body, "error") : null) ??
    "";
  const message =
    (nested ? readString(nested, "message") : null) ??
    (isRecord(body) ? readString(body, "error_description") : null) ??
    `TikTok API returned ${status}.`;
  if (code === "scope_not_authorized") {
    return new PlatformApiError(
      "permission_denied",
      message,
      "Reconnect TikTok and approve user.info.basic, user.info.stats, and video.list.",
      status,
    );
  }
  if (
    code === "access_token_invalid" ||
    code === "access_token_expired" ||
    code === "invalid_grant" ||
    status === 401
  ) {
    return new PlatformApiError(
      "token_invalid",
      message,
      "TikTok rejected the token. Sign in again on the settings page if a refresh does not clear this.",
      status,
    );
  }
  if (status === 403) {
    return new PlatformApiError(
      "permission_denied",
      message,
      "Reconnect TikTok and approve user.info.basic, user.info.stats, and video.list.",
      status,
    );
  }
  if (code === "rate_limit_exceeded" || status === 429) {
    return new PlatformApiError(
      "rate_limited",
      message,
      "Wait a minute and call the tool again.",
      status,
    );
  }
  return new PlatformApiError(
    "api_error",
    message,
    "Test the TikTok connection on the settings page, then try again.",
    status,
  );
}

export function mapGoogleError(
  body: unknown,
  status: number,
): PlatformApiError {
  const message = googleMessage(body) ?? `YouTube API returned ${status}.`;
  const reason = googleReason(body);
  if (
    status === 401 ||
    reason === "authError" ||
    reason === "invalid_grant" ||
    reason === "invalidCredentials"
  ) {
    return new PlatformApiError(
      "token_invalid",
      message,
      "Sign in to YouTube again on the settings page.",
      status,
    );
  }
  if (
    status === 403 &&
    (reason === "insufficientPermissions" ||
      reason === "forbidden" ||
      message.toLowerCase().includes("scope"))
  ) {
    return new PlatformApiError(
      "permission_denied",
      message,
      "Reconnect YouTube and grant youtube.readonly and yt-analytics.readonly.",
      status,
    );
  }
  if (
    status === 403 &&
    (reason === "quotaExceeded" ||
      reason === "dailyLimitExceeded" ||
      reason === "rateLimitExceeded")
  ) {
    return new PlatformApiError(
      "rate_limited",
      message,
      "YouTube quota is exhausted. Try again later.",
      status,
    );
  }
  return new PlatformApiError(
    "api_error",
    message,
    "Test the YouTube connection on the settings page, then try again.",
    status,
  );
}

function googleMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (typeof body.error_description === "string") return body.error_description;
  if (!isRecord(body.error))
    return typeof body.error === "string" ? body.error : null;
  return typeof body.error.message === "string" ? body.error.message : null;
}

function googleReason(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (typeof body.error === "string") return body.error;
  if (!isRecord(body.error) || !Array.isArray(body.error.errors)) return null;
  const first = body.error.errors[0];
  if (!isRecord(first) || typeof first.reason !== "string") return null;
  return first.reason;
}
