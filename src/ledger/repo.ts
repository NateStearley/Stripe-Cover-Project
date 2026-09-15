import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { CategorySource } from "../profile/categories.js";
import type { Decision, PriorAttempt } from "../policy/types.js";
import { migrate } from "./migrations.js";

export interface SpendAttempt {
  id: string;
  created_at: number;
  updated_at: number;
  project: string;
  amount_cents: number;
  currency: string;
  merchant_name: string | null;
  merchant_url: string | null;
  payment_method_id: string | null;
  category: string;
  category_source: CategorySource;
  decision: Decision;
  reason: string;
  reasons_json: string;
  risk_score: number;
  policy_version: string;
  link_spend_request_id: string | null;
  final_status: string | null;
}

export type NewSpendAttempt = Omit<SpendAttempt, "updated_at" | "link_spend_request_id" | "final_status">;

export interface ListOptions {
  project?: string;
  limit?: number;
}

export class Ledger {
  readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.pragma("journal_mode = WAL");
    migrate(this.db);
  }

  static open(path: string, options: { busyTimeoutMs?: number } = {}): Ledger {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path, { timeout: options.busyTimeoutMs ?? 5000 });
    return new Ledger(db);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Runs `fn` under BEGIN IMMEDIATE so the read-evaluate-insert sequence holds the write
   * lock; a second gateway process on the same ledger waits instead of evaluating stale rows.
   */
  immediate<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  priorAttempts(project: string, sinceMs: number): PriorAttempt[] {
    return this.db
      .prepare(
        `SELECT created_at AS createdAt, amount_cents AS amountCents, decision, final_status AS finalStatus
         FROM spend_attempts WHERE project = ? AND created_at > ? ORDER BY created_at`,
      )
      .all(project, sinceMs) as PriorAttempt[];
  }

  insert(row: NewSpendAttempt): void {
    this.db
      .prepare(
        `INSERT INTO spend_attempts (
          id, created_at, updated_at, project, amount_cents, currency, merchant_name, merchant_url,
          payment_method_id, category, category_source, decision, reason, reasons_json, risk_score, policy_version
        ) VALUES (
          @id, @created_at, @created_at, @project, @amount_cents, @currency, @merchant_name, @merchant_url,
          @payment_method_id, @category, @category_source, @decision, @reason, @reasons_json, @risk_score, @policy_version
        )`,
      )
      .run(row);
  }

  attachLinkRequest(id: string, linkSpendRequestId: string, status: string, now: number): void {
    this.db
      .prepare(
        `UPDATE spend_attempts SET link_spend_request_id = ?, final_status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(linkSpendRequestId, status, now, id);
  }

  setStatus(id: string, status: string, now: number): void {
    this.db.prepare(`UPDATE spend_attempts SET final_status = ?, updated_at = ? WHERE id = ?`).run(status, now, id);
  }

  get(id: string): SpendAttempt | undefined {
    return this.db.prepare(`SELECT * FROM spend_attempts WHERE id = ?`).get(id) as SpendAttempt | undefined;
  }

  findByLinkId(linkSpendRequestId: string): SpendAttempt | undefined {
    return this.db
      .prepare(`SELECT * FROM spend_attempts WHERE link_spend_request_id = ?`)
      .get(linkSpendRequestId) as SpendAttempt | undefined;
  }

  list(options: ListOptions = {}): SpendAttempt[] {
    const limit = options.limit ?? 50;
    if (options.project) {
      return this.db
        .prepare(`SELECT * FROM spend_attempts WHERE project = ? ORDER BY created_at DESC LIMIT ?`)
        .all(options.project, limit) as SpendAttempt[];
    }
    return this.db
      .prepare(`SELECT * FROM spend_attempts ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as SpendAttempt[];
  }
}
