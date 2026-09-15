import { beforeEach, describe, expect, it } from "vitest";
import { GatewayService, type CreateSpendRequestInput } from "../src/gateway/service.js";
import { Ledger } from "../src/ledger/repo.js";
import { LinkCliError } from "../src/link/client.js";
import { FakeLinkClient } from "../src/link/fakeClient.js";
import { ProfileError } from "../src/profile/load.js";
import type { LoadedProfile } from "../src/profile/schema.js";
import { LONG_CONTEXT, MIN, NOW, testProfile } from "./helpers.js";

let ledger: Ledger;
let link: FakeLinkClient;
let clock: number;
let profile: () => LoadedProfile;
let gateway: GatewayService;

beforeEach(() => {
  ledger = Ledger.open(":memory:");
  link = new FakeLinkClient();
  clock = NOW;
  profile = testProfile;
  let seq = 0;
  gateway = new GatewayService({
    ledger,
    link,
    loadProfile: () => profile(),
    credentialsDir: "/tmp/creds",
    now: () => clock,
    newId: () => `att_${++seq}`,
  });
});

function purchase(overrides: Partial<CreateSpendRequestInput> = {}): CreateSpendRequestInput {
  return {
    merchant_name: "REI",
    merchant_url: "https://www.rei.com/product/123",
    context: LONG_CONTEXT,
    amount: 2000,
    ...overrides,
  };
}

describe("spend_request_create", () => {
  it("denies without calling Stripe and records the attempt", async () => {
    const result = await gateway.createSpendRequest(purchase({ amount: 8000 }));

    expect(result).toMatchObject({ decision: "deny", forwarded: false, project: "personal", risk_score: 100 });
    expect(result.reasons.map((r) => r.code)).toEqual(["PER_TRANSACTION_CAP_EXCEEDED"]);
    expect(link.calls).toHaveLength(0);
    expect(ledger.get(result.attempt_id)).toMatchObject({ decision: "deny", link_spend_request_id: null });
  });

  it("forwards allowed requests with gateway metadata and links the ledger row", async () => {
    const result = await gateway.createSpendRequest(purchase());

    expect(result).toMatchObject({ decision: "allow", forwarded: true, category: "outdoor-gear" });
    expect(link.calls).toHaveLength(1);
    const call = link.calls[0]!;
    expect(call.method).toBe("createSpendRequest");
    if (call.method !== "createSpendRequest") return;
    expect(call.params).toMatchObject({
      amountCents: 2000,
      currency: "usd",
      context: LONG_CONTEXT,
      idempotencyKey: result.attempt_id,
      metadata: {
        gateway_attempt_id: result.attempt_id,
        gateway_project: "personal",
        gateway_decision: "allow",
        gateway_risk_score: String(result.risk_score),
        gateway_policy_version: result.policy_version,
        gateway_category: "outdoor-gear",
      },
    });
    expect(call.params.metadata).not.toHaveProperty("gateway_risk_flag");
    expect(ledger.get(result.attempt_id)).toMatchObject({
      link_spend_request_id: result.spend_request!.id,
      final_status: "created",
    });
  });

  it("marks flagged requests in metadata and in the next step returned to Claude", async () => {
    const result = await gateway.createSpendRequest(purchase({ amount: 4500 })); // 90% of $50 cap
    expect(result.decision).toBe("flag");
    expect(result.next_step).toMatch(/FLAGGED/);
    const call = link.calls[0]!;
    if (call.method !== "createSpendRequest") throw new Error("expected create");
    expect(call.params.metadata.gateway_risk_flag).toBe("true");
  });

  it("uses the merchant map over Claude's declared category", async () => {
    const result = await gateway.createSpendRequest(
      purchase({ merchant_name: "DK", merchant_url: "https://draftkings.com", category: "entertainment" }),
    );
    expect(result).toMatchObject({ decision: "deny", category: "gambling", category_source: "merchant_map" });
    expect(link.calls).toHaveLength(0);
  });

  it("routes to the requested project", async () => {
    const result = await gateway.createSpendRequest(purchase({ amount: 15000, project: "gravel-research" }));
    expect(result).toMatchObject({ project: "gravel-research", forwarded: true });
  });

  it("counts denials toward velocity: a denied burst blocks the next valid request", async () => {
    for (let i = 0; i < 3; i++) {
      clock += MIN;
      expect((await gateway.createSpendRequest(purchase({ amount: 9000 }))).decision).toBe("deny");
    }
    clock += MIN;
    const next = await gateway.createSpendRequest(purchase({ amount: 1000 }));
    expect(next.decision).toBe("deny");
    expect(next.reasons.map((r) => r.code)).toEqual(["VELOCITY_REQUEST_COUNT_EXCEEDED"]);

    clock += 15 * MIN;
    expect((await gateway.createSpendRequest(purchase({ amount: 1000 }))).forwarded).toBe(true);
    expect(link.calls).toHaveLength(1);
  });

  it("frees daily-cap headroom when a forwarded request expires", async () => {
    const hours = (h: number) => (clock += h * 60 * MIN);
    const r1 = await gateway.createSpendRequest(purchase({ amount: 5000 }));
    hours(1);
    await gateway.createSpendRequest(purchase({ amount: 5000 }));
    hours(1);
    await gateway.createSpendRequest(purchase({ amount: 5000 }));
    hours(1);
    expect((await gateway.createSpendRequest(purchase({ amount: 1000 }))).reasons.map((r) => r.code)).toContain(
      "DAILY_CAP_EXCEEDED",
    );

    link.setStatus(r1.spend_request!.id, "expired");
    await gateway.retrieveSpendRequest({ spend_request_id: r1.spend_request!.id });
    hours(1);
    expect((await gateway.createSpendRequest(purchase({ amount: 1000 }))).forwarded).toBe(true);
  });

  it("records forward failures without counting them as committed spend", async () => {
    link.failNextCreate = new LinkCliError("UNKNOWN", 'Not authenticated. Run "link-cli auth login" first.');
    const failed = await gateway.createSpendRequest(purchase({ amount: 5000 }));
    expect(failed).toMatchObject({ decision: "flag", forwarded: false, forward_error: { code: "UNKNOWN" } });
    expect(ledger.get(failed.attempt_id)?.final_status).toBe("forward_failed");

    // Three more $50 requests fill the $150 daily cap exactly; had the failure counted, the third would be denied.
    for (let i = 0; i < 3; i++) {
      clock += 20 * MIN;
      expect((await gateway.createSpendRequest(purchase({ amount: 5000 }))).forwarded).toBe(true);
    }
  });

  it("fails closed when the profile cannot be loaded", async () => {
    profile = () => {
      throw new ProfileError("Risk profile is invalid: projects.personal.daily_cap_cents too big");
    };
    const result = await gateway.createSpendRequest(purchase({ amount: 100 }));
    expect(result).toMatchObject({ decision: "deny", policy_version: "invalid", forwarded: false });
    expect(result.reasons[0]!.code).toBe("PROFILE_INVALID");
    expect(link.calls).toHaveLength(0);
    expect(ledger.list()).toHaveLength(1);
  });
});

