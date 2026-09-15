import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { GatewayService } from "../src/gateway/service.js";
import { Ledger } from "../src/ledger/repo.js";
import { FakeLinkClient } from "../src/link/fakeClient.js";
import { evaluate } from "../src/policy/engine.js";
import { localClockTime } from "../src/policy/static.js";
import type { PriorAttempt } from "../src/policy/types.js";
import { parseProfile } from "../src/profile/load.js";
import { applyPreset, PRESETS } from "../src/profile/presets.js";
import { profileSchema, type RiskProfileInput } from "../src/profile/schema.js";
import { attempt, LONG_CONTEXT, MIN, NOW } from "./helpers.js";

// NOW is 2026-09-13T12:00:00Z, which is 07:00 in America/Chicago (CDT, UTC-5).
function profileWith(project: Partial<RiskProfileInput["projects"][string]>, extra: Partial<RiskProfileInput> = {}) {
  return profileSchema.parse({
    version: 1,
    default_project: "p",
    timezone: "America/Chicago",
    projects: {
      p: {
        per_transaction_cap_cents: 5000,
        daily_cap_cents: 50000,
        velocity: {
          window_minutes: 15,
          max_requests: 100,
          max_amount_cents_in_window: 50000,
          small_txn_threshold_cents: 100,
          max_small_txns_in_window: 100,
        },
        ...project,
      },
    },
    ...extra,
  });
}

const codeOf = (e: ReturnType<typeof evaluate>, code: string) => e.checks.find((c) => c.code === code);

describe("recent purchases cap", () => {
  const DAY = 24 * 60; // minutes, for attempt(minutesAgo, ...)
  const profile = profileWith({ recent_purchases_cap: { window_days: 7, window_hours: 12, max_total_cents: 10000 } });
  const run = (amount: number, prior: PriorAttempt[], p = profile) =>
    evaluate(p, "p", { amountCents: amount, currency: "usd", category: "x" }, prior, NOW);
  const cap = (e: ReturnType<typeof evaluate>) => codeOf(e, "RECENT_PURCHASES_CAP_EXCEEDED")!;

  it("sums committed spend inside the days + hours window, plus this purchase", () => {
    const prior = [attempt(7 * DAY + 11 * 60 + 59, 3000), attempt(3 * DAY, 3000), attempt(1 * DAY, 3000)];
    expect(cap(run(1000, prior)).passed).toBe(true); // 10000 == cap
    expect(run(1001, prior).decision).toBe("deny");
  });

  it("ignores purchases at or beyond the edge of the window", () => {
    const prior = [attempt(7 * DAY + 12 * 60, 9000), attempt(30 * DAY, 9000), attempt(1, 1000)];
    expect(cap(run(9000, prior)).passed).toBe(true); // only the 1000 counts
  });

  it("supports hour-only windows", () => {
    const sixHours = profileWith({ recent_purchases_cap: { window_days: 0, window_hours: 6, max_total_cents: 5000 } });
    expect(cap(run(3000, [attempt(5 * 60, 2000)], sixHours)).passed).toBe(true);
    expect(cap(run(3001, [attempt(5 * 60, 2000)], sixHours)).passed).toBe(false);
    expect(cap(run(3001, [attempt(6 * 60, 2000)], sixHours)).passed).toBe(true);
  });

  it("does not count denied, expired, or canceled purchases", () => {
    const prior = [attempt(3, 5000, "allow", "expired"), attempt(2, 5000, "deny", null), attempt(1, 4000, "allow", "canceled")];
    expect(cap(run(10000, prior)).passed).toBe(true);
  });

  it("is skipped entirely when not configured", () => {
    const e = evaluate(profileWith({}), "p", { amountCents: 100, currency: "usd", category: "x" }, [], NOW);
    expect(codeOf(e, "RECENT_PURCHASES_CAP_EXCEEDED")).toBeUndefined();
  });

  it("reads ledger history beyond 24h through the gateway, and frees budget as purchases age out", async () => {
    const ledger = Ledger.open(":memory:");
    let clock = Date.parse("2026-09-13T17:00:00Z"); // noon in Chicago, outside any quiet hours
    const gateway = new GatewayService({
      ledger,
      link: new FakeLinkClient(),
      loadProfile: () => ({ profile, policyVersion: "test" }),
      credentialsDir: "/tmp/creds",
      now: () => clock,
    });
    const buy = (amount: number) =>
      gateway.createSpendRequest({ merchant_name: "M", merchant_url: "https://m.example", context: LONG_CONTEXT, amount });

    for (let i = 0; i < 3; i++) {
      expect((await buy(3000)).forwarded).toBe(true); // days 0, 2 and 4
      clock += 2 * DAY * MIN;
    }
    const denied = await buy(1001); // day 6: all three are still inside 7d 12h
    expect(denied.reasons.map((r) => r.code)).toEqual(["RECENT_PURCHASES_CAP_EXCEEDED"]);

    clock += 36 * 60 * MIN; // day 7.5: the day-0 purchase has aged out
    expect((await buy(1001)).forwarded).toBe(true);
  });
});

