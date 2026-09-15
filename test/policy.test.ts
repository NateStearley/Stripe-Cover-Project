import { describe, expect, it } from "vitest";
import { evaluate } from "../src/policy/engine.js";
import type { PriorAttempt, SpendCandidate } from "../src/policy/types.js";
import { attempt, NOW, testProfile } from "./helpers.js";

const { profile } = testProfile();

function run(amountCents: number, prior: PriorAttempt[] = [], extra: Partial<SpendCandidate> = {}, project = "personal") {
  return evaluate(profile, project, { amountCents, currency: "usd", category: "outdoor-gear", ...extra }, prior, NOW);
}

const codes = (e: ReturnType<typeof run>) => e.reasons.map((r) => r.code);
const failed = (e: ReturnType<typeof run>) => e.checks.filter((c) => !c.passed).map((c) => c.code);

describe("static checks", () => {
  it("allows at the per-transaction cap and denies 1 cent over", () => {
    // 5000 at a 5000 cap is 100% utilization, so it passes but flags.
    expect(run(5000).decision).toBe("flag");
    const over = run(5001);
    expect(over.decision).toBe("deny");
    expect(codes(over)).toContain("PER_TRANSACTION_CAP_EXCEEDED");
  });

  it("denies blocked categories", () => {
    const e = run(1000, [], { category: "gambling" });
    expect(e.decision).toBe("deny");
    expect(codes(e)).toEqual(["CATEGORY_BLOCKED"]);
  });

  it("denies unknown projects and non-USD currencies", () => {
    expect(codes(run(1000, [], {}, "nope"))).toEqual(["UNKNOWN_PROJECT"]);
    expect(codes(run(1000, [], { currency: "eur" }))).toEqual(["CURRENCY_UNSUPPORTED"]);
  });

  it("enforces the rolling 24h daily cap at the boundary", () => {
    // 3 x 4000 committed earlier today, outside the velocity window.
    const prior = [attempt(600, 4000), attempt(500, 4000), attempt(400, 4000)];
    expect(failed(run(3000, prior))).not.toContain("DAILY_CAP_EXCEEDED"); // 15000 == cap
    expect(codes(run(3001, prior))).toContain("DAILY_CAP_EXCEEDED");
  });

  it("ignores spend older than 24h", () => {
    const prior = [attempt(24 * 60 + 1, 14000)];
    expect(failed(run(1000, prior))).not.toContain("DAILY_CAP_EXCEEDED");
  });

  it("does not count denied, expired, canceled, or failed attempts toward the daily cap", () => {
    const prior = [
      attempt(600, 4900, "deny", null),
      attempt(500, 4900, "allow", "expired"),
      attempt(400, 4900, "allow", "canceled"),
      attempt(300, 4900, "flag", "forward_failed"),
      attempt(200, 4900, "allow", "denied"),
    ];
    expect(failed(run(4900, prior))).not.toContain("DAILY_CAP_EXCEEDED");
  });

  it("counts pending and approved spend toward the daily cap", () => {
    const prior = [attempt(600, 5000, "allow", "pending_approval"), attempt(500, 5000, "allow", null), attempt(400, 5000)];
    expect(codes(run(100, prior))).toContain("DAILY_CAP_EXCEEDED");
  });
});

describe("velocity checks", () => {
  it("counts denied attempts toward max_requests", () => {
    const prior = [attempt(10, 9999, "deny", null), attempt(5, 9999, "deny", null)];
    expect(failed(run(1000, prior))).not.toContain("VELOCITY_REQUEST_COUNT_EXCEEDED"); // 3rd of 3
    const e = run(1000, [...prior, attempt(1, 9999, "deny", null)]);
    expect(e.decision).toBe("deny");
    expect(codes(e)).toContain("VELOCITY_REQUEST_COUNT_EXCEEDED");
  });

  it("only counts attempts inside the trailing window", () => {
    const prior = [attempt(15, 1000), attempt(16, 1000), attempt(30, 1000)];
    expect(failed(run(1000, prior))).not.toContain("VELOCITY_REQUEST_COUNT_EXCEEDED");
  });

  it("caps the committed amount in the window, excluding denied amounts", () => {
    const prior = [attempt(10, 5000, "allow", "pending_approval"), attempt(5, 4999, "deny", null)];
    expect(failed(run(5000, prior))).not.toContain("VELOCITY_WINDOW_AMOUNT_EXCEEDED"); // 10000 == cap
    expect(codes(run(5001, prior))).toContain("VELOCITY_WINDOW_AMOUNT_EXCEEDED");
  });

  it("denies the 4th sub-threshold charge in the window (card testing), regardless of outcome", () => {
    const burst = [attempt(3, 100, "allow"), attempt(2, 150, "deny", null), attempt(1, 499, "allow", "expired")];
    const e = run(200, burst);
    expect(e.decision).toBe("deny");
    expect(codes(e)).toContain("VELOCITY_SMALL_TXN_COUNT_EXCEEDED");
  });

  it("treats the threshold as exclusive: exactly small_txn_threshold_cents is not small", () => {
    // Three small charges already used personal's allowance of 3.
    const burst = [attempt(3, 100, "deny", null), attempt(2, 100, "deny", null), attempt(1, 100, "deny", null)];
    const failedSmall = (amount: number) =>
      evaluate(profile, "personal", { amountCents: amount, currency: "usd", category: "x" }, burst, NOW)
        .checks.find((c) => c.code === "VELOCITY_SMALL_TXN_COUNT_EXCEEDED")!.passed === false;
    expect(failedSmall(499)).toBe(true);
    expect(failedSmall(500)).toBe(false);
  });

  it("flags (not denies) a normal-sized charge right after a small-charge burst", () => {
    const e = evaluate(
      profile,
      "gravel-research",
      { amountCents: 2000, currency: "usd", category: "outdoor-gear" },
      [attempt(3, 100), attempt(2, 100), attempt(1, 100), attempt(1, 100)],
      NOW,
    );
    expect(e.decision).toBe("flag");
    expect(e.reasons.map((r) => r.code)).toContain("VELOCITY_SMALL_TXN_COUNT_EXCEEDED");
  });
});

describe("decision and risk score", () => {
  it("allows a clean request with a low score", () => {
    const e = run(1000);
    expect(e).toMatchObject({ decision: "allow", riskScore: 33, reasons: [] }); // 1 of 3 requests
  });

  it("flags a request that passes but reaches flag_threshold_pct of a limit", () => {
    const e = run(1000, [attempt(5, 1000), attempt(4, 1000)]); // 3 of 3 requests = 100%
    expect(e.decision).toBe("flag");
    expect(e.riskScore).toBe(100);
    expect(codes(e)).toEqual(["VELOCITY_REQUEST_COUNT_EXCEEDED"]);
  });

  it("flags at exactly the threshold and allows just under it", () => {
    const g = (amount: number) =>
      evaluate(profile, "gravel-research", { amountCents: amount, currency: "usd", category: "x" }, [], NOW);
    expect(g(16000).decision).toBe("flag"); // 80% of 20000 per-transaction cap
    expect(g(15999).decision).toBe("allow");
  });

  it("reports every failed check on deny, with score 100", () => {
    const e = run(6000, [], { category: "gambling" });
    expect(e.riskScore).toBe(100);
    expect(codes(e)).toEqual(["PER_TRANSACTION_CAP_EXCEEDED", "CATEGORY_BLOCKED"]);
  });
});