describe("follow-up tools", () => {
  it("refuse spend requests that were not created through the gateway", async () => {
    await expect(gateway.retrieveSpendRequest({ spend_request_id: "lsrq_elsewhere" })).rejects.toMatchObject({
      code: "UNTRACKED_SPEND_REQUEST",
    });
    await expect(gateway.requestApproval("lsrq_elsewhere")).rejects.toMatchObject({ code: "UNTRACKED_SPEND_REQUEST" });
    await expect(gateway.cancelSpendRequest("lsrq_elsewhere")).rejects.toMatchObject({
      code: "UNTRACKED_SPEND_REQUEST",
    });
    expect(link.calls).toHaveLength(0);
  });

  it("walks the approval lifecycle and keeps the ledger status in sync", async () => {
    const { attempt_id, spend_request } = await gateway.createSpendRequest(purchase());
    const id = spend_request!.id;

    const approval = await gateway.requestApproval(id);
    expect(approval.approval_url).toContain(id);
    expect(ledger.get(attempt_id)?.final_status).toBe("pending_approval");

    link.setStatus(id, "approved");
    const retrieved = await gateway.retrieveSpendRequest({ spend_request_id: id, include_card: true, wait_seconds: 900 });
    expect(retrieved).toMatchObject({ status: "approved", card_output_file: `/tmp/creds/${id}.json` });
    expect(link.calls.at(-1)).toMatchObject({
      method: "retrieveSpendRequest",
      options: { cardOutputFile: `/tmp/creds/${id}.json`, waitSeconds: 600 },
    });
    expect(ledger.get(attempt_id)?.final_status).toBe("approved");
  });

  it("never returns a full card number inline", async () => {
    const { spend_request } = await gateway.createSpendRequest(purchase());
    const id = spend_request!.id;
    link.retrieveSpendRequest = async () => ({
      id,
      status: "approved",
      card: { number: "4242424242424242", cvc: "123", exp_month: 12, exp_year: 2030 },
    });
    const retrieved = await gateway.retrieveSpendRequest({ spend_request_id: id, include_card: true });
    expect(retrieved.card).toEqual({ last4: "4242", exp_month: 12, exp_year: 2030 });
  });

  it("cancel updates the ledger", async () => {
    const { attempt_id, spend_request } = await gateway.createSpendRequest(purchase());
    await gateway.cancelSpendRequest(spend_request!.id);
    expect(ledger.get(attempt_id)?.final_status).toBe("canceled");
  });
});
