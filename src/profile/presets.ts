import type { PresetId, ProjectPolicy } from "./schema.js";

/** Categories offered as one-click suggestions in the editor. Any string is still allowed. */
export const COMMON_CATEGORIES = [
  "gambling",
  "subscription",
  "gift-cards",
  "crypto",
  "alcohol",
  "tobacco",
  "travel",
  "electronics",
  "uncategorized",
] as const;

export interface Preset {
  id: Exclude<PresetId, "custom">;
  name: string;
  tagline: string;
  /** Blocked merchants are personal, so presets never set or clear them. */
  settings: Omit<ProjectPolicy, "preset" | "blocked_merchants">;
}

export const PRESETS: readonly Preset[] = [
  {
    id: "old-man-coffee",
    name: "Old Man Coffee",
    tagline: "A cup of coffee and the paper. Tiny purchases, early bedtime, nothing new.",
    settings: {
      per_transaction_cap_cents: 1_500,
      daily_cap_cents: 3_000,
      recent_purchases_cap: { window_days: 7, window_hours: 0, max_total_cents: 7_500 },
      blocked_categories: ["gambling", "subscription", "gift-cards", "crypto", "alcohol", "tobacco", "uncategorized"],
      quiet_hours: { start: "21:00", end: "07:00" },
      velocity: {
        window_minutes: 60,
        max_requests: 2,
        max_amount_cents_in_window: 3_000,
        small_txn_threshold_cents: 300,
        max_small_txns_in_window: 2,
      },
    },
  },
  {
    id: "safe",
    name: "Safe",
    tagline: "Everyday errands with guardrails. Blocks the usual fraud magnets and overnight spending.",
    settings: {
      per_transaction_cap_cents: 5_000,
      daily_cap_cents: 15_000,
      recent_purchases_cap: { window_days: 7, window_hours: 0, max_total_cents: 40_000 },
      blocked_categories: ["gambling", "gift-cards", "crypto", "uncategorized"],
      quiet_hours: { start: "23:00", end: "07:00" },
      velocity: {
        window_minutes: 15,
        max_requests: 3,
        max_amount_cents_in_window: 10_000,
        small_txn_threshold_cents: 500,
        max_small_txns_in_window: 3,
      },
    },
  },
  {
    id: "strategic",
    name: "Strategic",
    tagline: "Room for real project purchases, with burst and card-testing protection still on.",
    settings: {
      per_transaction_cap_cents: 20_000,
      daily_cap_cents: 40_000,
      recent_purchases_cap: { window_days: 7, window_hours: 0, max_total_cents: 150_000 },
      blocked_categories: ["gambling", "gift-cards"],
      quiet_hours: undefined,
      velocity: {
        window_minutes: 15,
        max_requests: 5,
        max_amount_cents_in_window: 40_000,
        small_txn_threshold_cents: 500,
        max_small_txns_in_window: 5,
      },
    },
  },
  {
    id: "all-in",
    name: "All In",
    tagline: "Stripe's own limits and nothing more. Only the loosest burst checks remain.",
    settings: {
      per_transaction_cap_cents: 50_000,
      daily_cap_cents: 50_000,
      recent_purchases_cap: { window_days: 30, window_hours: 0, max_total_cents: 2_000_000 },
      blocked_categories: [],
      quiet_hours: undefined,
      velocity: {
        window_minutes: 15,
        max_requests: 10,
        max_amount_cents_in_window: 50_000,
        small_txn_threshold_cents: 100,
        max_small_txns_in_window: 10,
      },
    },
  },
];

export function presetById(id: PresetId): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** A project using `preset`, keeping any merchants the user already blocked. */
export function applyPreset(preset: Preset, blockedMerchants: readonly string[] = []): ProjectPolicy {
  return structuredClone({ preset: preset.id, ...preset.settings, blocked_merchants: [...blockedMerchants] });
}
