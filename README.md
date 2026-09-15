# Link Risk Gateway

A policy gateway between Claude and [Stripe Link's agent wallet](https://github.com/stripe/link-cli). It checks
every spend request against a risk profile you write, per project, **before** it reaches Stripe. Stripe's own
approval step is never bypassed.

Stripe's only built-in guardrails are global and fixed ($500/transaction, $500/day, $20k/30 days). The
gateway adds:

- per-project caps
- category blocks
- rolling window lookback and custom cap
- a local audit ledger

```
Claude ──MCP──▶ Risk Gateway ──deny──▶ back to Claude (never reaches Stripe)
                  │  policy engine + SQLite ledger
                  └──allow / flag──▶ link-cli (test mode) ──▶ Stripe Link ──▶ your approval in the Link app
```

## Setup

This project supports Claude Code only.

```bash
LINK_CLI_SKIP_SKILL_INSTALL=1 npm install   # see "Keep Claude off the direct Link path" below
npm run build
npx link-cli auth login                     # run in your own terminal; connects your Link account
mkdir -p ~/.link-risk-gateway
cp examples/risk-profile.yaml ~/.link-risk-gateway/risk-profile.yaml
claude mcp add link-risk-gateway -- node "$PWD/dist/bin/gateway.js"
```

Then work through the next section before your first Claude session. The gateway only protects you if it is
the **only** way Claude can reach Link.

## Keep Claude off the direct Link path

link-cli keeps its login credentials on disk. Anything on your machine that can run link-cli can create spend
requests without the gateway, so without risk checks and without the gateway's forced `--test` flag. Stripe
ships several ready-made ways to give Claude that direct access. Close every one:

| Direct path                                                                                                                         | How to close it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | How to check                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Stripe's Link skills** (`link-cli`, `create-payment-credential`, `financial-insights`). These tell Claude to run link-cli itself. | **`npm install` of `@stripe/link-cli` installs them globally without asking**: its `postinstall` script runs `npx skills add stripe/link-cli -g -y`. Always install with `LINK_CLI_SKIP_SKILL_INSTALL=1`. If they're already installed, turn them off with `skillOverrides` (in `examples/claude-settings.json`), or delete them: `rm ~/.claude/skills/{link-cli,create-payment-credential,financial-insights}` and `rm -r ~/.agents/skills/{link-cli,create-payment-credential,financial-insights}`. | `ls ~/.claude/skills .claude/skills`                                                               |
| **Stripe's Claude Code plugin** (the link-cli repo ships a `.claude-plugin`)                                                        | Don't install it. If you did, uninstall it from `/plugin`.                                                                                                                                                                                                                                                                                                                                                                                                                                            | `/plugin`                                                                                          |
| **link-cli's own MCP server** (`link-cli --mcp`)                                                                                    | Don't register it. Remove any existing entry with `claude mcp remove <name>`. Also check for a project `.mcp.json`.                                                                                                                                                                                                                                                                                                                                                                                   | `claude mcp list` should show `link-risk-gateway` and no other server that runs `@stripe/link-cli` |
| **link-cli's HTTP server** (`link-cli serve`, on 127.0.0.1:54321)                                                                   | Don't run it. It exposes your wallet to any local process.                                                                                                                                                                                                                                                                                                                                                                                                                                            | `lsof -i :54321` returns nothing                                                                   |
| **Claude running link-cli in its shell**                                                                                            | Merge the `permissions.deny` rules from `examples/claude-settings.json` into `~/.claude/settings.json`. They cover `link-cli`, `npx link-cli`, `npx [-y\|--yes] @stripe/link-cli`, `npm exec`, and calls by file path.                                                                                                                                                                                                                                                                                | Ask Claude to run `npx link-cli --version`. It should be refused.                                  |
| **Link tokens in the environment** (`LINK_ACCESS_TOKEN`, `LINK_REFRESH_TOKEN`)                                                      | Don't set them in your shell profile or in the `env` block of Claude Code settings. Log in with `link-cli auth login` instead.                                                                                                                                                                                                                                                                                                                                                                        | `env \| grep LINK_`                                                                                |
| **Claude loosening its own risk profile**, by editing the YAML file or starting the editor to read its access link                  | The `Edit`, `Write` and `Bash` deny rules for `~/.link-risk-gateway` and the editor in `examples/claude-settings.json`. Run `npm run editor` yourself, in a normal terminal. Its access link is printed only there. If your profile lives somewhere else (`--profile` / `LINK_RISK_PROFILE`), change those rules to that path.                                                                                                                                                                        | Ask Claude to add a line to `~/.link-risk-gateway/risk-profile.yaml`. It should be refused.        |

Two things about these protections:

- **The deny rules match command text, so they're a guardrail, not a sandbox.** They stop Claude from running
  link-cli directly, but not from, say, writing a script that calls it internally. Watch for Claude trying to
  pay by any route other than the `link-risk-gateway` tools, and treat that as a bug to report.
- **The deny rules also block your own `!` commands inside Claude Code.** Run `link-cli auth login` and any
  manual link-cli commands in a normal terminal.

The gateway itself is unaffected by the deny rules: it runs link-cli as its own subprocess, not through
Claude's shell.

## Configuration

In order of precedence:

1. Flags: `--profile`, `--ledger`, `--credentials-dir`
2. Environment variables: `LINK_RISK_PROFILE`, `LINK_RISK_LEDGER`, `LINK_RISK_CREDENTIALS_DIR`
3. Defaults, under `~/.link-risk-gateway/`

## Editing the risk profile

```bash
npm run editor                # run in your own terminal, not through Claude
```

This opens the editor in your browser. **Close the tab when you're done**: the command exits on its own and
tells you whether anything was saved. You don't need to press Ctrl+C.

The editor runs on 127.0.0.1:4319, and the link it opens includes a one-time access token. The link is printed
in the terminal only if your browser can't be opened, or the editor hasn't loaded after 30 seconds. Other
options:

- `--profile <path>` edits a different file.
- `--port <n>` uses a different port.
- `--no-open` prints the link instead of opening a browser.

For each project, choose a preset, then adjust any setting:

| Preset                | Per purchase | Per day | Longer-period cap   | Blocked categories                                                    | Quiet hours | Burst limit   |
| --------------------- | ------------ | ------- | ------------------- | --------------------------------------------------------------------- | ----------- | ------------- |
| ☕ **Old Man Coffee** | $15          | $30     | $75 per 7 days      | gambling, subscription, gift cards, crypto, alcohol, tobacco, unknown | 9pm–7am     | 2 per hour    |
| 🛡️ **Safe**           | $50          | $150    | $400 per 7 days     | gambling, gift cards, crypto, unknown                                 | 11pm–7am    | 3 per 15 min  |
| 🎯 **Strategic**      | $200         | $400    | $1,500 per 7 days   | gambling, gift cards                                                  | off         | 5 per 15 min  |
| 🎰 **All In**         | $500         | $500    | $20,000 per 30 days | none                                                                  | off         | 10 per 15 min |

Changing any setting switches the project to **Custom**. Presets never touch your blocked-merchants list.

How saving works:

- The editor checks every value with the gateway's own schema before saving, and highlights any field that
  needs fixing.
- It writes the file in one step (write-then-rename), so the gateway never reads a half-written profile.
- It refuses to overwrite the file if someone else changed it after you opened the editor.
- It rewrites the YAML file, so any comments you added by hand are lost. Your merchant category map is kept.

The editor's code is in `editor/` (React) and `src/editor/server.ts` (API). Presets live in
`src/profile/presets.ts`.

## Risk profile

See `examples/risk-profile.yaml`. Settings for each project under `projects.<name>`:

| Setting                     | What it does                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preset`                    | Which editor preset the project came from: `old-man-coffee`, `safe`, `strategic`, `all-in` or `custom`. For display only; the gateway ignores it.                                     |
| `per_transaction_cap_cents` | Maximum for a single purchase.                                                                                                                                                        |
| `daily_cap_cents`           | Maximum across a rolling 24 hours.                                                                                                                                                    |
| `recent_purchases_cap`      | `window_days` (0–90), `window_hours` (0–23) and `max_total_cents`. Spending in that rolling window, plus this purchase, can't exceed the cap. For example, 7 days and $400. Optional. |
| `blocked_categories`        | Always denied. Add `uncategorized` to deny merchants whose category is unknown.                                                                                                       |
| `blocked_merchants`         | Domains that are always denied, including their subdomains.                                                                                                                           |
| `quiet_hours`               | `start` and `end` as `HH:MM` (24-hour). Purchases in this window are denied, and windows can cross midnight. Needs the top-level `timezone`. Optional.                                |
| `velocity`                  | Burst rules: `window_minutes`, `max_requests`, `max_amount_cents_in_window`, `small_txn_threshold_cents` and `max_small_txns_in_window`.                                              |

Claude names a project with the `project` tool argument; requests without one use `default_project`.
Top-level settings:

- `merchant_categories`: maps a domain to a category. It overrides the category Claude declares, so Claude
  can't relabel a gambling site. Subdomains match. Merchants that aren't mapped and have no declared category
  are `uncategorized`, which you can block.
- `flag_threshold_pct` (default 80): a request that passes every check but reaches this percentage of any
  limit is **flagged**. It is still forwarded, with `gateway_risk_flag=true` in the Stripe metadata, and
  Claude is told to mention it to you.
- `timezone`: an IANA time zone such as `America/Chicago`. Required if any project uses quiet hours.

How the profile is loaded:

- It's validated strictly. Unknown keys are rejected, and so are caps looser than Stripe's own limits.
- It's re-read on every request, so edits apply immediately.
- If it becomes invalid, **all spending is denied** until you fix it.

## Decision rules

| Check               | Deny when                                                                 | Counts                             |
| ------------------- | ------------------------------------------------------------------------- | ---------------------------------- |
| Per-transaction cap | amount > cap                                                              | —                                  |
| Category            | resolved category is blocked                                              | —                                  |
| Merchant            | merchant domain (or a parent domain) is blocked                           | —                                  |
| Quiet hours         | current time in `timezone` is within `[start, end)`                       | —                                  |
| Daily cap           | committed 24h spend + amount > cap                                        | committed spend only               |
| Longer-period cap   | committed spend in the last `window_days` + `window_hours` + amount > cap | committed spend only               |
| Request count       | attempts in window (incl. this one) > `max_requests`                      | **all** attempts, denials included |
| Window amount       | committed window spend + amount > cap                                     | committed spend only               |
| Small-charge burst  | this is small and small attempts in window > max                          | **all** small attempts             |

"Committed" means the gateway allowed or flagged the request and its Link status is not `denied`, `expired`,
`canceled`, `failed`, or `forward_failed`.

Denials count toward the attempt-count rules, so a denied burst can't reset itself. They don't count toward
the amount caps, so one oversized denied attempt can't use up your budget.

The evaluate-and-record step runs under a SQLite `BEGIN IMMEDIATE` lock, so two concurrent requests can't
both slip under a limit. `risk_score` (0–100) is the highest utilization across all checks.

## MCP tools

| Tool                             | Notes                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spend_request_create`           | link-cli create arguments plus `project` and `category`. Card credentials only. Always runs with `--test --no-request-approval`.                                     |
| `spend_request_request_approval` | Returns the `approval_url` to show the user.                                                                                                                         |
| `spend_request_retrieve`         | `wait_seconds` (≤600) polls for your decision. `include_card` writes the card to a 0600 file in the credentials directory; the full number is never returned inline. |
| `spend_request_cancel`           |                                                                                                                                                                      |
| `payment_methods_list`           | Read-only passthrough.                                                                                                                                               |

Every follow-up tool refuses spend request IDs that weren't created through the gateway. link-cli's `update`
command (which could change the merchant after the policy check) isn't exposed, and neither is its
`--approve` flag (delegated self-approval).

Each forwarded request carries `gateway_attempt_id`, `gateway_project`, `gateway_decision`,
`gateway_risk_score`, `gateway_policy_version` and `gateway_category` as Stripe metadata.

## Audit trail

```bash
node dist/bin/ledger.js [--project personal] [--limit 25] [--json]
```

## Development

```bash
npm test            # vitest: policy rules, presets, ledger locking, gateway flow, CLI args, MCP, editor API and UI logic
npm run typecheck   # gateway and editor
npm run build       # gateway into dist/, editor UI into dist/editor-ui/
```

`src/` layout:

- `profile/`: schema, loader, category resolution
- `policy/`: pure check functions
- `ledger/`: SQLite
- `link/`: `LinkClient` interface, the link-cli client, and a fake for tests
- `gateway/`: orchestration
- `mcp/`: tool definitions
- `bin/`: entry points

## Roadmap

- **Next:** an end-to-end demo with Claude in Stripe test mode. A request that breaks a rule is denied
  instantly; a valid one is forwarded, approved in the Link app, and its credential issued.
- **Stretch:** EWMA-based adaptive velocity thresholds, and richer ledger reporting.
- **Out of scope for v1:** multi-user or hosted OAuth, a web profile editor, real-money transactions, and
  shared payment token / Link Pay Token flows.
