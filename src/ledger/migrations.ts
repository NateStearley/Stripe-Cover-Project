import type Database from "better-sqlite3";

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE spend_attempts (
    id                    TEXT PRIMARY KEY,
    created_at            INTEGER NOT NULL,          -- epoch ms
    updated_at            INTEGER NOT NULL,          -- epoch ms
    project               TEXT NOT NULL,
    amount_cents          INTEGER NOT NULL,
    currency              TEXT NOT NULL,
    merchant_name         TEXT,
    merchant_url          TEXT,
    payment_method_id     TEXT,
    category              TEXT NOT NULL,
    category_source       TEXT NOT NULL,             -- merchant_map | declared | default
    decision              TEXT NOT NULL CHECK (decision IN ('allow', 'flag', 'deny')),
    reason                TEXT NOT NULL,
    reasons_json          TEXT NOT NULL,
    risk_score            INTEGER NOT NULL,
    policy_version        TEXT NOT NULL,
    link_spend_request_id TEXT UNIQUE,               -- set once forwarded to Stripe
    final_status          TEXT                       -- latest Link status, or forward_failed
  );
  CREATE INDEX spend_attempts_project_created ON spend_attempts (project, created_at);
  `,
];

export function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
