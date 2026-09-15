#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "../config.js";
import { GatewayService } from "../gateway/service.js";
import { Ledger } from "../ledger/repo.js";
import { CliLinkClient } from "../link/cliClient.js";
import { createMcpServer } from "../mcp/server.js";
import { loadProfile } from "../profile/load.js";

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    ledger: { type: "string" },
    "credentials-dir": { type: "string" },
  },
});

const config = resolveConfig({
  profilePath: values.profile,
  ledgerPath: values.ledger,
  credentialsDir: values["credentials-dir"],
});

// Validate once at startup so a broken profile is visible immediately; the gateway
// still reloads it on every request and fails closed if it later becomes invalid.
try {
  const { policyVersion, profile } = loadProfile(config.profilePath);
  console.error(
    `link-risk-gateway: profile ${config.profilePath} (policy ${policyVersion}, projects: ${Object.keys(profile.projects).join(", ")})`,
  );
} catch (err) {
  console.error(`link-risk-gateway: ${(err as Error).message}\nAll spend requests will be denied until this is fixed.`);
}

mkdirSync(config.credentialsDir, { recursive: true, mode: 0o700 });
const ledger = Ledger.open(config.ledgerPath);
const gateway = new GatewayService({
  ledger,
  link: new CliLinkClient(),
  loadProfile: () => loadProfile(config.profilePath),
  credentialsDir: config.credentialsDir,
});

const server = createMcpServer(gateway);
await server.connect(new StdioServerTransport());
console.error(`link-risk-gateway: ledger ${config.ledgerPath}; listening on stdio (Stripe test mode)`);

const shutdown = () => {
  ledger.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