describe("blocked merchants", () => {
  const profile = profileWith({ blocked_merchants: ["WWW.Sketchy-Shop.com", "temu.com"] });
  const run = (merchantHost: string | undefined) =>
    evaluate(profile, "p", { amountCents: 100, currency: "usd", category: "x", merchantHost }, [], NOW);

  it("normalizes entries and blocks the domain and its subdomains", () => {
    expect(profile.projects.p!.blocked_merchants).toEqual(["sketchy-shop.com", "temu.com"]);
    expect(run("sketchy-shop.com").decision).toBe("deny");
    expect(run("checkout.temu.com").reasons.map((r) => r.code)).toEqual(["MERCHANT_BLOCKED"]);
    expect(run("nottemu.com").decision).not.toBe("deny");
    expect(run(undefined).decision).not.toBe("deny");
  });
});

describe("quiet hours", () => {
  const at = (iso: string, quiet: { start: string; end: string }) =>
    evaluate(
      profileWith({ quiet_hours: quiet }),
      "p",
      { amountCents: 100, currency: "usd", category: "x" },
      [],
      Date.parse(iso),
    );
  const blocked = (iso: string, quiet: { start: string; end: string }) => !codeOf(at(iso, quiet), "QUIET_HOURS")!.passed;

  it("converts to the profile's time zone", () => {
    expect(localClockTime(NOW, "America/Chicago")).toBe("07:00");
    expect(localClockTime(NOW, "UTC")).toBe("12:00");
  });

  it("wraps overnight windows, with start inclusive and end exclusive", () => {
    const night = { start: "23:00", end: "07:00" };
    expect(blocked("2026-09-14T03:59:00Z", night)).toBe(false); // 22:59 CDT
    expect(blocked("2026-09-14T04:00:00Z", night)).toBe(true); // 23:00
    expect(blocked("2026-09-14T09:00:00Z", night)).toBe(true); // 04:00
    expect(blocked("2026-09-14T11:59:00Z", night)).toBe(true); // 06:59
    expect(blocked("2026-09-14T12:00:00Z", night)).toBe(false); // 07:00
  });

  it("handles same-day windows", () => {
    const lunch = { start: "12:00", end: "13:00" };
    expect(blocked("2026-09-14T17:30:00Z", lunch)).toBe(true); // 12:30 CDT
    expect(blocked("2026-09-14T18:00:00Z", lunch)).toBe(false); // 13:00
  });

  it("denies with a QUIET_HOURS reason", () => {
    const e = at("2026-09-14T04:30:00Z", { start: "23:00", end: "07:00" });
    expect(e.decision).toBe("deny");
    expect(e.reasons[0]!.message).toContain("23:30 America/Chicago");
  });
});

describe("schema additions", () => {
  it("requires a timezone when any project uses quiet hours", () => {
    expect(() => profileWith({ quiet_hours: { start: "23:00", end: "07:00" } }, { timezone: undefined })).toThrow(
      /required when any project sets quiet_hours/,
    );
  });

  it("rejects invalid time zones, malformed times, and empty windows", () => {
    expect(() => profileWith({}, { timezone: "Mars/Olympus" })).toThrow(/IANA time zone/);
    expect(() => profileWith({ quiet_hours: { start: "7am", end: "09:00" } })).toThrow(/HH:MM/);
    expect(() => profileWith({ quiet_hours: { start: "09:00", end: "09:00" } })).toThrow(/must differ/);
  });

  it("validates the recent purchases window and cap", () => {
    const withCap = (c: object) => () => profileWith({ recent_purchases_cap: { window_days: 7, window_hours: 0, max_total_cents: 10000, ...c } });
    expect(withCap({ max_total_cents: 4999 })).toThrow(/at least per_transaction_cap_cents/);
    expect(withCap({ window_days: 0, window_hours: 0 })).toThrow(/at least 1 hour/);
    expect(withCap({ window_hours: 24 })).toThrow();
    expect(withCap({ window_days: 91 })).toThrow();
    expect(withCap({ window_days: 0, window_hours: 1 })).not.toThrow();
  });

  it("defaults preset to custom for profiles written before presets existed", () => {
    expect(profileWith({}).projects.p!.preset).toBe("custom");
  });
});

describe("presets", () => {
  it("has the four named presets in order", () => {
    expect(PRESETS.map((p) => p.name)).toEqual(["Old Man Coffee", "Safe", "Strategic", "All In"]);
  });

  it.each(PRESETS)("$name is a valid project and survives a YAML round trip", (preset) => {
    const input = {
      version: 1,
      default_project: "p",
      timezone: "America/Chicago",
      projects: { p: applyPreset(preset) },
    };
    const loaded = parseProfile(stringify(input));
    expect(loaded.profile.projects.p).toMatchObject({ preset: preset.id, ...stripUndefined(preset.settings) });
  });

  it("gets strictly looser from Old Man Coffee to All In", () => {
    const caps = PRESETS.map((p) => p.settings.per_transaction_cap_cents);
    expect([...caps].sort((a, b) => a - b)).toEqual(caps);
    const blocked = PRESETS.map((p) => p.settings.blocked_categories.length);
    expect([...blocked].sort((a, b) => b - a)).toEqual(blocked);
  });

  it("returns an independent copy each time", () => {
    const a = applyPreset(PRESETS[0]!);
    a.blocked_categories.push("mutated");
    expect(PRESETS[0]!.settings.blocked_categories).not.toContain("mutated");
  });
});

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
