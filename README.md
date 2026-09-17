# Custom Risk Profiles for Agent Transactions

Custom risk tolerance settings for [Stripe Link's agent wallet](https://github.com/stripe/link-cli). Every
spend request Claude makes is checked against a risk profile you write, per project, **before** it reaches
Stripe. Stripe's own approval step is never bypassed. Anything to [make sure Claude doens't order 4,000 pounds of meat](https://youtu.be/m0b_D2JgZgY?t=74).

Stripe's only built-in guardrails are global and fixed ($500/transaction, $500/day, $20k/30 days). Your own
settings add:

- per-project caps
- category blocks
- rolling window lookback and custom cap
- a local audit ledger

## Setup

This project supports Claude Code only. It needs Node 20 or newer.

Clone the repo and move into it. Every command below is run from the project root.

```bash
git clone https://github.com/NateStearley/Stripe-Cover-Project.git
cd Stripe-Cover-Project
```

Install dependencies. The environment variable stops the script from installing Stripe's Link skills, 
which would give Claude a way to run link-cli directly, cirsumventing the custom risk profiles. See "Keep
Claude off the direct Link path" below.

```bash
LINK_CLI_SKIP_SKILL_INSTALL=1 npm install
```

This also builds the project, so there's no separate build step.

Give yourself a starting risk profile and put the `spend_request_*` tools in front of Claude. This copies the
example profile to `~/.link-risk-gateway/risk-profile.yaml` and registers the risk checks with Claude Code as
an MCP server, which should be the only route Claude has to Link. Re-running it is safe: it never overwrites a
profile you've edited.

```bash
npm run setup
```

Connect your Link account.

```bash
npx link-cli auth login
```

Then work through the next section before your first Claude session. Your risk settings only protect you if
they are the **only** way Claude can reach Link.

## Keep Claude off the direct Link path

link-cli keeps its login credentials on disk. Anything on your machine that can run link-cli can create spend
requests without checking the user's custom risk settings. Stripe ships several ready-made ways to 
give Claude that direct access. To use this project, close every one:

### Stripe's Link skills

`npm install` of `@stripe/link-cli` runs a `postinstall` script that installs three skills 
globally: `link-cli`, `create-payment-credential` and `financial-insights`. 
They land in `~/.claude/skills` and `~/.agents/skills`, and they tell Claude to run
link-cli itself. We have to blocks Claude's useage 

Close it in two parts:

1. **Remove the skills.** Install with `LINK_CLI_SKIP_SKILL_INSTALL=1` (the `postinstall` script honors it, and
   also skips under `CI`). If they're already installed, turn them off with `skillOverrides` (in
   `examples/claude-settings.json`), or delete them:

   ```bash
   rm -r ~/.claude/skills/{link-cli,create-payment-credential,financial-insights}
   rm -r ~/.agents/skills/{link-cli,create-payment-credential,financial-insights}
   ```

2. **Block the command.** The skills are only instructions; the deny rules are what stop the command from
   running. Merge the `permissions.deny` rules from `examples/claude-settings.json` into
   `~/.claude/settings.json`. They cover `link-cli`, `npx link-cli`, `npx [-y|--yes] @stripe/link-cli`,
   `npm exec`, and calls by file path.

To check: `ls ~/.claude/skills ~/.agents/skills` lists none of the three, and asking Claude to run
`npx link-cli --version` is refused.

<!-- ### Other direct paths

Each of these needs a deliberate action, so the fix is simply not to take it: don't install Stripe's Claude
Code plugin (the link-cli repo ships a `.claude-plugin`), don't register link-cli's own MCP server
(`link-cli --mcp`), don't run its HTTP server (`link-cli serve` on 127.0.0.1:54321, which exposes your wallet
to any local process), and don't put `LINK_ACCESS_TOKEN` or `LINK_REFRESH_TOKEN` in your shell profile or in
the `env` block of Claude Code settings — log in with `link-cli auth login` instead.

Two things about these protections:

- **The deny rules match command text, so they're a guardrail, not a sandbox.** They stop Claude from running
  link-cli directly, but not from, say, writing a script that calls it internally. Watch for Claude trying to
  pay by any route other than the `link-risk-gateway` tools, and treat that as a bug to report.
- **The deny rules also block your own `!` commands inside Claude Code.** Run `link-cli auth login` and any
  manual link-cli commands in a normal terminal.

The risk checks themselves are unaffected by the deny rules: they run link-cli as their own subprocess, not
through Claude's shell. -->

## Configuration

In order of precedence:

1. Flags: `--profile`, `--ledger`, `--credentials-dir`
2. Environment variables: `LINK_RISK_PROFILE`, `LINK_RISK_LEDGER`, `LINK_RISK_CREDENTIALS_DIR`
3. Defaults, under `~/.link-risk-gateway/`

## Editing the risk profile

```bash
npm run editor                # run in your own terminal, not through Claude
```

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

The editor's code is in `editor/` (React) and `src/editor/server.ts` (API). Presets live in
`src/profile/presets.ts`.

## Risk profile

See `examples/risk-profile.yaml`. Settings for each project under `projects.<name>`:

| Setting                     | What it does                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preset`                    | Which editor preset the project came from: `old-man-coffee`, `safe`, `strategic`, `all-in` or `custom`. For display only; the checks ignore it.                                      |
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

"Committed" means the request was allowed or flagged and its Link status is not `denied`, `expired`,
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

Every follow-up tool refuses spend request IDs that weren't created through these tools. link-cli's `update`
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
npm test            # vitest: policy rules, presets, ledger locking, request flow, CLI args, MCP, editor API and UI logic
npm run typecheck   # server and editor
npm run build       # server into dist/, editor UI into dist/editor-ui/
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
