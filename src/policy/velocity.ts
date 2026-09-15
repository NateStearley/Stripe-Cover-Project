import type { ProjectPolicy } from "../profile/schema.js";
import { formatCents, isCommitted, type CheckResult, type PriorAttempt, type SpendCandidate } from "./types.js";

export function windowStart(policy: ProjectPolicy, now: number): number {
  return now - policy.velocity.window_minutes * 60 * 1000;
}

function inWindow(policy: ProjectPolicy, prior: readonly PriorAttempt[], now: number): PriorAttempt[] {
  const since = windowStart(policy, now);
  return prior.filter((a) => a.createdAt > since);
}

/** Every attempt counts, denials included — otherwise a denied burst would clear itself. */
export function checkRequestCount(
  policy: ProjectPolicy,
  prior: readonly PriorAttempt[],
  now: number,
): CheckResult {
  const { max_requests, window_minutes } = policy.velocity;
  const count = inWindow(policy, prior, now).length + 1;
  return {
    code: "VELOCITY_REQUEST_COUNT_EXCEEDED",
    passed: count <= max_requests,
    utilization: count / max_requests,
    message: `${count} requests in ${window_minutes}m vs max ${max_requests}`,
  };
}

/** Denied or dead amounts don't count, so one oversized denied attempt can't exhaust the window. */
export function checkWindowAmount(
  policy: ProjectPolicy,
  req: SpendCandidate,
  prior: readonly PriorAttempt[],
  now: number,
): CheckResult {
  const { max_amount_cents_in_window: cap, window_minutes } = policy.velocity;
  const committed = inWindow(policy, prior, now)
    .filter(isCommitted)
    .reduce((sum, a) => sum + a.amountCents, 0);
  const total = committed + req.amountCents;
  return {
    code: "VELOCITY_WINDOW_AMOUNT_EXCEEDED",
    passed: total <= cap,
    utilization: total / cap,
    message: `${formatCents(total)} in ${window_minutes}m vs window cap ${formatCents(cap)}`,
  };
}

/**
 * Card-testing signal: many sub-threshold attempts, counted regardless of outcome. A
 * non-small request can't fail this check, but a preceding small burst still raises
 * its utilization, so the payoff charge after a burst gets flagged.
 */
export function checkSmallTxnCount(
  policy: ProjectPolicy,
  req: SpendCandidate,
  prior: readonly PriorAttempt[],
  now: number,
): CheckResult {
  const { small_txn_threshold_cents: threshold, max_small_txns_in_window: max, window_minutes } = policy.velocity;
  const isSmall = req.amountCents < threshold;
  const count = inWindow(policy, prior, now).filter((a) => a.amountCents < threshold).length + (isSmall ? 1 : 0);
  return {
    code: "VELOCITY_SMALL_TXN_COUNT_EXCEEDED",
    passed: !isSmall || count <= max,
    utilization: count / max,
    message: `${count} requests under ${formatCents(threshold)} in ${window_minutes}m vs max ${max}`,
  };
}
