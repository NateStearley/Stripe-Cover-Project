import type { ProjectPolicy } from "../../../src/profile/schema.js";
import { UNCATEGORIZED } from "../../../src/profile/categories.js";

export function centsToDollarsInput(cents: number): string {
  return (cents / 100).toFixed(2).replace(/\.00$/, "");
}

/** Parses "$1,234.5" → 123450. Returns null for blanks or anything that isn't a positive amount. */
export function dollarsInputToCents(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return cents > 0 ? cents : null;
}

export function formatDollars(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function formatClock(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour}${suffix}` : `${hour}:${String(m).padStart(2, "0")}${suffix}`;
}

/** "7 days", "1 day 12 hours", "6 hours". */
export function formatWindow(days: number, hours: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const parts = [days > 0 ? plural(days, "day") : "", hours > 0 ? plural(hours, "hour") : ""].filter(Boolean);
  return parts.join(" ") || "0 hours";
}

/** One plain-English sentence per rule, for the summary panel. */
export function describeProject(p: ProjectPolicy): string[] {
  const lines = [
    `Up to ${formatDollars(p.per_transaction_cap_cents)} per purchase and ${formatDollars(p.daily_cap_cents)} in the past 24 hours.`,
  ];
  if (p.recent_purchases_cap) {
    const { window_days, window_hours, max_total_cents } = p.recent_purchases_cap;
    lines.push(`No more than ${formatDollars(max_total_cents)} in any ${formatWindow(window_days, window_hours)}.`);
  }
  const categories = p.blocked_categories.filter((c) => c !== UNCATEGORIZED);
  if (categories.length > 0) lines.push(`Never buys: ${categories.join(", ")}.`);
  if (p.blocked_categories.includes(UNCATEGORIZED)) lines.push("Blocks merchants it can't categorize.");
  if (p.blocked_merchants.length > 0) lines.push(`Never shops at: ${p.blocked_merchants.join(", ")}.`);
  if (p.quiet_hours) lines.push(`No purchases from ${formatClock(p.quiet_hours.start)} to ${formatClock(p.quiet_hours.end)}.`);
  const v = p.velocity;
  lines.push(
    `At most ${v.max_requests} attempts and ${formatDollars(v.max_amount_cents_in_window)} per ${v.window_minutes} minutes; ` +
      `at most ${v.max_small_txns_in_window} charges under ${formatDollars(v.small_txn_threshold_cents)} in that time.`,
  );
  return lines;
}
