import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { profileSchema, type LoadedProfile } from "./schema.js";

export class ProfileError extends Error {
  override name = "ProfileError";
}

export function parseProfile(source: string): LoadedProfile {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    throw new ProfileError(`Risk profile is not valid YAML: ${(err as Error).message}`);
  }
  const result = profileSchema.safeParse(raw);
  if (!result.success) {
    throw new ProfileError(`Risk profile is invalid:\n${z.prettifyError(result.error)}`);
  }
  return {
    profile: result.data,
    policyVersion: createHash("sha256").update(source).digest("hex").slice(0, 12),
  };
}

export function loadProfile(path: string): LoadedProfile {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (err) {
    throw new ProfileError(`Cannot read risk profile at ${path}: ${(err as Error).message}`);
  }
  return parseProfile(source);
}
