import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createEditorServer } from "./server.js";
import { SessionTracker } from "./sessions.js";

export interface LaunchOptions {
  profilePath: string;
  staticDir: string;
  port: number;
  /** Skip opening a browser and print the link instead. */
  noOpen?: boolean;
  /** Resolves true if the browser was launched. Defaults to the platform's opener. */
  openBrowser?: (url: string) => Promise<boolean>;
  log?: (line: string) => void;
  /** How long to wait for the opened tab to connect before printing the link as a fallback. */
  connectTimeoutMs?: number;
  idleGraceMs?: number;
  token?: string;
  /** Resolves when the editor should stop early (e.g. Ctrl+C). */
  stopSignal?: Promise<void>;
}

export interface LaunchResult {
  reason: "closed" | "stopped";
  /** policyVersion of the last save, if anything was saved. */
  savedPolicyVersion: string | null;
}

/**
 * Serves the editor, opens it in the browser, and resolves once every editor tab has been closed.
 * The access link is printed only when the browser can't be opened or never connects.
 */
export async function launchEditor(options: LaunchOptions): Promise<LaunchResult> {
  const log = options.log ?? ((line) => console.log(line));
  const sessions = new SessionTracker({ idleGraceMs: options.idleGraceMs });
  let savedPolicyVersion: string | null = null;
  const { server, token } = createEditorServer({
    profilePath: options.profilePath,
    staticDir: options.staticDir,
    token: options.token,
    sessions,
    onSaved: (version) => {
      savedPolicyVersion = version;
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/#token=${token}`;

  let linkShown = false;
  const showLink = (why: string) => {
    if (linkShown) return;
    linkShown = true;
    log(`${why} Open this link to edit your risk profile (don't share it):`);
    log(`  ${url}`);
    log("Close the tab when you're done, or press Ctrl+C.");
  };

  // Listen before opening the browser so a fast tab can't connect or close unnoticed.
  let connected = false;
  let connectTimer: NodeJS.Timeout | undefined;
  sessions.once("connected", () => {
    connected = true;
    clearTimeout(connectTimer);
  });
  const finished = new Promise<LaunchResult["reason"]>((resolve) => {
    sessions.once("idle", () => resolve("closed"));
    options.stopSignal?.then(() => resolve("stopped"));
  });

  log(`Opening the risk profile editor for ${options.profilePath}`);
  if (options.noOpen) {
    showLink("Not opening a browser (--no-open).");
  } else if (!(await (options.openBrowser ?? openInBrowser)(url).catch(() => false))) {
    showLink("Couldn't open your browser.");
  } else {
    log("Close the browser tab when you're done.");
    if (!connected) {
      connectTimer = setTimeout(
        () => showLink("The editor didn't load in your browser."),
        options.connectTimeoutMs ?? 30_000,
      );
    }
  }

  const reason = await finished;

  clearTimeout(connectTimer);
  sessions.dispose();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  return { reason, savedPolicyVersion };
}

/** Opens `url` with the OS default browser. Resolves false if no opener exists or it fails. */
export function openInBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", url] }
        : { file: "xdg-open", args: [url] };
  return new Promise((resolve) => {
    execFile(command.file, command.args, { timeout: 15_000 }, (error) => resolve(!error));
  });
}
