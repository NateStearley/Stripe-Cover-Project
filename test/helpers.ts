import { parseProfile } from "../src/profile/load.js";
import type { LoadedProfile } from "../src/profile/schema.js";
import type { Decision, PriorAttempt } from "../src/policy/types.js";

export const NOW = Date.parse("2026-09-13T12:00:00Z");
export const MIN = 60 * 1000;

export const PROFILE_YAML = `
version: 1
default_project: personal
flag_threshold_pct: 80
merchant_categories:
  draftkings.com: gambling
  rei.com: outdoor-gear
projects:
  personal:
    per_transaction_cap_cents: 5000
    daily_cap_cents: 15000
    blocked_categories: [gambling, uncategorized]
    velocity:
      window_minutes: 15
      max_requests: 3
      max_amount_cents_in_window: 10000
      small_txn_threshold_cents: 500
      max_small_txns_in_window: 3
  gravel-research:
    per_transaction_cap_cents: 20000
    daily_cap_cents: 50000
    blocked_categories: []
    velocity:
      window_minutes: 15
      max_requests: 5
      max_amount_cents_in_window: 40000
      small_txn_threshold_cents: 500
      max_small_txns_in_window: 5
`;

export function testProfile(): LoadedProfile {
  return parseProfile(PROFILE_YAML);
}

export function attempt(
  minutesAgo: number,
  amountCents: number,
  decision: Decision = "allow",
  finalStatus: string | null = "approved",
): PriorAttempt {
  return { createdAt: NOW - minutesAgo * MIN, amountCents, decision, finalStatus };
}

export const LONG_CONTEXT =
  "Buying a replacement tubeless tire sealant kit for the gravel bike ahead of this weekend's race, as requested by the user.";
