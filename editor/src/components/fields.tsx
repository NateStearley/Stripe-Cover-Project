import { useEffect, useId, useState, type ReactNode } from "react";
import { centsToDollarsInput, dollarsInputToCents } from "../lib/format";

export function Field(props: { label: string; hint?: ReactNode; error?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={`field${props.error ? " field--error" : ""}`}>
      <label htmlFor={id}>{props.label}</label>
      {props.children(id)}
      {props.error ? <p className="field__error">{props.error}</p> : props.hint ? <p className="field__hint">{props.hint}</p> : null}
    </div>
  );
}

/** Text box that commits whole cents; keeps the user's partial typing until it parses. */
export function DollarInput(props: { id?: string; cents: number; onChange: (cents: number) => void }) {
  const [text, setText] = useState(centsToDollarsInput(props.cents));
  // Resync only when the value changes from outside, e.g. a preset was applied.
  useEffect(() => {
    if (dollarsInputToCents(text) !== props.cents) setText(centsToDollarsInput(props.cents));
  }, [props.cents]);
  return (
    <div className="money">
      <span className="money__symbol">$</span>
      <input
        id={props.id}
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const cents = dollarsInputToCents(e.target.value);
          if (cents !== null) props.onChange(cents);
        }}
        onBlur={() => setText(centsToDollarsInput(props.cents))}
      />
    </div>
  );
}

export function IntInput(props: { id?: string; value: number; onChange: (n: number) => void; min?: number; max?: number; suffix?: string }) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => {
    if (Number(text) !== props.value) setText(String(props.value));
  }, [props.value]);
  return (
    <div className="int">
      <input
        id={props.id}
        type="number"
        inputMode="numeric"
        min={props.min ?? 1}
        max={props.max}
        step={1}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isInteger(n) && n >= (props.min ?? 1)) props.onChange(n);
        }}
        onBlur={() => setText(String(props.value))}
      />
      {props.suffix ? <span className="int__suffix">{props.suffix}</span> : null}
    </div>
  );
}

export function Toggle(props: { checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string }) {
  const id = useId();
  return (
    <div className="toggle">
      <input id={id} type="checkbox" role="switch" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <label htmlFor={id}>
        <span className="toggle__label">{props.label}</span>
        {props.description ? <span className="toggle__description">{props.description}</span> : null}
      </label>
    </div>
  );
}

/** Chip list with free-text entry (Enter or comma) and optional one-click suggestions. */
export function TagInput(props: {
  id?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  suggestions?: readonly string[];
  normalize: (raw: string) => string;
}) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const value = props.normalize(raw);
    if (value && !props.values.includes(value)) props.onChange([...props.values, value]);
    setDraft("");
  };
  const unused = (props.suggestions ?? []).filter((s) => !props.values.includes(s));
  return (
    <div className="tags">
      <div className="tags__box">
        {props.values.map((v) => (
          <span className="chip" key={v}>
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => props.onChange(props.values.filter((x) => x !== v))}>
              ×
            </button>
          </span>
        ))}
        <input
          id={props.id}
          value={draft}
          placeholder={props.values.length === 0 ? props.placeholder : "Add another…"}
          onChange={(e) => {
            if (e.target.value.endsWith(",")) add(e.target.value.slice(0, -1));
            else setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (draft.trim()) add(draft);
            } else if (e.key === "Backspace" && draft === "" && props.values.length > 0) {
              props.onChange(props.values.slice(0, -1));
            }
          }}
          onBlur={() => draft.trim() && add(draft)}
        />
      </div>
      {unused.length > 0 ? (
        <div className="tags__suggestions">
          {unused.map((s) => (
            <button type="button" className="suggestion" key={s} onClick={() => add(s)}>
              + {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
