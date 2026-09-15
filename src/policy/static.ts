import { matchesDomain } from "../profile/categories.js";
import { recentWindowMs, type ProjectPolicy } from "../profile/schema.js";
import { formatCents, isCommitted, type CheckResult, type PriorAttempt, type SpendCandidate } from "./types.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

export function checkPerTransactionCap(policy: ProjectPolicy, req: SpendCandidate): CheckResult {
  const cap = policy.per_transaction_cap_cents;
  return {
    code: "PER_TRANSACTION_CAP_EXCEEDED",
    passed: req.amountCents <= cap,
    utilization: req.amountCents / cap,
    message: `${formatCents(req.amountCents)} vs per-transaction cap ${formatCents(cap)}`,
  };
}

export function checkCategory(policy: ProjectPolicy, req: SpendCandidate): CheckResult {
  const blocked = policy.blocked_categories.includes(req.category);
  return {
    code: "CATEGORY_BLOCKED",
    passed: !blocked,
    utilization: 0,
    message: blocked ? `category "${req.category}" is blocked for this project` : `category "${req.category}" allowed`,
  };
}

export function checkBlockedMerchant(policy: ProjectPolicy, req: SpendCandidate): CheckResult {
  const match = req.merchantHost && policy.blocked_merchants.find((d) => matchesDomain(req.merchantHost!, d));
  return {
    code: "MERCHANT_BLOCKED",
    passed: !match,
    utilization: 0,
    message: match ? `merchant ${match} is blocked for this project` : "merchant allowed",
  };
}

/** Denies from `start` up to (not including) `end` in `timezone`; a window with start > end wraps midnight. */
export function checkQuietHours(policy: ProjectPolicy, timezone: string | undefined, now: number): CheckResult {
  const quiet = policy.quiet_hours;
  if (!quiet || !timezone) {
    return { code: "QUIET_HOURS", passed: true, utilization: 0, message: "no quiet hours" };
  }
  const local = localClockTime(now, timezone);
  const inside = quiet.start < quiet.end ? local >= quiet.start && local < quiet.end : local >= quiet.start || local < quiet.end;
  return {
    code: "QUIET_HOURS",
    passed: !inside,
    utilization: 0,
    message: `${local} ${timezone} is ${inside ? "inside" : "outside"} quiet hours ${quiet.start}–${quiet.end}`,
  };
}

/** Committed spend in the trailing `window_days` + `window_hours`, plus this purchase. */
export function checkRecentPurchasesCap(
  policy: ProjectPolicy,
  req: SpendCandidate,
  prior: readonly PriorAttempt[],
  now: number,
): CheckResult | undefined {
  const cap = policy.recent_purchases_cap;
  if (!cap) return undefined;
  const since = now - recentWindowMs(cap);
  const committed = prior
    .filter((a) => a.createdAt > since && isCommitted(a))
    .reduce((sum, a) => sum + a.amountCents, 0);
  const total = committed + req.amountCents;
  return {
    code: "RECENT_PURCHASES_CAP_EXCEEDED",
    passed: total <= cap.max_total_cents,
    utilization: total / cap.max_total_cents,
    message: `${formatCents(committed)} committed in last ${cap.window_days}d ${cap.window_hours}h + ${formatCents(req.amountCents)} vs cap ${formatCents(cap.max_total_cents)}`,
  };
}

/** "HH:MM" wall-clock time in `timezone`. Zero-padded, so string comparison orders correctly. */
export function localClockTime(now: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
}

/** Rolling 24h. Only spend that can still move money counts toward the cap. */
export function checkDailyCap(
  policy: ProjectPolicy,
  req: SpendCandidate,
  prior: readonly PriorAttempt[],
  now: number,
): CheckResult {
  const cap = policy.daily_cap_cents;
  const since = now - DAY_MS;
  const committed = prior
    .filter((a) => a.createdAt > since && isCommitted(a))
    .reduce((sum, a) => sum + a.amountCents, 0);
  const total = committed + req.amountCents;
  return {
    code: "DAILY_CAP_EXCEEDED",
    passed: total <= cap,
    utilization: total / cap,
    message: `${formatCents(committed)} committed in last 24h + ${formatCents(req.amountCents)} vs daily cap ${formatCents(cap)}`,
  };
}
