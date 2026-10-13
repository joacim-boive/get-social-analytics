import type { AnalyticsArgs } from "../platforms/client.js";
import { periodForDays } from "../report/period.js";
import type {
  IncludeMode,
  PeriodPreset,
  PeriodRequest,
  PlatformId,
  ReportFormat,
} from "../report/types.js";
import { isPlatformId, PERIOD_PRESETS } from "../report/types.js";
import { isRecord, readString } from "../util.js";

export class ApiQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiQueryError";
  }
}

export function argsFromQuery(
  query: Record<string, string | undefined>,
  pathPlatform: string | undefined,
): AnalyticsArgs {
  return {
    platforms: readPlatforms(
      pathPlatform ?? query.platforms,
      pathPlatform !== undefined,
    ),
    period: readQueryPeriod(query.period, query.start, query.end, query.days),
    include: query.include ? readInclude(query.include) : undefined,
    format: query.format ? readFormat(query.format) : undefined,
    contentLimit: query.contentLimit
      ? readLimit(query.contentLimit)
      : undefined,
  };
}

export function argsFromBody(
  body: unknown,
  pathPlatform: string | undefined,
): AnalyticsArgs {
  if (body === undefined || body === null || body === "") {
    return {
      platforms: pathPlatform ? readPlatforms(pathPlatform, true) : undefined,
    };
  }
  if (!isRecord(body))
    throw new ApiQueryError("The request body must be a JSON object.");
  return {
    platforms: pathPlatform
      ? readPlatforms(pathPlatform, true)
      : readBodyPlatforms(body.platforms),
    period: readBodyTiming(body),
    include:
      body.include === undefined
        ? undefined
        : readInclude(requireText(body.include, "include")),
    format:
      body.format === undefined
        ? undefined
        : readFormat(requireText(body.format, "format")),
    contentLimit: readLimitValue(body.contentLimit),
  };
}

function readQueryPeriod(
  period: string | undefined,
  start: string | undefined,
  end: string | undefined,
  days: string | undefined,
): PeriodRequest | undefined {
  const dayCount = readDayCount(days);
  const hasRange = Boolean(start || end);
  const chosen = [Boolean(period), hasRange, dayCount !== undefined].filter(
    Boolean,
  ).length;
  if (chosen > 1)
    throw new ApiQueryError("Use one of days, period, or start and end.");
  if (dayCount !== undefined) return periodForDays(dayCount);
  if (hasRange) {
    if (!start || !end)
      throw new ApiQueryError("start and end are both required.");
    return { start, end };
  }
  if (!period) return undefined;
  return { preset: readPreset(period) };
}

function readBodyTiming(
  body: Record<string, unknown>,
): PeriodRequest | undefined {
  const dayCount = readDayCount(body.days);
  if (dayCount !== undefined && body.period !== undefined) {
    throw new ApiQueryError("Use one of days or period.");
  }
  if (dayCount !== undefined) return periodForDays(dayCount);
  return readBodyPeriod(body.period);
}

function readDayCount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim()))
    return Number(value.trim());
  throw new ApiQueryError("days must be a whole number from 1 to 730.");
}

function readBodyPeriod(value: unknown): PeriodRequest | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value))
    throw new ApiQueryError("period must be a preset or a start and end date.");
  const preset = readString(value, "preset");
  const start = readString(value, "start");
  const end = readString(value, "end");
  if (preset && (start || end))
    throw new ApiQueryError(
      "Use either period.preset or period.start and period.end.",
    );
  if (preset) return { preset: readPreset(preset) };
  if (!start || !end)
    throw new ApiQueryError("period.start and period.end are required.");
  return { start, end };
}

function readBodyPlatforms(value: unknown): AnalyticsArgs["platforms"] {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    const names = value.map((entry) => requireText(entry, "platforms"));
    return readPlatforms(names.join(","), false);
  }
  return readPlatforms(requireText(value, "platforms"), false);
}

function readPlatforms(
  value: string | undefined,
  fromPath: boolean,
): AnalyticsArgs["platforms"] {
  const text = value?.trim() ?? "";
  if (!text || text === "all") return text === "all" ? "all" : undefined;
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.includes("all"))
    throw new ApiQueryError("platforms cannot mix all with a named platform.");
  const platforms: PlatformId[] = [];
  for (const part of parts) {
    if (!isPlatformId(part)) {
      throw new ApiQueryError(
        fromPath ? "Unknown platform." : `Unknown platform: ${part}.`,
      );
    }
    if (!platforms.includes(part)) platforms.push(part);
  }
  if (platforms.length === 0) return undefined;
  const only = platforms[0];
  return platforms.length === 1 && only ? only : platforms;
}

function readPreset(value: string): PeriodPreset {
  if ((PERIOD_PRESETS as readonly string[]).includes(value))
    return value as PeriodPreset;
  throw new ApiQueryError(`Unknown period: ${value}.`);
}

function readInclude(value: string): IncludeMode {
  if (value === "summary" || value === "content" || value === "both")
    return value;
  throw new ApiQueryError("include must be summary, content, or both.");
}

function readFormat(value: string): ReportFormat {
  if (value === "json" || value === "markdown") return value;
  throw new ApiQueryError("format must be json or markdown.");
}

function readLimit(value: string): number {
  return readLimitValue(value) ?? 10;
}

function readLimitValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim()))
    return Number(value.trim());
  throw new ApiQueryError("contentLimit must be a whole number from 1 to 50.");
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new ApiQueryError(`${field} must be text.`);
  return value.trim();
}
