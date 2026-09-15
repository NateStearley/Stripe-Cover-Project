import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hostnameOf, resolveCategory, UNCATEGORIZED, type CategorySource } from "../profile/categories.js";
import type { LoadedProfile } from "../profile/schema.js";
import { evaluate, lookbackMs } from "../policy/engine.js";
import type { CheckResult, Decision, Evaluation } from "../policy/types.js";
import type { Ledger, SpendAttempt } from "../ledger/repo.js";
import type { LinkClient, LinkSpendRequest } from "../link/client.js";

export interface CreateSpendRequestInput {
  project?: string;
  category?: string;
  payment_method_id?: string;
  merchant_name: string;
  merchant_url: string;
  context: string;
  amount: number;
  currency?: string;
  line_items?: string[];
  totals?: string[];
}

export interface RetrieveInput {
  spend_request_id: string;
  include_card?: boolean;
  wait_seconds?: number;
}

export interface Reason {
  code: string;
  message: string;
  /** True when the check passed but is within flag_threshold_pct of its limit. */
  near_limit?: boolean;
}

export interface CreateResult {
  decision: Decision;
  attempt_id: string;
  project: string;
  category: string;
  category_source: CategorySource;
  risk_score: number;
  policy_version: string;
  reasons: Reason[];
  forwarded: boolean;
  spend_request?: LinkSpendRequest;
  forward_error?: Reason;
  next_step: string;
}

export interface GatewayOptions {
  ledger: Ledger;
  link: LinkClient;
  /** Called on every create so profile edits apply without a restart. May throw. */
  loadProfile: () => LoadedProfile;
  credentialsDir: string;
  now?: () => number;
  newId?: () => string;
}

