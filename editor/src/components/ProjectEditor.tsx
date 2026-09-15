import { UNCATEGORIZED } from "../../../src/profile/categories.js";
import { COMMON_CATEGORIES } from "../../../src/profile/presets.js";
import { MAX_RECENT_WINDOW_DAYS, normalizeDomain, STRIPE_LIMITS, type ProjectPolicy } from "../../../src/profile/schema.js";
import { describeProject } from "../lib/format";
import { editProject, selectPreset, setBlockedMerchants } from "../lib/project";
import { DollarInput, Field, IntInput, TagInput, Toggle } from "./fields";
import { PresetPicker } from "./PresetPicker";

type Errors = (field: string) => string | undefined;

export function ProjectEditor(props: {
  name: string;
  project: ProjectPolicy;
  onChange: (project: ProjectPolicy) => void;
  errorFor: Errors;
}) {
  const { project: p, errorFor } = props;
  const err = (field: string) => errorFor(`projects.${props.name}.${field}`);

  const edit = (patch: Partial<ProjectPolicy>) => props.onChange(editProject(p, patch));
  const editVelocity = (patch: Partial<ProjectPolicy["velocity"]>) => edit({ velocity: { ...p.velocity, ...patch } });
  const recent = p.recent_purchases_cap;
  const editRecent = (patch: Partial<NonNullable<ProjectPolicy["recent_purchases_cap"]>>) =>
    recent && edit({ recent_purchases_cap: { ...recent, ...patch } });

  const namedCategories = p.blocked_categories.filter((c) => c !== UNCATEGORIZED);
  const blocksUncategorized = p.blocked_categories.includes(UNCATEGORIZED);

  return (
    <div className="project">
      <section className="card">
        <h2>Start from a preset</h2>
        <PresetPicker selected={p.preset} onSelect={(id) => props.onChange(selectPreset(p, id))} />
      </section>

      <div className="project__columns">
        <div className="project__settings">
          <section className="card">
            <h2>Spending limits</h2>
            <div className="grid grid--2">
              <Field
                label="Max per purchase"
                hint={`Stripe's limit is $${STRIPE_LIMITS.perTransactionCents / 100}.`}
                error={err("per_transaction_cap_cents")}
              >
                {(id) => <DollarInput id={id} cents={p.per_transaction_cap_cents} onChange={(c) => edit({ per_transaction_cap_cents: c })} />}
              </Field>
              <Field label="Max per day" hint="Rolling 24 hours. Stripe's limit is $500." error={err("daily_cap_cents")}>
                {(id) => <DollarInput id={id} cents={p.daily_cap_cents} onChange={(c) => edit({ daily_cap_cents: c })} />}
              </Field>
            </div>

            <Toggle
              label="Cap spending over a longer period"
              description="Limits the total spent in any rolling window you choose."
              checked={recent !== undefined}
              onChange={(on) =>
                edit({
                  recent_purchases_cap: on
                    ? { window_days: 7, window_hours: 0, max_total_cents: Math.max(p.daily_cap_cents, p.per_transaction_cap_cents) }
                    : undefined,
                })
              }
            />
            {recent ? (
              <div className="grid grid--3 indent">
                <Field label="Look back" error={err("recent_purchases_cap.window_days")}>
                  {(id) => (
                    <IntInput
                      id={id}
                      value={recent.window_days}
                      min={0}
                      max={MAX_RECENT_WINDOW_DAYS}
                      suffix="days"
                      onChange={(n) => editRecent({ window_days: n })}
                    />
                  )}
                </Field>
                <Field label="and" error={err("recent_purchases_cap.window_hours")}>
                  {(id) => (
                    <IntInput id={id} value={recent.window_hours} min={0} max={23} suffix="hours" onChange={(n) => editRecent({ window_hours: n })} />
                  )}
                </Field>
                <Field
                  label="Max total in that time"
                  hint="Denied, canceled and expired purchases don't count."
                  error={err("recent_purchases_cap.max_total_cents")}
                >
                  {(id) => <DollarInput id={id} cents={recent.max_total_cents} onChange={(c) => editRecent({ max_total_cents: c })} />}
                </Field>
              </div>
            ) : null}
          </section>

          <section className="card">
            <h2>Blocked categories</h2>
            <p className="card__intro">Purchases in these categories are denied. Type any category, or pick a common one.</p>
            <Field label="Categories" error={err("blocked_categories")}>
              {(id) => (
                <TagInput
                  id={id}
                  values={namedCategories}
                  placeholder="e.g. gambling"
                  suggestions={COMMON_CATEGORIES.filter((c) => c !== UNCATEGORIZED)}
                  normalize={(raw) => raw.trim().toLowerCase()}
                  onChange={(values) => edit({ blocked_categories: blocksUncategorized ? [...values, UNCATEGORIZED] : values })}
                />
              )}
            </Field>
            <Toggle
              label="Block merchants with an unknown category"
              description="Recommended. Otherwise a merchant that isn't in your category map, and that Claude doesn't label, gets through."
              checked={blocksUncategorized}
              onChange={(on) => edit({ blocked_categories: on ? [...namedCategories, UNCATEGORIZED] : namedCategories })}
            />
          </section>

          <section className="card">
            <h2>Blocked merchants</h2>
            <p className="card__intro">Always deny these websites, including their subdomains. Presets never change this list.</p>
            <Field label="Merchant domains" error={err("blocked_merchants")}>
              {(id) => (
                <TagInput
                  id={id}
                  values={p.blocked_merchants}
                  placeholder="e.g. rei.com (They take all my money anyway)"
                  normalize={(raw) => normalizeDomain(raw.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? "")}
                  onChange={(values) => props.onChange(setBlockedMerchants(p, values))}
                />
              )}
            </Field>
          </section>

          <section className="card">
            <h2>Quiet hours</h2>
            <Toggle
              label="Deny purchases during quiet hours"
              description="Catches Claude spending during long unattended runs. Uses the time zone in General settings."
              checked={p.quiet_hours !== undefined}
              onChange={(on) => edit({ quiet_hours: on ? { start: "23:00", end: "07:00" } : undefined })}
            />
            {p.quiet_hours ? (
              <div className="grid grid--2 indent">
                <Field label="From" error={err("quiet_hours.start")}>
                  {(id) => (
                    <input id={id} type="time" value={p.quiet_hours!.start} onChange={(e) => e.target.value && edit({ quiet_hours: { ...p.quiet_hours!, start: e.target.value } })} />
                  )}
                </Field>
                <Field label="Until" hint="Windows that cross midnight are fine." error={err("quiet_hours.end")}>
                  {(id) => (
                    <input id={id} type="time" value={p.quiet_hours!.end} onChange={(e) => e.target.value && edit({ quiet_hours: { ...p.quiet_hours!, end: e.target.value } })} />
                  )}
                </Field>
              </div>
            ) : null}
          </section>

          <section className="card">
            <h2>Burst protection</h2>
            <p className="card__intro">Stops a flurry of purchases in a short time, including the many-tiny-charges pattern used to test stolen cards.</p>
            <div className="grid grid--3">
              <Field label="Time window" error={err("velocity.window_minutes")}>
                {(id) => <IntInput id={id} value={p.velocity.window_minutes} max={1440} suffix="min" onChange={(n) => editVelocity({ window_minutes: n })} />}
              </Field>
              <Field label="Max attempts in window" hint="Denied attempts count too." error={err("velocity.max_requests")}>
                {(id) => <IntInput id={id} value={p.velocity.max_requests} onChange={(n) => editVelocity({ max_requests: n })} />}
              </Field>
              <Field label="Max spend in window" error={err("velocity.max_amount_cents_in_window")}>
                {(id) => <DollarInput id={id} cents={p.velocity.max_amount_cents_in_window} onChange={(c) => editVelocity({ max_amount_cents_in_window: c })} />}
              </Field>
              <Field label="“Tiny charge” means under" error={err("velocity.small_txn_threshold_cents")}>
                {(id) => <DollarInput id={id} cents={p.velocity.small_txn_threshold_cents} onChange={(c) => editVelocity({ small_txn_threshold_cents: c })} />}
              </Field>
              <Field label="Max tiny charges in window" error={err("velocity.max_small_txns_in_window")}>
                {(id) => <IntInput id={id} value={p.velocity.max_small_txns_in_window} onChange={(n) => editVelocity({ max_small_txns_in_window: n })} />}
              </Field>
            </div>
          </section>
        </div>

        <aside className="card summary" aria-label="Summary">
          <h2>In plain English</h2>
          <ul>
            {describeProject(p).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
