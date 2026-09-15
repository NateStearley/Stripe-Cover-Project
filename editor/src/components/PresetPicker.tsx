import { PRESETS } from "../../../src/profile/presets.js";
import type { PresetId } from "../../../src/profile/schema.js";
import { formatDollars } from "../lib/format";

const ICONS: Record<PresetId, string> = {
  "old-man-coffee": "☕",
  safe: "🛡️",
  strategic: "🎯",
  "all-in": "🎰",
  custom: "🎛️",
};

export function PresetPicker(props: { selected: PresetId; onSelect: (id: PresetId) => void }) {
  return (
    <div className="presets" role="radiogroup" aria-label="Risk preset">
      {PRESETS.map((p) => (
        <button
          type="button"
          role="radio"
          aria-checked={props.selected === p.id}
          key={p.id}
          className={`preset${props.selected === p.id ? " preset--selected" : ""}`}
          onClick={() => props.onSelect(p.id)}
        >
          <span className="preset__icon" aria-hidden>
            {ICONS[p.id]}
          </span>
          <span className="preset__name">{p.name}</span>
          <span className="preset__stats">
            {formatDollars(p.settings.per_transaction_cap_cents)} / purchase · {formatDollars(p.settings.daily_cap_cents)} / day
          </span>
          <span className="preset__tagline">{p.tagline}</span>
        </button>
      ))}
      <button
        type="button"
        role="radio"
        aria-checked={props.selected === "custom"}
        className={`preset${props.selected === "custom" ? " preset--selected" : ""}`}
        onClick={() => props.onSelect("custom")}
      >
        <span className="preset__icon" aria-hidden>
          {ICONS.custom}
        </span>
        <span className="preset__name">Custom</span>
        <span className="preset__stats">Your own settings</span>
        <span className="preset__tagline">Start from the current values and change anything below. Editing any setting switches to Custom.</span>
      </button>
    </div>
  );
}
