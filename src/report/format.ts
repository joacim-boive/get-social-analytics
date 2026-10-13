import type { AnalyticsReport, ContentItem, Metric, PlatformReport, ReportFormat } from "./types.js";
import { platformLabel } from "./types.js";

export function formatReport(report: AnalyticsReport, format: ReportFormat): string {
  if (format === "markdown") return formatMarkdown(report);
  return JSON.stringify(report, null, 2);
}

function formatMarkdown(report: AnalyticsReport): string {
  const lines: string[] = [`# Social analytics`, `Generated ${report.generatedAt}`, ""];
  for (const platform of report.platforms) {
    lines.push(...formatPlatform(platform), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function formatPlatform(platform: PlatformReport): string[] {
  const title = platform.account?.handle
    ? `${platformLabel(platform.platform)} — @${platform.account.handle.replace(/^@/, "")}`
    : platform.account?.name
      ? `${platformLabel(platform.platform)} — ${platform.account.name}`
      : platformLabel(platform.platform);
  const lines = [`## ${title}`, `Status: ${platform.status}`];
  if (platform.period) {
    lines.push(`Period: ${platform.period.applied.start} to ${platform.period.applied.end}`);
    for (const note of platform.period.notes) lines.push(`Note: ${note}`);
  }
  if (platform.error) {
    lines.push(`Error: ${platform.error.message}`, `Action: ${platform.error.action}`);
  }
  if (platform.summary && platform.summary.length > 0) {
    lines.push("", "### Summary");
    for (const item of platform.summary) lines.push(`- ${formatMetric(item)}`);
  }
  if (platform.content && platform.content.length > 0) {
    lines.push("", "### Top content");
    platform.content.forEach((item, index) => {
      lines.push(`${index + 1}. ${formatContent(item)}`);
    });
  }
  if (platform.unavailable && platform.unavailable.length > 0) {
    lines.push("", "### Unavailable");
    for (const item of platform.unavailable) lines.push(`- ${item.key}: ${item.reason}`);
  }
  return lines;
}

function formatMetric(item: Metric): string {
  const value = item.value === null ? "unknown" : item.value.toLocaleString("en-US");
  return `${item.label}: ${value} ${item.unit} (${aggregationLabel(item.aggregation)}, source: ${item.source})`;
}

function formatContent(item: ContentItem): string {
  const stats = item.metrics.map((entry) => `${entry.key} ${entry.value === null ? "unknown" : entry.value.toLocaleString("en-US")}`).join(", ");
  const link = item.url ? ` ${item.url}` : "";
  const when = item.publishedAt ? ` published ${item.publishedAt}` : "";
  return `${item.title} — ${stats} (${item.metricWindow})${when}${link}`;
}

function aggregationLabel(aggregation: Metric["aggregation"]): string {
  if (aggregation === "period_total") return "period total";
  if (aggregation === "period_average") return "period average";
  if (aggregation === "snapshot") return "snapshot";
  return "lifetime sum of items in range";
}