export class GatewayError extends Error {
  override name = "GatewayError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class GatewayService {
  private readonly ledger: Ledger;
  private readonly link: LinkClient;
  private readonly loadProfile: () => LoadedProfile;
  private readonly credentialsDir: string;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: GatewayOptions) {
    this.ledger = options.ledger;
    this.link = options.link;
    this.loadProfile = options.loadProfile;
    this.credentialsDir = options.credentialsDir;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => `att_${randomUUID()}`);
  }

  async createSpendRequest(input: CreateSpendRequestInput): Promise<CreateResult> {
    const now = this.now();
    const id = this.newId();
    const currency = (input.currency ?? "usd").toLowerCase();

    let loaded: LoadedProfile;
    try {
      loaded = this.loadProfile();
    } catch (err) {
      // Fail closed: an unreadable profile must not become "no policy".
      return this.recordProfileFailure(id, now, currency, input, (err as Error).message);
    }

    const { profile, policyVersion } = loaded;
    const project = input.project?.trim() || profile.default_project;
    const { category, source: categorySource } = resolveCategory(profile, input.merchant_url, input.category);

    const merchantHost = hostnameOf(input.merchant_url);

    const evaluation = this.ledger.immediate(() => {
      const prior = this.ledger.priorAttempts(project, now - lookbackMs(profile));
      const result = evaluate(
        profile,
        project,
        { amountCents: input.amount, currency, category, merchantHost },
        prior,
        now,
      );
      this.ledger.insert({
        id,
        created_at: now,
        project,
        amount_cents: input.amount,
        currency,
        merchant_name: input.merchant_name,
        merchant_url: input.merchant_url,
        payment_method_id: input.payment_method_id ?? null,
        category,
        category_source: categorySource,
        decision: result.decision,
        reason: summarize(result),
        reasons_json: JSON.stringify(result.reasons),
        risk_score: result.riskScore,
        policy_version: policyVersion,
      });
      return result;
    });

    const base = {
      decision: evaluation.decision,
      attempt_id: id,
      project,
      category,
      category_source: categorySource,
      risk_score: evaluation.riskScore,
      policy_version: policyVersion,
      reasons: evaluation.reasons.map(toReason),
    };

    if (evaluation.decision === "deny") {
      return {
        ...base,
        forwarded: false,
        next_step:
          "Denied by the user's risk profile. Nothing was sent to Stripe. Do not retry, split the purchase, " +
          "or use another payment path; tell the user which rule blocked it.",
      };
    }

    const metadata: Record<string, string> = {
      gateway_attempt_id: id,
      gateway_project: project,
      gateway_decision: evaluation.decision,
      gateway_risk_score: String(evaluation.riskScore),
      gateway_policy_version: policyVersion,
      gateway_category: category,
    };
    if (evaluation.decision === "flag") metadata.gateway_risk_flag = "true";

    try {
      const spendRequest = await this.link.createSpendRequest({
        paymentMethodId: input.payment_method_id,
        merchantName: input.merchant_name,
        merchantUrl: input.merchant_url,
        context: input.context,
        amountCents: input.amount,
        currency,
        lineItems: input.line_items ?? [],
        totals: input.totals ?? [],
        metadata: sanitizeMetadata(metadata),
        idempotencyKey: id,
      });
      this.ledger.attachLinkRequest(id, spendRequest.id, spendRequest.status, this.now());
      return {
        ...base,
        forwarded: true,
        spend_request: spendRequest,
        next_step:
          (evaluation.decision === "flag"
            ? "Allowed but FLAGGED as near a risk limit — mention this to the user. "
            : "") +
          `Call spend_request_request_approval with spend_request_id "${spendRequest.id}" and show the user the approval_url.`,
      };
    } catch (err) {
      this.ledger.setStatus(id, "forward_failed", this.now());
      return {
        ...base,
        forwarded: false,
        forward_error: {
          code: (err as { code?: string }).code ?? "FORWARD_FAILED",
          message: (err as Error).message,
        },
        next_step: "The policy allowed this request, but Stripe Link rejected or failed it. Report the error to the user.",
      };
    }
  }

  async requestApproval(spendRequestId: string) {
    const attempt = this.requireTracked(spendRequestId);
    const approval = await this.link.requestApproval(spendRequestId);
    this.ledger.setStatus(attempt.id, "pending_approval", this.now());
    return {
      ...approval,
      next_step: `Show the user the approval_url, then call spend_request_retrieve with wait_seconds to poll for their decision.`,
    };
  }

  async retrieveSpendRequest(input: RetrieveInput) {
    const attempt = this.requireTracked(input.spend_request_id);
    const waitSeconds = Math.min(Math.max(input.wait_seconds ?? 0, 0), 600);
    const request = await this.link.retrieveSpendRequest(input.spend_request_id, {
      cardOutputFile: input.include_card ? join(this.credentialsDir, `${input.spend_request_id}.json`) : undefined,
      waitSeconds,
    });
    if (typeof request.status === "string") this.ledger.setStatus(attempt.id, request.status, this.now());
    return redactCard(request);
  }

  async cancelSpendRequest(spendRequestId: string) {
    const attempt = this.requireTracked(spendRequestId);
    const request = await this.link.cancelSpendRequest(spendRequestId);
    this.ledger.setStatus(attempt.id, typeof request.status === "string" ? request.status : "canceled", this.now());
    return request;
  }

  listPaymentMethods(): Promise<unknown> {
    return this.link.listPaymentMethods();
  }

  private requireTracked(spendRequestId: string): SpendAttempt {
    const attempt = this.ledger.findByLinkId(spendRequestId);
    if (!attempt) {
      throw new GatewayError(
        "UNTRACKED_SPEND_REQUEST",
        `Spend request ${spendRequestId} was not created through the risk gateway and cannot be accessed through it.`,
      );
    }
    return attempt;
  }

  private recordProfileFailure(
    id: string,
    now: number,
    currency: string,
    input: CreateSpendRequestInput,
    message: string,
  ): CreateResult {
    const project = input.project?.trim() || "(unresolved)";
    const reason: CheckResult = { code: "PROFILE_INVALID", passed: false, utilization: 1, message };
    this.ledger.insert({
      id,
      created_at: now,
      project,
      amount_cents: input.amount,
      currency,
      merchant_name: input.merchant_name,
      merchant_url: input.merchant_url,
      payment_method_id: input.payment_method_id ?? null,
      category: UNCATEGORIZED,
      category_source: "default",
      decision: "deny",
      reason: `PROFILE_INVALID: ${message}`,
      reasons_json: JSON.stringify([reason]),
      risk_score: 100,
      policy_version: "invalid",
    });
    return {
      decision: "deny",
      attempt_id: id,
      project,
      category: UNCATEGORIZED,
      category_source: "default",
      risk_score: 100,
      policy_version: "invalid",
      reasons: [toReason(reason)],
      forwarded: false,
      next_step: "The risk profile could not be loaded, so all spending is blocked. Ask the user to fix the profile.",
    };
  }
}

function toReason(check: CheckResult): Reason {
  return check.passed
    ? { code: check.code, message: check.message, near_limit: true }
    : { code: check.code, message: check.message };
}

function summarize(evaluation: Evaluation): string {
  if (evaluation.reasons.length === 0) return "all checks passed";
  return evaluation.reasons.map((r) => `${r.passed ? "NEAR " : ""}${r.code}: ${r.message}`).join("; ");
}

/** link-cli parses metadata as comma-separated key:value pairs and caps values at 500 chars. */
function sanitizeMetadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([k, v]) => [k.slice(0, 40), v.replaceAll(",", ";").slice(0, 500)]),
  );
}

/** Defense in depth: link-cli already redacts when --output-file is set. */
function redactCard(request: LinkSpendRequest): LinkSpendRequest {
  const card = request.card as Record<string, unknown> | undefined;
  if (!card || typeof card !== "object") return request;
  const { number, cvc, ...rest } = card;
  return {
    ...request,
    card: {
      ...rest,
      ...(typeof number === "string" ? { last4: number.slice(-4) } : {}),
    },
  };
}
