export type Decision = "allow" | "flag" | "deny";

/** Link statuses (plus gateway-only ones) under which money cannot move. */
export const NON_COMMITTED_STATUSES: ReadonlySet<string> = new Set([
  "denied",
  "expired",
  "canceled",
  "failed",
  "forward_failed",
]);

/** The slice of a ledger row the policy engine needs. */
export interface PriorAttempt {
  createdAt: number;
  amountCents: number;
  decision: Decision;
  finalStatus: string | null;
}

export interface SpendCandidate {
  amountCents: number;
  currency: string;
  category: string;
  /** Normalized merchant hostname, when the merchant URL could be parsed. */
  merchantHost?: string;
}

export type ReasonCode =
  | "PROFILE_INVALID"
  | "UNKNOWN_PROJECT"
  | "CURRENCY_UNSUPPORTED"
  | "PER_TRANSACTION_CAP_EXCEEDED"
  | "CATEGORY_BLOCKED"
  | "MERCHANT_BLOCKED"
  | "QUIET_HOURS"
  | "DAILY_CAP_EXCEEDED"
  | "RECENT_PURCHASES_CAP_EXCEEDED"
  | "VELOCITY_REQUEST_COUNT_EXCEEDED"
  | "VELOCITY_WINDOW_AMOUNT_EXCEEDED"
  | "VELOCITY_SMALL_TXN_COUNT_EXCEEDED";

export interface CheckResult {
  code: ReasonCode;
  passed: boolean;
  /** used / limit after this request, in [0, ∞). Drives risk_score and flagging. */
  utilization: number;
  message: string;
}

export interface Evaluation {
  decision: Decision;
  riskScore: number;
  /** Failed checks (deny) or near-limit checks (flag). Empty for a clean allow. */
  reasons: CheckResult[];
  checks: CheckResult[];
}

export function isCommitted(a: PriorAttempt): boolean {
  return a.decision !== "deny" && (a.finalStatus === null || !NON_COMMITTED_STATUSES.has(a.finalStatus));
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
