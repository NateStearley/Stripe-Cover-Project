import type { RiskProfile } from "../../src/profile/schema.js";

export interface LoadResult {
  path: string;
  exists: boolean;
  profile: RiskProfile | null;
  policyVersion: string | null;
  error?: string;
}

export interface Issue {
  path: string[];
  message: string;
}

export type SaveResult =
  | { ok: true; policyVersion: string; profile: RiskProfile }
  | { ok: false; kind: "conflict" | "invalid" | "error"; message: string; issues?: Issue[] };

/** The launch token is passed in the URL fragment, which browsers never send to the server. */
export function readToken(): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get("token");
}

function headers(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export async function loadProfile(token: string): Promise<LoadResult> {
  const res = await fetch("/api/profile", { headers: headers(token) });
  if (!res.ok) throw new Error((await res.json()).error ?? `Load failed (${res.status})`);
  return res.json();
}

/**
 * Holds a long-lived request open while this tab is open; closing the tab ends it, which is how the
 * editor command knows to exit. Calls `onEnded` if the editor stops while the tab is still open.
 */
export function holdSession(token: string, onEnded: () => void): () => void {
  const controller = new AbortController();
  void (async () => {
    try {
      const res = await fetch("/api/session", { headers: headers(token), signal: controller.signal });
      const reader = res.body?.getReader();
      while (reader && !(await reader.read()).done);
    } catch {
      // Aborted by cleanup, or the server went away; either way, fall through.
    }
    if (!controller.signal.aborted) onEnded();
  })();
  return () => controller.abort();
}

export async function saveProfile(
  token: string,
  profile: RiskProfile,
  basePolicyVersion: string | null,
): Promise<SaveResult> {
  const res = await fetch("/api/profile", {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify({ profile, basePolicyVersion }),
  });
  const body = await res.json();
  if (res.ok) return { ok: true, policyVersion: body.policyVersion, profile: body.profile };
  const kind = res.status === 409 ? "conflict" : res.status === 422 ? "invalid" : "error";
  return { ok: false, kind, message: body.error ?? `Save failed (${res.status})`, issues: body.issues };
}
