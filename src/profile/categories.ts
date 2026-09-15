import { normalizeDomain, type RiskProfile } from "./schema.js";

export const UNCATEGORIZED = "uncategorized";

export type CategorySource = "merchant_map" | "declared" | "default";

export interface ResolvedCategory {
  category: string;
  source: CategorySource;
}

/**
 * The profile's merchant map is authoritative: Claude, the party being policed, must not be
 * able to relabel a mapped merchant. Subdomains match their parent entry, and the
 * longest matching entry wins.
 */
export function resolveCategory(
  profile: RiskProfile,
  merchantUrl: string | undefined,
  declared: string | undefined,
): ResolvedCategory {
  const host = merchantUrl ? hostnameOf(merchantUrl) : undefined;
  if (host) {
    let best: string | undefined;
    for (const domain of Object.keys(profile.merchant_categories)) {
      if (matchesDomain(host, domain) && (!best || domain.length > best.length)) {
        best = domain;
      }
    }
    if (best) return { category: profile.merchant_categories[best]!, source: "merchant_map" };
  }
  const trimmed = declared?.trim().toLowerCase();
  if (trimmed) return { category: trimmed, source: "declared" };
  return { category: UNCATEGORIZED, source: "default" };
}

/** True when `host` is `domain` or one of its subdomains. Both must already be normalized. */
export function matchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function hostnameOf(url: string): string | undefined {
  try {
    return normalizeDomain(new URL(url.includes("://") ? url : `https://${url}`).hostname);
  } catch {
    return undefined;
  }
}
