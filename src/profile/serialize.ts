import { stringify } from "yaml";
import type { RiskProfile } from "./schema.js";

const HEADER = `# Link Risk Gateway profile. Amounts are USD cents.
# Edited with the risk profile editor (npm run editor). The gateway re-reads this file
# on every spend request; if it becomes invalid, all spending is denied.
`;

/** Stable key order so saved files diff cleanly. Unset optional rules are omitted. */
export function serializeProfile(profile: RiskProfile): string {
  const ordered = {
    version: profile.version,
    default_project: profile.default_project,
    flag_threshold_pct: profile.flag_threshold_pct,
    timezone: profile.timezone,
    merchant_categories: profile.merchant_categories,
    projects: Object.fromEntries(
      Object.entries(profile.projects).map(([name, p]) => [
        name,
        {
          preset: p.preset,
          per_transaction_cap_cents: p.per_transaction_cap_cents,
          daily_cap_cents: p.daily_cap_cents,
          recent_purchases_cap: p.recent_purchases_cap,
          blocked_categories: p.blocked_categories,
          blocked_merchants: p.blocked_merchants,
          quiet_hours: p.quiet_hours,
          velocity: p.velocity,
        },
      ]),
    ),
  };
  return HEADER + stringify(dropUndefined(ordered));
}

function dropUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, dropUndefined(v)]),
    );
  }
  return value;
}
