import { useCallback, useEffect, useMemo, useState } from "react";
import { applyPreset, presetById } from "../../src/profile/presets.js";
import { profileSchema, type ProjectPolicy, type RiskProfile } from "../../src/profile/schema.js";
import { holdSession, loadProfile, readToken, saveProfile, type Issue } from "./api";
import { Field, IntInput } from "./components/fields";
import { ProjectEditor } from "./components/ProjectEditor";

type State =
  | { phase: "loading" }
  | { phase: "fatal"; message: string }
  | { phase: "broken"; path: string; message: string }
  | {
      phase: "ready";
      path: string;
      exists: boolean;
      saved: RiskProfile;
      draft: RiskProfile;
      policyVersion: string | null;
    };

type Notice = { tone: "success" | "error" | "warning"; message: string } | null;

const TIME_ZONES = Intl.supportedValuesOf("timeZone");

export function App() {
  const token = useMemo(readToken, []);
  const [state, setState] = useState<State>({ phase: "loading" });
  const [selected, setSelected] = useState<string>("");
  const [notice, setNotice] = useState<Notice>(null);
  const [serverIssues, setServerIssues] = useState<Issue[]>([]);
  const [saving, setSaving] = useState(false);
  const [editorStopped, setEditorStopped] = useState(false);

  const load = useCallback(async () => {
    if (!token) {
      setState({ phase: "fatal", message: "This page needs the link printed by `npm run editor`. Open that link instead." });
      return;
    }
    try {
      const result = await loadProfile(token);
      if (!result.profile) {
        setState({ phase: "broken", path: result.path, message: result.error ?? "The profile file is invalid." });
        return;
      }
      setState({
        phase: "ready",
        path: result.path,
        exists: result.exists,
        saved: result.profile,
        draft: result.profile,
        policyVersion: result.policyVersion,
      });
      setSelected((current) => (current in result.profile!.projects ? current : result.profile!.default_project));
      setServerIssues([]);
    } catch (err) {
      setState({ phase: "fatal", message: (err as Error).message });
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keeping this request open tells `npm run editor` the tab is still in use; closing the tab ends the command.
  useEffect(() => (token ? holdSession(token, () => setEditorStopped(true)) : undefined), [token]);

  const ready = state.phase === "ready" ? state : null;
  const dirty = ready ? !ready.exists || JSON.stringify(ready.draft) !== JSON.stringify(ready.saved) : false;

  const validation = useMemo(() => (ready ? profileSchema.safeParse(ready.draft) : null), [ready]);
  const issues: Issue[] = useMemo(() => {
    if (validation && !validation.success) {
      return validation.error.issues.map((i) => ({ path: i.path.map(String), message: i.message }));
    }
    return serverIssues;
  }, [validation, serverIssues]);
  const errorFor = useCallback(
    (field: string) => issues.find((i) => i.path.join(".") === field)?.message,
    [issues],
  );

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (state.phase === "loading") return <div className="centered">Loading risk profile…</div>;
  if (state.phase === "fatal") return <div className="centered error-text">{state.message}</div>;
  if (state.phase === "broken") {
    return (
      <div className="centered broken">
        <h1>The risk profile file can't be read</h1>
        <p className="mono">{state.path}</p>
        <pre>{state.message}</pre>
        <p>Until it's fixed, the gateway denies every purchase. Fix the file by hand and reload, or replace it with a fresh profile.</p>
        <div className="row">
          <button type="button" onClick={() => void load()}>Reload</button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              const fresh = freshProfile();
              setState({ phase: "ready", path: state.path, exists: false, saved: fresh, draft: fresh, policyVersion: "invalid" });
              setSelected(fresh.default_project);
            }}
          >
            Start a fresh profile
          </button>
        </div>
      </div>
    );
  }

  const { draft } = state;
  const projectNames = Object.keys(draft.projects);
  const current = draft.projects[selected] ? selected : draft.default_project;
  const setDraft = (next: RiskProfile) => {
    setState({ ...state, draft: next });
    setServerIssues([]);
    setNotice(null);
  };
  const setProject = (name: string, project: ProjectPolicy) =>
    setDraft({
      ...draft,
      // Quiet hours need a time zone; default to this browser's rather than showing an error elsewhere on the page.
      timezone: draft.timezone ?? (project.quiet_hours ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined),
      projects: { ...draft.projects, [name]: project },
    });
  const projectHasErrors = (name: string) => issues.some((i) => i.path[0] === "projects" && i.path[1] === name);

  const addProject = () => {
    const name = window.prompt("Name for the new project (e.g. gravel-research):")?.trim();
    if (!name) return;
    if (draft.projects[name]) {
      setNotice({ tone: "error", message: `A project named "${name}" already exists.` });
      return;
    }
    setDraft({ ...draft, projects: { ...draft.projects, [name]: applyPreset(presetById("safe")!) } });
    setSelected(name);
  };

  const removeProject = (name: string) => {
    if (name === draft.default_project) return;
    if (!window.confirm(`Delete the "${name}" project? Claude requests tagged with it will be denied as an unknown project.`)) return;
    const { [name]: _, ...rest } = draft.projects;
    setDraft({ ...draft, projects: rest });
    setSelected(draft.default_project);
  };

  const save = async () => {
    if (!token || !validation?.success) return;
    setSaving(true);
    const result = await saveProfile(token, draft, state.policyVersion);
    setSaving(false);
    if (result.ok) {
      setState({ ...state, exists: true, saved: result.profile, draft: result.profile, policyVersion: result.policyVersion });
      setNotice({ tone: "success", message: "Saved. The gateway uses these settings from the next purchase." });
    } else if (result.kind === "conflict") {
      setNotice({ tone: "warning", message: `${result.message} Your unsaved edits will be lost when you reload.` });
    } else {
      setServerIssues(result.issues ?? []);
      setNotice({ tone: "error", message: result.message });
    }
  };

  const discard = () => {
    setDraft(state.saved);
    setNotice(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Risk Profile</h1>
          <p className="topbar__path mono" title={state.path}>
            {state.path}
            {state.policyVersion && state.policyVersion !== "invalid" ? ` · policy ${state.policyVersion}` : " · not saved yet"}
          </p>
        </div>
        <div className="topbar__actions">
          {issues.length > 0 ? <span className="badge badge--error">{issues.length} to fix</span> : null}
          {dirty ? <span className="badge">Unsaved changes</span> : null}
          <button type="button" className="secondary" onClick={discard} disabled={!dirty || !state.exists}>
            Discard
          </button>
          <button type="button" onClick={() => void save()} disabled={!dirty || saving || editorStopped || !validation?.success}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      {editorStopped ? (
        <div className="notice notice--error" role="alert">
          <span>The editor has stopped, so changes can't be saved. Run <code>npm run editor</code> to open it again.</span>
        </div>
      ) : null}

      {notice ? (
        <div className={`notice notice--${notice.tone}`} role="status">
          <span>{notice.message}</span>
          {notice.tone === "warning" ? (
            <button type="button" className="secondary" onClick={() => void load()}>
              Reload
            </button>
          ) : null}
        </div>
      ) : null}

      <main>
        <section className="card">
          <h2>General settings</h2>
          <div className="grid grid--3">
            <Field label="Default project" hint="Used when Claude doesn't name a project." error={errorFor("default_project")}>
              {(id) => (
                <select id={id} value={draft.default_project} onChange={(e) => setDraft({ ...draft, default_project: e.target.value })}>
                  {projectNames.map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              )}
            </Field>
            <Field
              label="Flag purchases near a limit"
              hint="Allowed purchases at or above this share of any limit are marked for your attention in Stripe."
              error={errorFor("flag_threshold_pct")}
            >
              {(id) => (
                <IntInput id={id} value={draft.flag_threshold_pct} max={100} suffix="%" onChange={(n) => setDraft({ ...draft, flag_threshold_pct: Math.min(n, 100) })} />
              )}
            </Field>
            <Field label="Time zone" hint="Used for quiet hours." error={errorFor("timezone")}>
              {(id) => (
                <select id={id} value={draft.timezone ?? ""} onChange={(e) => setDraft({ ...draft, timezone: e.target.value || undefined })}>
                  <option value="">Not set</option>
                  {TIME_ZONES.map((tz) => (
                    <option key={tz}>{tz}</option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        </section>

        <nav className="tabs" aria-label="Projects">
          {projectNames.map((name) => (
            <div key={name} className={`tab${name === current ? " tab--active" : ""}`}>
              <button type="button" className="tab__select" onClick={() => setSelected(name)} aria-current={name === current}>
                {name}
                {name === draft.default_project ? <span className="tab__default">default</span> : null}
                {projectHasErrors(name) ? <span className="tab__error" aria-label="has errors">●</span> : null}
              </button>
              {name !== draft.default_project ? (
                <button type="button" className="tab__remove" aria-label={`Delete ${name}`} onClick={() => removeProject(name)}>
                  ×
                </button>
              ) : null}
            </div>
          ))}
          <button type="button" className="tab tab--add" onClick={addProject}>
            + Add project
          </button>
        </nav>

        <ProjectEditor key={current} name={current} project={draft.projects[current]!} onChange={(p) => setProject(current, p)} errorFor={errorFor} />

        <p className="footnote">
          Close this tab when you're done; the editor command in your terminal exits on its own. Saving rewrites the YAML file, so
          any comments you added by hand are removed. Your merchant category map is kept as is.
        </p>
      </main>
    </div>
  );
}

function freshProfile(): RiskProfile {
  return {
    version: 1,
    default_project: "personal",
    flag_threshold_pct: 80,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    merchant_categories: {},
    projects: { personal: applyPreset(presetById("safe")!) },
  };
}
