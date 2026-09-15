import { recentWindowMs, type RiskProfile } from "../profile/schema.js";
import {
  checkBlockedMerchant,
  checkCategory,
  checkDailyCap,
  checkPerTransactionCap,
  checkQuietHours,
  checkRecentPurchasesCap,
  DAY_MS,
} from "./static.js";
import type { CheckResult, Decision, Evaluation, PriorAttempt, SpendCandidate } from "./types.js";
import { checkRequestCount, checkSmallTxnCount, checkWindowAmount } from "./velocity.js";

export const SUPPORTED_CURRENCY = "usd";

/**
 * Pure policy evaluation. `prior` must contain this project's attempts covering at least
 * `lookbackMs(profile)` before `now`; older rows are ignored.
 */
export function evaluate(
  profile: RiskProfile,
  project: string,
  req: SpendCandidate,
  prior: readonly PriorAttempt[],
  now: number,
): Evaluation {
  const policy = profile.projects[project];
  if (!policy) {
    return deny({
      code: "UNKNOWN_PROJECT",
      passed: false,
      utilization: 1,
      message: `project "${project}" is not defined in the risk profile`,
    });
  }
  if (req.currency.toLowerCase() !== SUPPORTED_CURRENCY) {
    return deny({
      code: "CURRENCY_UNSUPPORTED",
      passed: false,
      utilization: 1,
      message: `currency "${req.currency}" is not supported; profile caps are USD cents`,
    });
  }

  const checks: CheckResult[] = [
    checkPerTransactionCap(policy, req),
    checkCategory(policy, req),
    checkBlockedMerchant(policy, req),
    checkQuietHours(policy, profile.timezone, now),
    checkDailyCap(policy, req, prior, now),
    checkRecentPurchasesCap(policy, req, prior, now),
    checkRequestCount(policy, prior, now),
    checkWindowAmount(policy, req, prior, now),
    checkSmallTxnCount(policy, req, prior, now),
  ].filter((c): c is CheckResult => c !== undefined);

  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    return { decision: "deny", riskScore: 100, reasons: failed, checks };
  }

  const threshold = profile.flag_threshold_pct / 100;
  const riskScore = Math.round(Math.min(1, Math.max(0, ...checks.map((c) => c.utilization))) * 100);
  const nearLimit = checks.filter((c) => c.utilization >= threshold);
  const decision: Decision = nearLimit.length > 0 ? "flag" : "allow";
  return { decision, riskScore, reasons: nearLimit, checks };
}

/** How far back the ledger must be read to cover every time-based rule in the profile. */
export function lookbackMs(profile: RiskProfile): number {
  const windows = Object.values(profile.projects).flatMap((p) => [
    p.velocity.window_minutes * 60 * 1000,
    p.recent_purchases_cap ? recentWindowMs(p.recent_purchases_cap) : 0,
  ]);
  return Math.max(DAY_MS, ...windows);
}

function deny(reason: CheckResult): Evaluation {
  return { decision: "deny", riskScore: 100, reasons: [reason], checks: [reason] };
}
