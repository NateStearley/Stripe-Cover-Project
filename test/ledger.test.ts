import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger, type NewSpendAttempt } from "../src/ledger/repo.js";
import { MIN, NOW } from "./helpers.js";

function row(id: string, overrides: Partial<NewSpendAttempt> = {}): NewSpendAttempt {
  return {
    id,
    created_at: NOW,
    project: "personal",
    amount_cents: 1000,
    currency: "usd",
    merchant_name: "REI",
    merchant_url: "https://rei.com",
    payment_method_id: null,
    category: "outdoor-gear",
    category_source: "merchant_map",
    decision: "allow",
    reason: "all checks passed",
    reasons_json: "[]",
    risk_score: 10,
    policy_version: "abc123abc123",
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("ledger", () => {
  it("returns prior attempts for a project after a cutoff, oldest first", () => {
    const ledger = Ledger.open(":memory:");
    ledger.insert(row("a", { created_at: NOW - 30 * MIN }));
    ledger.insert(row("b", { created_at: NOW - 5 * MIN, decision: "deny" }));
    ledger.insert(row("c", { created_at: NOW - 1 * MIN, project: "other" }));
    ledger.insert(row("d", { created_at: NOW - 60 * MIN }));

    expect(ledger.priorAttempts("personal", NOW - 45 * MIN)).toEqual([
      { createdAt: NOW - 30 * MIN, amountCents: 1000, decision: "allow", finalStatus: null },
      { createdAt: NOW - 5 * MIN, amountCents: 1000, decision: "deny", finalStatus: null },
    ]);
  });

  it("tracks the Link spend request id and status", () => {
    const ledger = Ledger.open(":memory:");
    ledger.insert(row("a"));
    ledger.attachLinkRequest("a", "lsrq_1", "created", NOW + 1);
    ledger.setStatus("a", "approved", NOW + 2);
    expect(ledger.findByLinkId("lsrq_1")).toMatchObject({ id: "a", final_status: "approved", updated_at: NOW + 2 });
    expect(ledger.findByLinkId("lsrq_other")).toBeUndefined();
  });

  it("is idempotent to reopen (migrations run once)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    dirs.push(dir);
    const path = join(dir, "nested", "ledger.db");
    Ledger.open(path).close();
    const reopened = Ledger.open(path);
    expect(reopened.db.pragma("user_version", { simple: true })).toBe(1);
    reopened.close();
  });

  it("serializes evaluate+insert across processes with BEGIN IMMEDIATE", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    dirs.push(dir);
    const path = join(dir, "ledger.db");
    const a = Ledger.open(path);
    const b = Ledger.open(path, { busyTimeoutMs: 0 });

    a.db.exec("BEGIN IMMEDIATE");
    a.insert(row("from-a"));

    // While A holds the write lock, B cannot start its read-evaluate-insert, so it can't
    // evaluate against a ledger that is missing A's pending attempt.
    expect(() => b.immediate(() => b.priorAttempts("personal", 0))).toThrow(/locked|busy/i);

    a.db.exec("COMMIT");
    expect(b.immediate(() => b.priorAttempts("personal", 0))).toHaveLength(1);
    a.close();
    b.close();
  });
});
