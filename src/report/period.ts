import type { PeriodPreset, PeriodRequest, ResolvedPeriod } from "./types.js";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export class PeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeriodError";
  }
}

export function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseIsoDate(value: string): Date {
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new PeriodError("Dates must be YYYY-MM-DD.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new PeriodError(`Invalid date: ${value}`);
  }
  return date;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

export function daysBefore(isoDate: string, days: number): string {
  return formatIsoDate(addDays(parseIsoDate(isoDate), -days));
}

export function startOfLocalDay(isoDate: string): Date {
  return parseIsoDate(isoDate);
}

export function periodUnixRange(period: { start: string; end: string }): { since: number; until: number } {
  const since = startOfLocalDay(period.start);
  const until = addDays(startOfLocalDay(period.end), 1);
  return {
    since: Math.floor(since.getTime() / 1000),
    until: Math.floor(until.getTime() / 1000),
  };
}

export function localDateFromIso(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatIsoDate(date);
}

export function isWithinPeriod(publishedAt: string, period: { start: string; end: string }): boolean {
  const day = localDateFromIso(publishedAt);
  if (!day) return false;
  return day >= period.start && day <= period.end;
}

export function resolvePeriod(request: PeriodRequest, now = new Date()): ResolvedPeriod {
  if ("preset" in request) {
    const range = rangeForPreset(request.preset, now);
    return { requested: request, ...range, notes: [] };
  }

  const start = formatIsoDate(parseIsoDate(request.start));
  const end = formatIsoDate(parseIsoDate(request.end));
  if (start > end) throw new PeriodError("period.start must be on or before period.end.");
  return { requested: { start, end }, start, end, notes: [] };
}

export function clampLookback(period: ResolvedPeriod, earliestStart: string, note: string): ResolvedPeriod {
  if (period.start >= earliestStart && period.end >= earliestStart) return period;
  const start = period.start < earliestStart ? earliestStart : period.start;
  const end = period.end < earliestStart ? earliestStart : period.end;
  const outside = period.end < earliestStart;
  const notes = [...period.notes, outside ? `${note} The requested range is older than that, so only the oldest available day was applied.` : note];
  return { ...period, start, end, notes };
}

function rangeForPreset(preset: PeriodPreset, now: Date): { start: string; end: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (preset === "yesterday") {
    const day = formatIsoDate(addDays(today, -1));
    return { start: day, end: day };
  }
  if (preset === "last_7_days") {
    return { start: formatIsoDate(addDays(today, -6)), end: formatIsoDate(today) };
  }
  if (preset === "last_28_days") {
    return { start: formatIsoDate(addDays(today, -27)), end: formatIsoDate(today) };
  }
  if (preset === "last_90_days") {
    return { start: formatIsoDate(addDays(today, -89)), end: formatIsoDate(today) };
  }
  if (preset === "this_month") {
    return {
      start: formatIsoDate(new Date(today.getFullYear(), today.getMonth(), 1)),
      end: formatIsoDate(today),
    };
  }
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
  return { start: formatIsoDate(lastMonthStart), end: formatIsoDate(lastMonthEnd) };
}
