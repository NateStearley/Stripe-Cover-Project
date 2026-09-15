import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  LinkCliError,
  type CreateSpendRequestParams,
  type LinkApproval,
  type LinkClient,
  type LinkSpendRequest,
  type RetrieveOptions,
} from "./client.js";

export interface CliLinkClientOptions {
  /** Path to link-cli's JS entry point. Defaults to the pinned @stripe/link-cli dependency. */
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Invokes link-cli without a shell, always in JSON and test mode. Never passes
 * --approve / --approval-detail (delegated self-approval) — Stripe's user approval
 * step must stay in the loop.
 */
export class CliLinkClient implements LinkClient {
  private readonly cliPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(options: CliLinkClientOptions = {}) {
    this.cliPath = options.cliPath ?? defaultCliPath();
    this.env = { ...(options.env ?? process.env), NO_UPDATE_NOTIFIER: "1" };
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async createSpendRequest(p: CreateSpendRequestParams): Promise<LinkSpendRequest> {
    const args = [
      "spend-request", "create",
      "--merchant-name", p.merchantName,
      "--merchant-url", p.merchantUrl,
      "--context", p.context,
      "--amount", String(p.amountCents),
      "--currency", p.currency,
      "--idempotency-key", p.idempotencyKey,
      "--no-request-approval",
      "--test",
    ];
    if (p.paymentMethodId) args.push("--payment-method-id", p.paymentMethodId);
    for (const item of p.lineItems) args.push("--line-item", item);
    for (const total of p.totals) args.push("--total", total);
    for (const [key, value] of Object.entries(p.metadata)) args.push("--metadata", `${key}:${value}`);
    return (await this.run(args)) as LinkSpendRequest;
  }

  async retrieveSpendRequest(id: string, options: RetrieveOptions = {}): Promise<LinkSpendRequest> {
    const args = ["spend-request", "retrieve", id];
    let timeoutMs = this.timeoutMs;
    if (options.cardOutputFile) {
      args.push("--include", "card", "--output-file", options.cardOutputFile, "--force");
    }
    if (options.waitSeconds && options.waitSeconds > 0) {
      args.push("--interval", "2", "--timeout", String(options.waitSeconds));
      timeoutMs += options.waitSeconds * 1000;
    }
    return (await this.run(args, timeoutMs)) as LinkSpendRequest;
  }

  async requestApproval(id: string): Promise<LinkApproval> {
    return (await this.run(["spend-request", "request-approval", id])) as LinkApproval;
  }

  async cancelSpendRequest(id: string): Promise<LinkSpendRequest> {
    return (await this.run(["spend-request", "cancel", id])) as LinkSpendRequest;
  }

  async listPaymentMethods(): Promise<unknown> {
    return this.run(["payment-methods", "list"]);
  }

  private run(args: string[], timeoutMs = this.timeoutMs): Promise<unknown> {
    return new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [this.cliPath, ...args, "--format", "json"],
        { env: this.env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const body = parseJsonOutput(stdout);
          if (error) {
            const code = typeof body?.code === "string" ? body.code : "LINK_CLI_FAILED";
            const message =
              typeof body?.message === "string" ? body.message : (stderr.trim() || error.message);
            reject(new LinkCliError(code, message));
            return;
          }
          if (body === undefined) {
            reject(new LinkCliError("LINK_CLI_BAD_OUTPUT", `Unparseable link-cli output: ${stdout.slice(0, 500)}`));
            return;
          }
          resolve(body);
        },
      );
    });
  }
}

/** link-cli pretty-prints JSON; streaming commands may emit several documents, the last wins. */
export function parseJsonOutput(stdout: string): Record<string, any> | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    const docs = text.split(/\n(?=[{[])/);
    for (let i = docs.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(docs.slice(i).join("\n"));
      } catch {
        // keep widening
      }
    }
    return undefined;
  }
}

function defaultCliPath(): string {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve("@stripe/link-cli/package.json");
  const pkg = require(pkgJson) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["link-cli"] ?? "dist/cli.js";
  return join(dirname(pkgJson), bin);
}
