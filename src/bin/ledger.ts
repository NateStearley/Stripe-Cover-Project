#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolveConfig } from "../config.js";
import { Ledger, type SpendAttempt } from "../ledger/repo.js";
import { formatCents } from "../policy/types.js";

const { values } = parseArgs({
  options: {
    ledger: { type: "string" },
    project: { type: "string" },
    limit: { type: "string", default: "25" },
    json: { type: "boolean", default: false },
  },
});

const { ledgerPath } = resolveConfig({ ledgerPath: values.ledger });
const ledger = Ledger.open(ledgerPath);
const rows = ledger.list({ project: values.project, limit: Number(values.limit) });
ledger.close();

if (values.json) {
  console.log(JSON.stringify(rows, null, 2));
} else if (rows.length === 0) {
  console.log(`No spend attempts in ${ledgerPath}`);
} else {
  printTable(rows);
}

function printTable(rows: SpendAttempt[]): void {
  const table = rows.map((r) => ({
    time: new Date(r.created_at).toISOString().replace("T", " ").slice(0, 19),
    project: r.project,
    amount: formatCents(r.amount_cents),
    merchant: r.merchant_name ?? "",
    category: r.category,
    decision: r.decision.toUpperCase(),
    score: String(r.risk_score),
    status: r.final_status ?? "",
    link_id: r.link_spend_request_id ?? "",
    reason: r.reason,
  }));
  const keys = Object.keys(table[0]!) as (keyof (typeof table)[number])[];
  const widths = keys.map((k) =>
    k === "reason" ? 0 : Math.max(k.length, ...table.map((row) => row[k].length)),
  );
  const line = (cells: string[]) => cells.map((c, i) => (widths[i] ? c.padEnd(widths[i]!) : c)).join("  ");
  console.log(line(keys));
  for (const row of table) console.log(line(keys.map((k) => row[k])));
}
