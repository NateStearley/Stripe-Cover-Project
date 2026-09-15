import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditorServer } from "../src/editor/server.js";
import { parseProfile } from "../src/profile/load.js";
import { applyPreset, PRESETS } from "../src/profile/presets.js";
import { PROFILE_YAML } from "./helpers.js";

const TOKEN = "test-token";
let dir: string;
let profilePath: string;
let base: string;
let close: () => Promise<void>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "editor-"));
  profilePath = join(dir, "profile", "risk-profile.yaml");
  const staticDir = join(dir, "ui");
  writeFileSync(join(dir, "placeholder"), "");
  const { server } = createEditorServer({ profilePath, staticDir, token: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

function api(path: string, init: RequestInit & { token?: string | null } = {}) {
  const headers = new Headers(init.headers);
  if (init.token !== null) headers.set("Authorization", `Bearer ${init.token ?? TOKEN}`);
  return fetch(`${base}${path}`, { ...init, headers });
}

function put(profile: unknown, basePolicyVersion: string | null) {
  return api("/api/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, basePolicyVersion }),
  });
}

describe("editor server", () => {
  it("rejects API calls without the launch token", async () => {
    expect((await api("/api/profile", { token: null })).status).toBe(401);
    expect((await api("/api/profile", { token: "wrong-token" })).status).toBe(401);
  });

  it("rejects non-localhost Host headers (DNS rebinding)", async () => {
    // fetch() won't let us override Host, so use node:http directly.
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${base}/api/profile`);
      request(
        { host: url.hostname, port: url.port, path: url.pathname, headers: { Host: "evil.example", Authorization: `Bearer ${TOKEN}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      )
        .on("error", reject)
        .end();
    });
    expect(status).toBe(403);
  });

  it("offers a starter profile when the file does not exist", async () => {
    const body = await (await api("/api/profile")).json();
    expect(body).toMatchObject({ exists: false, policyVersion: null, profile: { default_project: "personal" } });
    expect(body.profile.projects.personal.preset).toBe("safe");
  });

  it("creates the file, and the gateway can load exactly what was saved", async () => {
    const { profile } = await (await api("/api/profile")).json();
    profile.projects.personal = applyPreset(PRESETS.find((p) => p.id === "old-man-coffee")!);
    profile.projects.personal.blocked_merchants = ["WWW.Temu.com"];

    const res = await put(profile, null);
    expect(res.status).toBe(200);
    const saved = await res.json();

    const onDisk = parseProfile(readFileSync(profilePath, "utf8"));
    expect(onDisk.policyVersion).toBe(saved.policyVersion);
    expect(onDisk.profile.projects.personal).toMatchObject({
      preset: "old-man-coffee",
      per_transaction_cap_cents: 1500,
      blocked_merchants: ["temu.com"],
      quiet_hours: { start: "21:00", end: "07:00" },
    });
  });

  it("returns field-level issues and leaves the file untouched when invalid", async () => {
    writeFileSync(join(dir, "seed.yaml"), PROFILE_YAML);
    const { profile } = parseProfile(PROFILE_YAML);
    profile.projects.personal!.per_transaction_cap_cents = 99_999;

    const res = await put(profile, null);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.issues).toContainEqual({
      path: ["projects", "personal", "per_transaction_cap_cents"],
      message: expect.stringMatching(/Stripe's per-transaction limit/),
    });
    expect(() => readFileSync(profilePath)).toThrow();
  });

  it("refuses to overwrite a file that changed after it was loaded", async () => {
    const { profile } = await (await api("/api/profile")).json();
    const first = await (await put(profile, null)).json();

    // Someone edits the YAML by hand in the meantime.
    writeFileSync(profilePath, `${readFileSync(profilePath, "utf8")}\n# hand edit\n`);

    const stale = await put(profile, first.policyVersion);
    expect(stale.status).toBe(409);

    const fresh = await (await api("/api/profile")).json();
    expect((await put(profile, fresh.policyVersion)).status).toBe(200);
  });

  it("reports an unparseable file so the editor can offer to replace it", async () => {
    const { profile } = await (await api("/api/profile")).json();
    await put(profile, null);
    writeFileSync(profilePath, "version: [1");

    const body = await (await api("/api/profile")).json();
    expect(body).toMatchObject({ exists: true, profile: null, policyVersion: "invalid" });
    expect(body.error).toMatch(/not valid YAML/);
    expect((await put(profile, "invalid")).status).toBe(200);
  });

  it("does not serve files outside the UI directory", async () => {
    for (const path of ["/..%2Fplaceholder", "/%2e%2e/placeholder", "/..%5Cplaceholder"]) {
      expect((await fetch(`${base}${path}`)).status).not.toBe(200);
    }
  });
});
