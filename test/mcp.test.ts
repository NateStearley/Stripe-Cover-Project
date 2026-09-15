import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GatewayService } from "../src/gateway/service.js";
import { Ledger } from "../src/ledger/repo.js";
import { FakeLinkClient } from "../src/link/fakeClient.js";
import { createMcpServer } from "../src/mcp/server.js";
import { LONG_CONTEXT, testProfile } from "./helpers.js";

async function connect() {
  const link = new FakeLinkClient();
  const gateway = new GatewayService({
    ledger: Ledger.open(":memory:"),
    link,
    loadProfile: testProfile,
    credentialsDir: "/tmp/creds",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer(gateway).connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return { client, link };
}

function body(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text);
}

describe("MCP server", () => {
  it("exposes the gateway tool surface and no update/self-approve tool", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "payment_methods_list",
      "spend_request_cancel",
      "spend_request_create",
      "spend_request_request_approval",
      "spend_request_retrieve",
    ]);
  });

  it("returns a denial as a tool error without touching Link", async () => {
    const { client, link } = await connect();
    const result = await client.callTool({
      name: "spend_request_create",
      arguments: { merchant_name: "REI", merchant_url: "https://rei.com", context: LONG_CONTEXT, amount: 8000 },
    });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ decision: "deny", forwarded: false });
    expect(link.calls).toHaveLength(0);
  });

  it("forwards an allowed request and lets Claude request approval", async () => {
    const { client } = await connect();
    const created = body(
      await client.callTool({
        name: "spend_request_create",
        arguments: { merchant_name: "REI", merchant_url: "https://rei.com", context: LONG_CONTEXT, amount: 2000 },
      }),
    );
    expect(created).toMatchObject({ decision: "allow", forwarded: true });

    const approval = await client.callTool({
      name: "spend_request_request_approval",
      arguments: { spend_request_id: created.spend_request.id },
    });
    expect(approval.isError).toBe(false);
    expect(body(approval).approval_url).toContain(created.spend_request.id);
  });

  it("rejects a context shorter than link-cli's 100-character minimum before evaluating", async () => {
    const { client, link } = await connect();
    const result = await client.callTool({
      name: "spend_request_create",
      arguments: { merchant_name: "REI", merchant_url: "https://rei.com", context: "tires", amount: 2000 },
    });
    expect(result.isError).toBe(true);
    expect(link.calls).toHaveLength(0);
  });

  it("returns untracked spend request access as a tool error", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: "spend_request_retrieve",
      arguments: { spend_request_id: "lsrq_elsewhere" },
    });
    expect(result.isError).toBe(true);
    expect(body(result).error.code).toBe("UNTRACKED_SPEND_REQUEST");
  });
});
