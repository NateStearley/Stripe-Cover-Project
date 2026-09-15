import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliLinkClient, parseJsonOutput } from "../src/link/cliClient.js";
import { LINK_CLI_FAKE_SCRIPT } from "./fixtures/fakeLinkCli.js";
import { LONG_CONTEXT } from "./helpers.js";

let dir: string;
let client: CliLinkClient;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-link-cli-"));
  const cliPath = join(dir, "cli.mjs");
  writeFileSync(cliPath, LINK_CLI_FAKE_SCRIPT);
  client = new CliLinkClient({ cliPath, env: { PATH: process.env.PATH } });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("CliLinkClient", () => {
  it("always creates in test mode, without self-approval or blocking approval", async () => {
    const result = await client.createSpendRequest({
      merchantName: "REI",
      merchantUrl: "https://rei.com",
      context: LONG_CONTEXT,
      amountCents: 2000,
      currency: "usd",
      lineItems: ["name:Sealant,unit_amount:2000,quantity:1"],
      totals: [],
      metadata: { gateway_attempt_id: "att_1", gateway_risk_score: "40" },
      idempotencyKey: "att_1",
    });
    const argv = result.argv as string[];
    expect(argv.slice(0, 2)).toEqual(["spend-request", "create"]);
    expect(argv).toContain("--test");
    expect(argv).toContain("--no-request-approval");
    expect(argv).not.toContain("--approve");
    expect(argv).not.toContain("--approval-detail");
    expect(argv.slice(-2)).toEqual(["--format", "json"]);
    expect(argv).toEqual(expect.arrayContaining(["--metadata", "gateway_attempt_id:att_1", "--idempotency-key", "att_1"]));
    expect(argv[argv.indexOf("--context") + 1]).toBe(LONG_CONTEXT);
  });

  it("passes card output file and polling flags on retrieve", async () => {
    const result = await client.retrieveSpendRequest("lsrq_1", { cardOutputFile: "/tmp/c.json", waitSeconds: 30 });
    expect(result.argv).toEqual([
      "spend-request", "retrieve", "lsrq_1",
      "--include", "card", "--output-file", "/tmp/c.json", "--force",
      "--interval", "2", "--timeout", "30",
      "--format", "json",
    ]);
  });

  it("surfaces link-cli JSON errors as LinkCliError", async () => {
    await expect(client.requestApproval("lsrq_fail")).rejects.toMatchObject({
      name: "LinkCliError",
      code: "UNKNOWN",
      message: 'Not authenticated. Run "link-cli auth login" first.',
    });
  });
});

describe("parseJsonOutput", () => {
  it("takes the last document from streamed pretty-printed output", () => {
    const out = `{\n  "status": "pending_approval"\n}\n{\n  "status": "approved"\n}\n`;
    expect(parseJsonOutput(out)).toEqual({ status: "approved" });
  });

  it("returns undefined for empty or garbage output", () => {
    expect(parseJsonOutput("")).toBeUndefined();
    expect(parseJsonOutput("oops")).toBeUndefined();
  });
});
