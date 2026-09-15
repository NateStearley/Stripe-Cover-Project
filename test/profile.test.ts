import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveCategory } from "../src/profile/categories.js";
import { parseProfile, ProfileError } from "../src/profile/load.js";
import { PROFILE_YAML, testProfile } from "./helpers.js";

describe("profile loading", () => {
  it("parses the shipped example profile", () => {
    const loaded = parseProfile(readFileSync("examples/risk-profile.yaml", "utf8"));
    expect(Object.keys(loaded.profile.projects)).toEqual(["personal", "gravel-research"]);
    expect(loaded.policyVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  it("derives policy_version from file contents", () => {
    expect(parseProfile(PROFILE_YAML).policyVersion).toBe(parseProfile(PROFILE_YAML).policyVersion);
    expect(parseProfile(`${PROFILE_YAML}\n# edited`).policyVersion).not.toBe(parseProfile(PROFILE_YAML).policyVersion);
  });

  it("defaults flag_threshold_pct to 80", () => {
    const yaml = PROFILE_YAML.replace("flag_threshold_pct: 80\n", "");
    expect(parseProfile(yaml).profile.flag_threshold_pct).toBe(80);
  });

  it("rejects caps looser than Stripe's limits", () => {
    const yaml = PROFILE_YAML.replace("daily_cap_cents: 50000", "daily_cap_cents: 50001");
    expect(() => parseProfile(yaml)).toThrow(/Stripe's daily limit/);
  });

  it("rejects a per-transaction cap above the daily cap", () => {
    const yaml = PROFILE_YAML.replace("per_transaction_cap_cents: 5000", "per_transaction_cap_cents: 16000");
    expect(() => parseProfile(yaml)).toThrow(/must not exceed daily_cap_cents/);
  });

  it("rejects an undefined default_project", () => {
    expect(() => parseProfile(PROFILE_YAML.replace("default_project: personal", "default_project: nope"))).toThrow(
      /"nope" is not defined/,
    );
  });

  it("rejects unknown keys so typos don't silently disable a rule", () => {
    const yaml = PROFILE_YAML.replace("max_requests: 3", "max_request: 3");
    expect(() => parseProfile(yaml)).toThrow(ProfileError);
  });

  it("rejects invalid YAML", () => {
    expect(() => parseProfile("version: [1")).toThrow(/not valid YAML/);
  });
});

describe("category resolution", () => {
  const { profile } = testProfile();

  it("lets the merchant map override Claude's declared category", () => {
    expect(resolveCategory(profile, "https://www.draftkings.com/deposit", "sports")).toEqual({
      category: "gambling",
      source: "merchant_map",
    });
  });

  it("matches subdomains of mapped domains", () => {
    expect(resolveCategory(profile, "https://sportsbook.draftkings.com", undefined).category).toBe("gambling");
    expect(resolveCategory(profile, "https://notdraftkings.com", undefined).category).toBe("uncategorized");
  });

  it("accepts URLs without a scheme", () => {
    expect(resolveCategory(profile, "rei.com/product/123", undefined).category).toBe("outdoor-gear");
  });

  it("falls back to the declared category, normalized", () => {
    expect(resolveCategory(profile, "https://example.com", " Software ")).toEqual({
      category: "software",
      source: "declared",
    });
  });

  it("falls back to uncategorized", () => {
    expect(resolveCategory(profile, "https://example.com", undefined)).toEqual({
      category: "uncategorized",
      source: "default",
    });
  });
});
