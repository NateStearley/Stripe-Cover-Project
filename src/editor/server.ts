import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { z } from "zod";
import { parseProfile, ProfileError } from "../profile/load.js";
import { applyPreset, PRESETS } from "../profile/presets.js";
import { profileSchema, type RiskProfile } from "../profile/schema.js";
import { serializeProfile } from "../profile/serialize.js";
import type { SessionTracker } from "./sessions.js";

export interface EditorServerOptions {
  profilePath: string;
  /** Directory containing the built React app (index.html + assets). */
  staticDir: string;
  token?: string;
  /** Tracks open editor tabs via GET /api/session. */
  sessions?: SessionTracker;
  onSaved?: (policyVersion: string) => void;
}

const SESSION_HEARTBEAT_MS = 15_000;

export interface ProfileResponse {
  path: string;
  exists: boolean;
  /** Parsed profile, or a starter profile when the file doesn't exist yet. */
  profile: RiskProfile | null;
  /** Hash of the file on disk: null when it doesn't exist, "invalid" when it can't be parsed. */
  policyVersion: string | null;
  /** Set when the file exists but is invalid; the editor offers to start fresh. */
  error?: string;
}

const MAX_BODY_BYTES = 256 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * Localhost-only editor backend. Every API call needs the per-launch token (handed only to the
 * browser the editor opened) and a localhost Host header, so neither a web page nor a process that
 * didn't see the token can change the risk profile.
 */
export function createEditorServer(options: EditorServerOptions): { server: Server; token: string } {
  const token = options.token ?? randomBytes(24).toString("base64url");

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { error: (err as Error).message }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!isLocalHost(req.headers.host)) return send(res, 403, { error: "Editor only accepts localhost requests" });

    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      if (!hasToken(req, token)) return send(res, 401, { error: "Missing or invalid editor token" });
      if (url.pathname === "/api/session" && req.method === "GET") return holdSession(req, res);
      if (url.pathname === "/api/profile" && req.method === "GET") return send(res, 200, readProfile(options.profilePath));
      if (url.pathname === "/api/profile" && req.method === "PUT") {
        return saveProfile(req, res, options.profilePath, options.onSaved);
      }
      return send(res, 404, { error: "Not found" });
    }
    if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
    return serveStatic(res, options.staticDir, url.pathname);
  }

  /** Keeps the response open for as long as the tab is; the browser drops it when the tab closes. */
  function holdSession(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.write("connected\n");
    const heartbeat = setInterval(() => res.write("ping\n"), SESSION_HEARTBEAT_MS);
    const release = options.sessions?.open();
    req.socket.on("close", () => {
      clearInterval(heartbeat);
      release?.();
    });
  }

  return { server, token };
}

export function readProfile(path: string): ProfileResponse {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return { path, exists: false, profile: starterProfile(), policyVersion: null };
  }
  try {
    const { profile, policyVersion } = parseProfile(source);
    return { path, exists: true, profile, policyVersion };
  } catch (err) {
    return { path, exists: true, profile: null, policyVersion: "invalid", error: (err as Error).message };
  }
}

export function starterProfile(): RiskProfile {
  const safe = PRESETS.find((p) => p.id === "safe")!;
  return profileSchema.parse({
    version: 1,
    default_project: "personal",
    flag_threshold_pct: 80,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    projects: { personal: applyPreset(safe) },
  });
}

const saveBody = z.object({
  profile: z.unknown(),
  /** policyVersion the editor loaded; null when creating the file. Guards against clobbering outside edits. */
  basePolicyVersion: z.string().nullable(),
});

async function saveProfile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  onSaved: ((policyVersion: string) => void) | undefined,
) {
  let body: z.infer<typeof saveBody>;
  try {
    body = saveBody.parse(JSON.parse(await readBody(req)));
  } catch {
    return send(res, 400, { error: "Body must be JSON: { profile, basePolicyVersion }" });
  }

  const parsed = profileSchema.safeParse(body.profile);
  if (!parsed.success) {
    return send(res, 422, {
      error: "Profile is invalid",
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
    });
  }

  const current = readProfile(path);
  const currentVersion = current.policyVersion;
  if (currentVersion !== body.basePolicyVersion) {
    return send(res, 409, {
      error: "The profile file changed since you loaded it. Reload to see the latest version before saving.",
      currentPolicyVersion: currentVersion,
    });
  }

  const yaml = serializeProfile(parsed.data);
  // Belt and braces: never write a file the gateway would reject.
  let policyVersion: string;
  try {
    policyVersion = parseProfile(yaml).policyVersion;
  } catch (err) {
    if (err instanceof ProfileError) return send(res, 500, { error: `Refusing to save: ${err.message}` });
    throw err;
  }

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, yaml, { mode: 0o600 });
  renameSync(tmp, path); // atomic: the gateway never reads a half-written profile
  onSaved?.(policyVersion);
  return send(res, 200, { path, policyVersion, profile: parsed.data });
}

function serveStatic(res: ServerResponse, root: string, pathname: string) {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const file = join(root, relative === "" ? "index.html" : relative);
  if (file !== root && !file.startsWith(root + sep)) return send(res, 403, { error: "Forbidden" });
  const target = extname(file) ? file : join(root, "index.html");
  try {
    const content = readFileSync(target);
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'",
    });
    res.end(content);
  } catch {
    send(res, 404, { error: `Not found. Did you run "npm run build"? (${target})` });
  }
}

function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, "");
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function hasToken(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
