import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type BotStrategyRow, type BotStrategyStatus, type DbotImportResult } from "../lib/api";
import { STARTER_DEFINITION, STRATEGY_KEY_PATTERN } from "../lib/botTemplate";

interface FormState {
  id: string | null; // null = creating
  key: string;
  name: string;
  description: string;
  definitionText: string;
}

const emptyForm = (): FormState => ({
  id: null,
  key: "",
  name: "",
  description: "",
  definitionText: JSON.stringify(STARTER_DEFINITION, null, 2),
});

const fromRow = (r: BotStrategyRow): FormState => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  definitionText: JSON.stringify(r.definition, null, 2),
});

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

const MAX_XML_BYTES = 200 * 1024;

interface ImportState {
  fileName: string;
  xml: string;
  key: string;
  name: string;
  description: string;
  ignoreSell: boolean;
  result: DbotImportResult | null;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.xml$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

function StatusPill({ status }: { status: BotStrategyStatus }) {
  return <span className={`pill pill--${status.toLowerCase()}`}>{status}</span>;
}

export function BotsPage() {
  const [strategies, setStrategies] = useState<BotStrategyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState | null>(null);
  const [imp, setImp] = useState<ImportState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listBotStrategies()
      .then(setStrategies)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function changeStatus(s: BotStrategyRow, next: BotStrategyStatus) {
    if (next === "PUBLISHED") {
      const ok = window.confirm(
        `Publish "${s.name}"?\n\nEvery user will be able to choose it. Each user sets their own stake and risk limits and turns it on against their own Deriv account; you never see or control their bot.`,
      );
      if (!ok) return;
    }
    if (next === "ARCHIVED") {
      const ok = window.confirm(`Archive "${s.name}"?\n\nNew bots can't use it. Bots already running on it keep running.`);
      if (!ok) return;
    }
    run(() => api.setBotStrategyStatus(s.id, next));
  }

  function remove(s: BotStrategyRow) {
    if (!window.confirm(`Delete "${s.name}"? This can't be undone. A strategy any user has used can only be archived.`)) return;
    run(() => api.deleteBotStrategy(s.id));
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_XML_BYTES) {
      setError("That file is larger than 200 KB — a Deriv Bot export is normally far smaller. Is it the right file?");
      return;
    }
    const xml = await file.text();
    const base = file.name.replace(/\.xml$/i, "");
    setImp({ fileName: file.name, xml, key: slugify(file.name), name: base, description: "", ignoreSell: false, result: null });
  }

