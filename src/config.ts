import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface GatewayConfig {
  profilePath: string;
  ledgerPath: string;
  credentialsDir: string;
}

const HOME_DIR = join(homedir(), ".link-risk-gateway");

/** CLI flags win over env vars, which win over defaults under ~/.link-risk-gateway. */
export function resolveConfig(flags: Partial<GatewayConfig>, env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    profilePath: resolve(flags.profilePath ?? env.LINK_RISK_PROFILE ?? join(HOME_DIR, "risk-profile.yaml")),
    ledgerPath: resolve(flags.ledgerPath ?? env.LINK_RISK_LEDGER ?? join(HOME_DIR, "ledger.db")),
    credentialsDir: resolve(flags.credentialsDir ?? env.LINK_RISK_CREDENTIALS_DIR ?? join(HOME_DIR, "credentials")),
  };
}
