import { z } from "zod";

/** Stripe's hard agent-wallet limits. A profile may be stricter, never looser. */
export const STRIPE_LIMITS = {
  perTransactionCents: 50_000,
  dailyCents: 50_000,
  thirtyDayCents: 2_000_000,
} as const;

export const PRESET_IDS = ["old-man-coffee", "safe", "strategic", "all-in", "custom"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

const cents = z.int().positive();

const velocitySchema = z.strictObject({
  window_minutes: z.int().positive(),
  max_requests: z.int().positive(),
  max_amount_cents_in_window: cents,
  small_txn_threshold_cents: cents,
  max_small_txns_in_window: z.int().positive(),
});

export const MAX_RECENT_WINDOW_DAYS = 90;

/** Committed spend in the trailing window (days + hours) plus this purchase may not exceed the cap. */
const recentPurchasesCapSchema = z
  .strictObject({
    window_days: z.int().min(0).max(MAX_RECENT_WINDOW_DAYS),
    window_hours: z.int().min(0).max(23),
    max_total_cents: cents.max(STRIPE_LIMITS.thirtyDayCents, {
      message: `must not exceed Stripe's 30-day limit (${STRIPE_LIMITS.thirtyDayCents})`,
    }),
  })
  .refine((c) => c.window_days > 0 || c.window_hours > 0, {
    message: "window must be at least 1 hour",
    path: ["window_hours"],
  });

export function recentWindowMs(cap: { window_days: number; window_hours: number }): number {
  return (cap.window_days * 24 + cap.window_hours) * 60 * 60 * 1000;
}

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24-hour)");

/** Purchases are denied from `start` up to (not including) `end`, in the profile's timezone. Wraps midnight. */
const quietHoursSchema = z
  .strictObject({ start: clockTime, end: clockTime })
  .refine((q) => q.start !== q.end, { message: "start and end must differ", path: ["end"] });

const categoryName = z
  .string()
  .min(1)
  .transform((s) => s.trim().toLowerCase());

const domain = z
  .string()
  .min(1)
  .transform((d) => normalizeDomain(d));

const projectSchema = z
  .strictObject({
    preset: z.enum(PRESET_IDS).default("custom"),
    per_transaction_cap_cents: cents.max(STRIPE_LIMITS.perTransactionCents, {
      message: `must not exceed Stripe's per-transaction limit (${STRIPE_LIMITS.perTransactionCents})`,
    }),
    daily_cap_cents: cents.max(STRIPE_LIMITS.dailyCents, {
      message: `must not exceed Stripe's daily limit (${STRIPE_LIMITS.dailyCents})`,
    }),
    recent_purchases_cap: recentPurchasesCapSchema.optional(),
    blocked_categories: z.array(categoryName).default([]),
    blocked_merchants: z.array(domain).default([]),
    quiet_hours: quietHoursSchema.optional(),
    velocity: velocitySchema,
  })
  .superRefine((p, ctx) => {
    if (p.per_transaction_cap_cents > p.daily_cap_cents) {
      ctx.addIssue({
        code: "custom",
        path: ["per_transaction_cap_cents"],
        message: "must not exceed daily_cap_cents",
      });
    }
    if (p.recent_purchases_cap && p.recent_purchases_cap.max_total_cents < p.per_transaction_cap_cents) {
      ctx.addIssue({
        code: "custom",
        path: ["recent_purchases_cap", "max_total_cents"],
        message: "must be at least per_transaction_cap_cents",
      });
    }
  });

export const profileSchema = z
  .strictObject({
    version: z.literal(1),
    default_project: z.string().min(1),
    flag_threshold_pct: z.number().gt(0).max(100).default(80),
    /** IANA time zone used for quiet hours, e.g. America/Chicago. */
    timezone: z
      .string()
      .refine(isValidTimeZone, { message: "must be an IANA time zone, e.g. America/Chicago" })
      .optional(),
    merchant_categories: z.record(domain, categoryName).default({}),
    projects: z.record(z.string().min(1), projectSchema),
  })
  .superRefine((p, ctx) => {
    if (!(p.default_project in p.projects)) {
      ctx.addIssue({
        code: "custom",
        path: ["default_project"],
        message: `"${p.default_project}" is not defined under projects`,
      });
    }
    const usesQuietHours = Object.values(p.projects).some((project) => project.quiet_hours);
    if (usesQuietHours && !p.timezone) {
      ctx.addIssue({ code: "custom", path: ["timezone"], message: "is required when any project sets quiet_hours" });
    }
  });

export type RiskProfile = z.infer<typeof profileSchema>;
export type RiskProfileInput = z.input<typeof profileSchema>;
export type ProjectPolicy = z.infer<typeof projectSchema>;

export interface LoadedProfile {
  profile: RiskProfile;
  /** First 12 hex chars of the sha256 of the profile file contents. */
  policyVersion: string;
}

export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
