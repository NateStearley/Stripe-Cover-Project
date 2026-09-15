import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchEditor, type LaunchOptions } from "../src/editor/launch.js";
import { SessionTracker } from "../src/editor/sessions.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("SessionTracker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("goes idle only after every tab has been gone for the grace period", () => {
    const sessions = new SessionTracker({ idleGraceMs: 3000 });
    const idle = vi.fn();
    const connected = vi.fn();
    sessions.on("idle", idle).on("connected", connected);

    const closeA = sessions.open();
    const closeB = sessions.open();
    expect(connected).toHaveBeenCalledTimes(1);

    closeA();
    vi.advanceTimersByTime(10_000);
    expect(idle).not.toHaveBeenCalled(); // B is still open

    closeB();
    vi.advanceTimersByTime(2999);
    expect(idle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it("treats a quick reconnect (page reload) as the same session", () => {
    const sessions = new SessionTracker({ idleGraceMs: 3000 });
    const idle = vi.fn();
    sessions.on("idle", idle);

    const close = sessions.open();
    close();
    vi.advanceTimersByTime(500);
    const reopened = sessions.open();
    vi.advanceTimersByTime(10_000);
    expect(idle).not.toHaveBeenCalled();

    reopened();
    close(); // closing twice is harmless
    vi.advanceTimersByTime(3000);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it("never goes idle if no tab ever connected", () => {
    const sessions = new SessionTracker({ idleGraceMs: 10 });
    const idle = vi.fn();
    sessions.on("idle", idle);
    vi.advanceTimersByTime(60_000);
    expect(idle).not.toHaveBeenCalled();
  });
});

describe("launchEditor", () => {
  const TOKEN = "launch-token";
  let dir: string;
  let lines: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "launch-"));
    mkdirSync(join(dir, "ui"));
    writeFileSync(join(dir, "ui", "index.html"), "<!doctype html>");
    lines = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const options = (overrides: Partial<LaunchOptions>): LaunchOptions => ({
    profilePath: join(dir, "risk-profile.yaml"),
    staticDir: join(dir, "ui"),
    port: 0,
    token: TOKEN,
    idleGraceMs: 50,
    connectTimeoutMs: 200,
    log: (line) => lines.push(line),
    ...overrides,
  });

  /** Plays the part of the browser tab: holds /api/session open until the returned close() is called. */
  async function openTab(url: string) {
    const origin = new URL(url).origin;
    const controller = new AbortController();
    const res = await fetch(`${origin}/api/session`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // "connected"
    return { origin, close: () => controller.abort() };
  }

  it("opens the browser without printing the link, and exits on its own when the tab closes", async () => {
    let tab: Awaited<ReturnType<typeof openTab>> | undefined;
    const done = launchEditor(
      options({
        openBrowser: async (url) => {
          tab = await openTab(url);
          return true;
        },
      }),
    );
    await vi.waitFor(() => expect(tab).toBeDefined());

    const saved = await fetch(`${tab!.origin}/api/profile`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const { profile } = await saved.json();
    await fetch(`${tab!.origin}/api/profile`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ profile, basePolicyVersion: null }),
    });

    tab!.close();
    const result = await done;
    expect(result.reason).toBe("closed");
    expect(result.savedPolicyVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines).toContain("Close the browser tab when you're done.");
    await expect(fetch(`${tab!.origin}/`)).rejects.toThrow(); // server is gone
  });

  it("prints the link when the browser can't be opened", async () => {
    const stop = deferred();
    const done = launchEditor(options({ openBrowser: async () => false, stopSignal: stop.promise }));
    await vi.waitFor(() => expect(lines.join("\n")).toContain(`#token=${TOKEN}`));
    expect(lines.join("\n")).toContain("Couldn't open your browser.");
    stop.resolve();
    expect((await done).reason).toBe("stopped");
  });

  it("prints the link if the opened browser never loads the editor", async () => {
    const stop = deferred();
    const done = launchEditor(options({ openBrowser: async () => true, stopSignal: stop.promise }));
    await vi.waitFor(() => expect(lines.join("\n")).toContain("didn't load in your browser"), { timeout: 2000 });
    expect(lines.join("\n")).toContain(`#token=${TOKEN}`);
    stop.resolve();
    await done;
  });

  it("prints the link with --no-open, then still exits when that tab is closed", async () => {
    const done = launchEditor(options({ noOpen: true }));
    await vi.waitFor(() => expect(lines.join("\n")).toContain("#token="));
    const url = lines.find((l) => l.includes("#token="))!.trim();
    const tab = await openTab(url);
    tab.close();
    expect((await done).reason).toBe("closed");
    expect((await done).savedPolicyVersion).toBeNull();
  });

  it("requires the token to hold a session", async () => {
    const stop = deferred();
    let origin = "";
    const done = launchEditor(
      options({
        openBrowser: async (url) => {
          origin = new URL(url).origin;
          return true;
        },
        stopSignal: stop.promise,
      }),
    );
    await vi.waitFor(() => expect(origin).not.toBe(""));
    expect((await fetch(`${origin}/api/session`)).status).toBe(401);
    stop.resolve();
    await done;
  });
});