  async function checkImport(next: ImportState = imp!) {
    setError(null);
    setSaving(true);
    try {
      const result = await api.importDbot(next.xml, next.ignoreSell ? ["sell_at_market"] : []);
      setImp({ ...next, result });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveImport() {
    if (!imp || !imp.result?.ok) return;
    setError(null);
    if (!STRATEGY_KEY_PATTERN.test(imp.key)) {
      setError('Key must be lowercase words joined by hyphens, e.g. "digits-over-recovery".');
      return;
    }
    setSaving(true);
    try {
      await api.createBotStrategy({ key: imp.key, name: imp.name, description: imp.description, definition: imp.result.definition });
      setImp(null);
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    if (!form) return;
    setError(null);

    if (!form.id && !STRATEGY_KEY_PATTERN.test(form.key)) {
      setError('Key must be lowercase words joined by hyphens, e.g. "ema-rsi-macd-martingale".');
      return;
    }
    let definition: unknown;
    try {
      definition = JSON.parse(form.definitionText);
    } catch {
      setError("Definition isn't valid JSON — check for a missing comma or bracket. (To bring in a Deriv Bot XML file, use “Import Deriv Bot”, not this box.)");
      return;
    }

    setSaving(true);
    try {
      if (form.id) {
        await api.updateBotStrategy(form.id, { name: form.name, description: form.description, definition });
      } else {
        await api.createBotStrategy({ key: form.key, name: form.name, description: form.description, definition });
      }
      setForm(null);
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ marginTop: 0, fontSize: 17 }}>Bot strategies</h1>
        {!form && !imp && (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="button button--inline button--ghost" onClick={() => setImp({ fileName: "", xml: "", key: "", name: "", description: "", ignoreSell: false, result: null })}>
              Import Deriv Bot (XML)
            </button>
            <button className="button button--inline" onClick={() => setForm(emptyForm())}>
              New strategy
            </button>
          </div>
        )}
      </div>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: -4, marginBottom: 16 }}>
        The catalog users pick from. A strategy is a template only: each user chooses their own stake and stop-loss and starts it on their own
        account. This console can't see, start, stop, or trade any user's bot.
      </p>

      {error && (
        <div role="alert" className="error-text">
          {error}
        </div>
      )}

      {imp ? (
        <div>
          <h2 style={{ fontSize: 14, marginTop: 0 }}>Import a Deriv Bot</h2>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: -4 }}>
            Upload the XML you exported from Deriv Bot. It is checked block by block: anything this platform can't run safely is refused by name, never skipped silently.
            Nothing is saved until you review the result and press Save.
          </p>
          <div className="field">
            <label htmlFor="dbot-file">Deriv Bot file (.xml)</label>
            <input id="dbot-file" type="file" accept=".xml,text/xml,application/xml" onChange={(e) => void pickFile(e.target.files?.[0])} />
          </div>

          {imp.xml && (
            <>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, margin: "4px 0 12px" }}>
                <input
                  type="checkbox"
                  checked={imp.ignoreSell}
                  onChange={(e) => {
                    const next = { ...imp, ignoreSell: e.target.checked, result: null };
                    setImp(next);
                  }}
                  style={{ marginTop: 3 }}
                />
                <span>
                  Ignore “Sell at market” blocks. This platform never sells a contract early — every trade runs to its natural end — so those blocks would do nothing. Tick this only if that's fine for this bot.
                </span>
              </label>
              <button className="button button--inline" disabled={saving} onClick={() => void checkImport()}>
                {saving ? "Checking…" : "Check file"}
              </button>
            </>
          )}

          {imp.result && !imp.result.ok && (
            <div role="alert" className="error-text" style={{ marginTop: 14 }}>
              <strong>This bot can't be imported yet:</strong>
              <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                {imp.result.issues.map((i, n) => (
                  <li key={n}>
                    {i.message}
                    {i.block ? <span className="mono" style={{ color: "var(--text-muted)" }}> [{i.block}]</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {imp.result?.ok && (
            <div style={{ marginTop: 14 }}>
              <div className="notice" style={{ marginBottom: 12 }}>
                <strong>Ready to import.</strong> Market {imp.result.summary.suggestedSymbol} · contracts {imp.result.summary.contractTypes.join(", ")} · {imp.result.summary.blockCount} blocks.
                {imp.result.summary.startingValues.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    Starts with: {imp.result.summary.startingValues.map((v) => `${v.name} = ${String(v.value)}`).join(", ")}
                  </div>
                )}
                {imp.result.summary.prompts.length > 0 && <div style={{ marginTop: 6 }}>Each user will be asked for: {imp.result.summary.prompts.join(", ")}</div>}
              </div>
              {imp.result.warnings.length > 0 && (
                <div className="notice notice--warn" style={{ marginBottom: 12 }}>
                  <strong>Please read:</strong>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                    {imp.result.warnings.map((w, n) => (
                      <li key={n}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="field">
                <label htmlFor="imp-key">Key</label>
                <input id="imp-key" className="mono" value={imp.key} onChange={(e) => setImp({ ...imp, key: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="imp-name">Name</label>
                <input id="imp-name" value={imp.name} onChange={(e) => setImp({ ...imp, name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="imp-desc">Description shown to users</label>
                <textarea id="imp-desc" rows={3} value={imp.description} onChange={(e) => setImp({ ...imp, description: e.target.value })} />
              </div>
              <button className="button button--inline" disabled={saving || !imp.name || !imp.description || !imp.key} onClick={() => void saveImport()}>
                {saving ? "Saving…" : "Save as draft"}
              </button>
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <button className="button button--inline button--ghost" disabled={saving} onClick={() => { setImp(null); setError(null); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {imp ? null : form ? (
        <div>
          <h2 style={{ fontSize: 14, marginTop: 0 }}>{form.id ? "Edit strategy" : "New strategy"}</h2>
          <div className="field">
            <label htmlFor="bot-key">Key</label>
            <input
              id="bot-key"
              value={form.key}
              disabled={form.id !== null}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              placeholder="ema-rsi-macd-martingale"
              className="mono"
            />
            {form.id && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>The key can't change after creation.</span>}
          </div>
          <div className="field">
            <label htmlFor="bot-name">Name</label>
            <input id="bot-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bot-desc">Description shown to users</label>
            <textarea id="bot-desc" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bot-def">Definition (JSON)</label>
            <textarea
              id="bot-def"
              className="mono"
              spellCheck={false}
              value={form.definitionText}
              onChange={(e) => setForm({ ...form, definitionText: e.target.value })}
            />
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Indicators (SMA, EMA, RSI, MACD), entry rules, staking, risk limits, trade duration. The server checks every field when you save.
              New strategies start as Draft.
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="button button--inline" disabled={saving || !form.name || !form.description} onClick={save}>
              {saving ? "Saving…" : form.id ? "Save changes" : "Create draft"}
            </button>
            <button
              className="button button--inline button--ghost"
              disabled={saving}
              onClick={() => {
                setForm(null);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : loading ? (
        <p style={{ color: "var(--text-muted)" }}>Loading…</p>
      ) : strategies.length === 0 ? (
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No strategies yet. Create one to make it available to users once published.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
              <th style={{ padding: "6px 0" }}>Strategy</th>
              <th>Status</th>
              <th>Updated</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {strategies.map((s) => (
              <tr key={s.id} style={{ borderTop: "1px solid var(--border)", verticalAlign: "top" }}>
                <td style={{ padding: "8px 12px 8px 0" }}>
                  <div style={{ fontWeight: 600 }}>{s.name}</div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {s.key}
                  </div>
                </td>
                <td style={{ padding: "8px 0" }}>
                  <StatusPill status={s.status} />
                </td>
                <td className="mono" style={{ padding: "8px 0" }}>
                  {new Date(s.updatedAt).toLocaleDateString()}
                </td>
                <td style={{ padding: "8px 0", textAlign: "right" }}>
                  <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <button className="button button--inline button--ghost" onClick={() => setForm(fromRow(s))}>
                      Edit
                    </button>
                    {s.status !== "PUBLISHED" && (
                      <button className="button button--inline" onClick={() => changeStatus(s, "PUBLISHED")}>
                        Publish
                      </button>
                    )}
                    {s.status === "PUBLISHED" && (
                      <button className="button button--inline button--ghost" onClick={() => changeStatus(s, "ARCHIVED")}>
                        Archive
                      </button>
                    )}
                    {s.status === "ARCHIVED" && (
                      <button className="button button--inline button--ghost" onClick={() => changeStatus(s, "DRAFT")}>
                        Move to draft
                      </button>
                    )}
                    {s.status === "DRAFT" && (
                      <button className="button button--inline button--danger" onClick={() => remove(s)}>
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
