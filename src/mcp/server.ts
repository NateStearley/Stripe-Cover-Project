import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GatewayService } from "../gateway/service.js";

const spendRequestId = z.string().regex(/^lsrq_/, "must be a Link spend request id (lsrq_...)");

export function createMcpServer(gateway: GatewayService): McpServer {
  const server = new McpServer({ name: "link-risk-gateway", version: "0.1.0" });

  server.registerTool(
    "spend_request_create",
    {
      title: "Create a Link spend request (risk-checked)",
      description:
        "Create a Stripe Link spend request for a card purchase. The request is first checked against the user's " +
        "risk profile: denied requests never reach Stripe. Allowed requests are created in Stripe test mode and still " +
        "need the user's approval (call spend_request_request_approval next). Amounts are in cents.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Risk-profile project this purchase belongs to. Omit to use the profile's default project."),
        category: z
          .string()
          .optional()
          .describe("Merchant category, e.g. software, travel, gambling. The profile's merchant map overrides this."),
        payment_method_id: z.string().optional().describe("Link payment method id (csmrpd_...)."),
        merchant_name: z.string().min(1),
        merchant_url: z.string().min(1),
        context: z
          .string()
          .min(100)
          .describe("At least 100 characters: what is being bought and why. The user reads this when approving."),
        amount: z.int().positive().describe("Amount in cents ($10.00 = 1000)."),
        currency: z.string().length(3).optional().describe("ISO currency code. Only usd is supported."),
        line_items: z
          .array(z.string())
          .optional()
          .describe('link-cli line items, e.g. "name:Shoes,unit_amount:5000,quantity:2".'),
        totals: z
          .array(z.string())
          .optional()
          .describe('link-cli totals, e.g. "type:total,display_text:Total,amount:5000".'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const result = await gateway.createSpendRequest(args);
      return json(result, result.decision === "deny" || result.forward_error !== undefined);
    },
  );

  server.registerTool(
    "spend_request_request_approval",
    {
      title: "Request user approval for a spend request",
      description:
        "Ask the user to approve a spend request created through this gateway. Returns an approval_url to show them.",
      inputSchema: { spend_request_id: spendRequestId },
      annotations: { openWorldHint: true },
    },
    ({ spend_request_id }) => guarded(() => gateway.requestApproval(spend_request_id)),
  );

  server.registerTool(
    "spend_request_retrieve",
    {
      title: "Retrieve a spend request",
      description:
        "Get the status of a spend request created through this gateway. Set wait_seconds to poll until the user " +
        "approves or denies. Set include_card once approved to write the card credentials to a local 0600 file " +
        "(card_output_file); the full card number is never returned inline.",
      inputSchema: {
        spend_request_id: spendRequestId,
        include_card: z.boolean().optional(),
        wait_seconds: z.int().min(0).max(600).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => guarded(() => gateway.retrieveSpendRequest(args)),
  );

  server.registerTool(
    "spend_request_cancel",
    {
      title: "Cancel a spend request",
      description: "Cancel a spend request created through this gateway.",
      inputSchema: { spend_request_id: spendRequestId },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ({ spend_request_id }) => guarded(() => gateway.cancelSpendRequest(spend_request_id)),
  );

  server.registerTool(
    "payment_methods_list",
    {
      title: "List Link payment methods",
      description: "List the payment methods available in the user's Link wallet.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => guarded(() => gateway.listPaymentMethods()),
  );

  return server;
}

function json(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

async function guarded(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await fn());
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return json({ error: { code: e.code ?? "ERROR", message: e.message ?? String(err) } }, true);
  }
}
