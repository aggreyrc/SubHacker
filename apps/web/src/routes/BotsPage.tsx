import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useDerivStatus } from "../lib/derivStatus";
import type { ActiveSymbol } from "../lib/marketTypes";
import { isProgramParams, type BotCatalogEntry, type BotRiskParams, type BotStaking, type BotTradeView, type BotView, type IndicatorRiskParams } from "../lib/botTypes";

const POLL_MS = 5_000;

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");
const num = (s: string): number | undefined => (s.trim() === "" || !Number.isFinite(Number(s)) ? undefined : Number(s));

/** The largest single stake a staking setup can ever reach — shown before the user commits. */
function peakStake(s: BotStaking): number {
  return s.mode === "FIXED" ? s.stake : s.baseStake * Math.pow(s.multiplierOnLoss, s.maxSteps - 1);
}

const STATUS_LABEL: Record<BotView["status"], string> = {
  DRAFT: "Not started",
  RUNNING: "Running",
  PAUSED: "Paused",
  STOPPED: "Stopped",
  ERROR: "Needs attention",
};

const STOP_REASON_TEXT: Record<string, string> = {
  TARGET_PROFIT_REACHED: "Stopped: target profit reached.",
  STOP_LOSS_REACHED: "Stopped: stop-loss reached.",
  MAX_CONSECUTIVE_LOSSES: "Stopped: too many losses in a row.",
  MAX_TRADES_PER_SESSION: "Stopped: trade limit for the session reached.",
  STAKE_LADDER_EXHAUSTED: "Stopped: the stake ladder reached its last step.",
  USER_STOPPED: "Stopped by you.",
  REAL_ACCOUNT_NOT_CONFIRMED: "Stopped: real-money trading wasn't confirmed.",
  ACCOUNT_UNAVAILABLE: "Stopped: the Deriv account isn't available.",
  INVALID_CONFIGURATION: "Stopped: this bot's settings are no longer valid.",
  REAUTH_REQUIRED: "Stopped: reconnect your Deriv account, then start the bot again.",
  SETTLEMENT_NOT_CONFIRMED: "Stopped: a trade's result couldn't be confirmed. Check it on Deriv before restarting.",
  TRADE_RECORD_FAILED: "Stopped: a trade was placed but couldn't be recorded. Check it on Deriv before restarting.",
  TOO_MANY_ERRORS: "Stopped after repeated errors.",
  STAKE_CAP_EXCEEDED: "Stopped: the bot tried to stake more than your per-trade limit.",
  PROGRAM_FINISHED: "Finished: the imported bot decided it was done.",
  PROGRAM_ERROR: "Stopped: the imported bot hit an error it couldn't continue from.",
  PROGRAM_NEVER_PURCHASES: "Stopped: the imported bot kept running without ever buying a contract.",
};


const fieldText = (v: number | undefined) => (v === undefined ? "" : String(v));

function EditBotForm({ bot, onSaved, onCancel }: { bot: BotView; onSaved: () => void; onCancel: () => void }) {
  const params = bot.riskParams;
  const programParams = isProgramParams(params) ? params : null;
  const staking0 = isProgramParams(params) ? null : params.staking;
  const limits = params.riskLimits;

  const [name, setName] = useState(bot.name);
  const [mode, setMode] = useState<"FIXED" | "MARTINGALE">(staking0?.mode ?? "FIXED");
  const [stake, setStake] = useState(staking0?.mode === "FIXED" ? String(staking0.stake) : "1");
  const [baseStake, setBaseStake] = useState(staking0?.mode === "MARTINGALE" ? String(staking0.baseStake) : "1");
  const [multiplier, setMultiplier] = useState(staking0?.mode === "MARTINGALE" ? String(staking0.multiplierOnLoss) : "2");
  const [maxSteps, setMaxSteps] = useState(staking0?.mode === "MARTINGALE" ? String(staking0.maxSteps) : "4");
  const [stopLoss, setStopLoss] = useState(fieldText(limits.stopLossAmount));
  const [targetProfit, setTargetProfit] = useState(fieldText(limits.targetProfitAmount));
  const [maxLosses, setMaxLosses] = useState(fieldText(limits.maxConsecutiveLosses));
  const [maxTrades, setMaxTrades] = useState(fieldText(limits.maxTradesPerSession));
  const [maxStake, setMaxStake] = useState(fieldText(programParams?.program.maxStakePerTrade));
  const [inputs, setInputs] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(programParams?.program.inputs ?? {}).map(([k, v]) => [k, String(v)])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    if (!name.trim()) return setError("The bot needs a name.");
    const riskLimits = { stopLossAmount: num(stopLoss), targetProfitAmount: num(targetProfit), maxConsecutiveLosses: num(maxLosses), maxTradesPerSession: num(maxTrades) };
    if (riskLimits.stopLossAmount === undefined && riskLimits.targetProfitAmount === undefined) {
      return setError("Set a stop-loss or a target profit. A bot can't run without a kill switch.");
    }
    const cleanLimits = Object.fromEntries(Object.entries(riskLimits).filter(([, v]) => v !== undefined));

    let riskParams: BotRiskParams;
    if (programParams) {
      const cap = num(maxStake);
      if (cap === undefined || cap <= 0) return setError("Set the most this bot may stake on a single trade.");
      const values: Record<string, number> = {};
      for (const label of Object.keys(programParams.program.inputs)) {
        const v = num(inputs[label] ?? "");
        if (v === undefined) return setError(`Enter a number for "${label}".`);
        values[label] = v;
      }
      riskParams = { program: { maxStakePerTrade: cap, inputs: values }, riskLimits: cleanLimits };
    } else {
      let staking: BotStaking;
      if (mode === "FIXED") {
        const v = num(stake);
        if (!v || v <= 0) return setError("The stake must be above 0.");
        staking = { mode: "FIXED", stake: v };
      } else {
        const b = num(baseStake);
        const m = num(multiplier);
        const n = num(maxSteps);
        if (!b || b <= 0 || !m || m <= 1 || !n || !Number.isInteger(n) || n <= 0) {
          return setError("Check the stake settings — the multiplier must be above 1 and every amount above 0.");
        }
        staking = { mode: "MARTINGALE", baseStake: b, multiplierOnLoss: m, maxSteps: n, resetOnWin: true };
      }
      riskParams = { staking, riskLimits: cleanLimits } satisfies IndicatorRiskParams;
    }

    setBusy(true);
    try {
      await api.updateBot(bot.id, { name: name.trim(), riskParams });
      onSaved();
    } catch (e) {
      setError(errMsg(e)); // e.g. "Pause or stop the bot before changing its settings"
    } finally {
      setBusy(false);
    }
  }

  const id = (s: string) => `edit-${bot.id}-${s}`;
  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
      <h3 style={{ fontSize: 14, margin: "0 0 10px" }}>Edit settings</h3>

      <div className="field" style={{ maxWidth: 360 }}>
        <label htmlFor={id("name")}>Bot name</label>
        <input id={id("name")} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </div>

      {programParams ? (
        <>
          <div className="field" style={{ maxWidth: 260 }}>
            <label htmlFor={id("maxstake")}>Most it may stake on one trade</label>
            <input id={id("maxstake")} inputMode="decimal" value={maxStake} onChange={(e) => setMaxStake(e.target.value)} />
          </div>
          {Object.keys(inputs).length > 0 && (
            <div className="field-row">
              {Object.keys(inputs).map((label, i) => (
                <div className="field" key={label}>
                  <label htmlFor={id(`input-${i}`)}>{label}</label>
                  <input id={id(`input-${i}`)} inputMode="decimal" value={inputs[label] ?? ""} onChange={(e) => setInputs((prev) => ({ ...prev, [label]: e.target.value }))} />
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="field">
            <label htmlFor={id("mode")}>Staking</label>
            <select id={id("mode")} value={mode} onChange={(e) => setMode(e.target.value as "FIXED" | "MARTINGALE")}>
              <option value="FIXED">Same stake every trade</option>
              <option value="MARTINGALE">Increase the stake after each loss (martingale)</option>
            </select>
          </div>
          {mode === "FIXED" ? (
            <div className="field" style={{ maxWidth: 200 }}>
              <label htmlFor={id("stake")}>Stake per trade</label>
              <input id={id("stake")} inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} />
            </div>
          ) : (
            <div className="field-row">
              <div className="field">
                <label htmlFor={id("base")}>Starting stake</label>
                <input id={id("base")} inputMode="decimal" value={baseStake} onChange={(e) => setBaseStake(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor={id("mult")}>Multiply stake after a loss by</label>
                <input id={id("mult")} inputMode="decimal" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor={id("steps")}>Most steps in the ladder</label>
                <input id={id("steps")} inputMode="numeric" value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} />
              </div>
            </div>
          )}
        </>
      )}

      <div className="field-row">
        <div className="field">
          <label htmlFor={id("sl")}>Stop-loss (stop after losing)</label>
          <input id={id("sl")} inputMode="decimal" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={id("tp")}>Target profit (stop after winning)</label>
          <input id={id("tp")} inputMode="decimal" value={targetProfit} onChange={(e) => setTargetProfit(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={id("ml")}>Stop after this many losses in a row (optional)</label>
          <input id={id("ml")} inputMode="numeric" value={maxLosses} onChange={(e) => setMaxLosses(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={id("mt")}>Stop after this many trades (optional)</label>
          <input id={id("mt")} inputMode="numeric" value={maxTrades} onChange={(e) => setMaxTrades(e.target.value)} />
        </div>
      </div>

      {error && (
        <div role="alert" className="error-text">
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="button button--inline" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        <button className="button button--inline button--ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 0 }}>
        Changes apply the next time you start or resume the bot. The account and strategy can't be changed — create a new bot for that.
      </p>
    </div>
  );
}



function BotCard({ bot, onChanged, onError }: { bot: BotView; onChanged: () => void; onError: (m: string) => void }) {
  const [trades, setTrades] = useState<BotTradeView[] | null>(null);
  const [showTrades, setShowTrades] = useState(false);
  const [busy, setBusy] = useState(false);
  const real = bot.derivAccount.accountType === "REAL";
  const pl = bot.riskState.sessionProfitLoss;
  const params = bot.riskParams;
  const programBot = isProgramParams(params);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!showTrades) return;
    let cancelled = false;
    const load = () => api.botTrades(bot.id).then((t) => !cancelled && setTrades(t)).catch(() => undefined);
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [showTrades, bot.id]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  function start() {
    if (real) {
      const ok = window.confirm(
        `Start "${bot.name}" on your REAL account ${bot.derivAccount.derivAccountId}?\n\nIt will place real trades automatically, including while you're away, until it hits your stop-loss or target profit or you stop it. You can lose money.`,
      );
      if (!ok) return;
    }
    void act(() => api.startBot(bot.id, real));
  }

  // An imported bot picks its own stakes, so there is no "next stake" to show — only the ceiling.
  const stakeFigure = isProgramParams(params)
    ? { value: params.program.maxStakePerTrade, label: "Most it may stake per trade" }
    : {
        value:
          params.staking.mode === "FIXED"
            ? params.staking.stake
            : Math.round(params.staking.baseStake * Math.pow(params.staking.multiplierOnLoss, Math.min(bot.stakingState.currentStep, params.staking.maxSteps - 1)) * 100) / 100,
        label: "Next stake",
      };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 600 }}>{bot.name}</div>
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
            {bot.strategy.name}
            {programBot ? " (imported bot)" : ""} · <span className="numeric">{bot.symbol}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <span className={`badge badge--${real ? "real" : "demo"}`}>{real ? "REAL" : "Demo"} · {bot.derivAccount.derivAccountId}</span>
          <span className={`pill ${bot.status === "RUNNING" ? "pill--running" : bot.status === "ERROR" ? "pill--error" : ""}`}>{STATUS_LABEL[bot.status]}</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 28, margin: "14px 0", flexWrap: "wrap" }}>
        <div>
          <div className="numeric" style={{ fontSize: 20, color: pl > 0 ? "var(--positive)" : pl < 0 ? "var(--negative)" : undefined }}>
            {pl > 0 ? "+" : ""}
            {pl.toFixed(2)} {bot.derivAccount.currency}
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>This session's profit / loss</div>
        </div>
        <div>
          <div className="numeric" style={{ fontSize: 20 }}>
            {stakeFigure.value.toFixed(2)}
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{stakeFigure.label}</div>
        </div>
        <div>
          <div className="numeric" style={{ fontSize: 20 }}>
            {bot.riskState.tradesCount}
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Trades this session</div>
        </div>
        <div style={{ color: "var(--text-muted)", fontSize: 12, alignSelf: "flex-end" }}>
          {params.riskLimits.stopLossAmount !== undefined && <div>Stop-loss {params.riskLimits.stopLossAmount}</div>}
          {params.riskLimits.targetProfitAmount !== undefined && <div>Target profit {params.riskLimits.targetProfitAmount}</div>}
        </div>
      </div>

      {bot.stopReason && bot.status !== "RUNNING" && (
        <p role="status" style={{ fontSize: 13, color: bot.status === "ERROR" ? "var(--negative)" : "var(--text-muted)", margin: "0 0 12px" }}>
          {STOP_REASON_TEXT[bot.stopReason] ?? `Stopped (${bot.stopReason}).`}
          {bot.lastError && bot.status === "ERROR" ? ` ${bot.lastError}` : ""}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {bot.status !== "RUNNING" && (
          <button className="button button--inline" disabled={busy} onClick={start}>
            {bot.status === "PAUSED" ? "Resume bot" : "Start bot"}
          </button>
        )}
        {bot.status === "RUNNING" && (
          <button className="button button--inline button--ghost" disabled={busy} onClick={() => void act(() => api.pauseBot(bot.id))}>
            Pause
          </button>
        )}
        {(bot.status === "RUNNING" || bot.status === "PAUSED") && (
          <button className="button button--inline button--danger" disabled={busy} onClick={() => void act(() => api.stopBot(bot.id))}>
            Stop bot
          </button>
        )}
        <button className="button button--inline button--ghost" onClick={() => setShowTrades((v) => !v)}>
          {showTrades ? "Hide trades" : "Show trades"}
        </button>
        
        {bot.status !== "RUNNING" && (
          <button className="button button--inline button--ghost" disabled={busy} onClick={() => setEditing((v) => !v)}>
            {editing ? "Close editor" : "Edit settings"}
          </button>
        )}
        
        {bot.status !== "RUNNING" && (
          <button
            className="button button--inline button--danger"
            disabled={busy}
            onClick={() => window.confirm(`Delete "${bot.name}" and its trade history? This can't be undone.`) && void act(() => api.deleteBot(bot.id))}
          >
            Delete
          </button>
        )}
      </div>

      {editing && bot.status !== "RUNNING" && (
      <EditBotForm
        bot={bot}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onChanged();
        }}
      />
    )}

      {showTrades && (
        <div style={{ marginTop: 14 }}>
          {trades === null ? (
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
          ) : trades.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No trades yet.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 12 }}>
                  <th style={{ padding: "6px 0" }}>Placed</th>
                  <th>Type</th>
                  <th>Stake</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => {
                  const profit = t.profit === null ? null : Number(t.profit);
                  return (
                    <tr key={t.id} style={{ borderTop: "1px solid var(--border)" }}>
                      <td style={{ padding: "6px 0", color: "var(--text-muted)" }}>{new Date(t.placedAt).toLocaleString()}</td>
                      <td>{t.contractType}</td>
                      <td className="numeric">{Number(t.stake).toFixed(2)}</td>
                      <td className="numeric" style={{ color: profit === null ? "var(--text-muted)" : profit >= 0 ? "var(--positive)" : "var(--negative)" }}>
                        {profit === null ? "Open" : `${profit >= 0 ? "+" : ""}${profit.toFixed(2)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function NewBotForm({ catalog, symbols, onCreated, onCancel }: { catalog: BotCatalogEntry[]; symbols: ActiveSymbol[]; onCreated: () => void; onCancel: () => void }) {
  const derivStatus = useDerivStatus();
  const accounts = (derivStatus?.accounts ?? []).filter((a) => a.status === "active");

  const [strategyId, setStrategyId] = useState(catalog[0]?.id ?? "");
  const strategy = catalog.find((c) => c.id === strategyId);
  const programStrategy = strategy?.kind === "program" ? strategy : null;

  // Default to a demo account when there is one — never silently real.
  const [accountId, setAccountId] = useState(accounts.find((a) => a.accountType === "DEMO")?.id ?? "");
  const account = accounts.find((a) => a.id === accountId);
  const real = account?.accountType === "REAL";

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("R_100");
  const [confirmReal, setConfirmReal] = useState(false);

  // Numeric fields are strings while editing; prefilled from the strategy's suggestion.
  const [mode, setMode] = useState<"FIXED" | "MARTINGALE">("FIXED");
  const [stake, setStake] = useState("1");
  const [baseStake, setBaseStake] = useState("1");
  const [multiplier, setMultiplier] = useState("2");
  const [maxSteps, setMaxSteps] = useState("4");
  const [stopLoss, setStopLoss] = useState("");
  const [targetProfit, setTargetProfit] = useState("");
  const [maxLosses, setMaxLosses] = useState("");
  const [maxTrades, setMaxTrades] = useState("");
  const [maxStake, setMaxStake] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!strategy) return;
    if (strategy.kind === "program") {
      setSymbol(strategy.suggestedSymbol);
      setInputs(Object.fromEntries(strategy.prompts.map((p) => [p, ""])));
      return;
    }
    const s = strategy.suggested;
    if (s.staking.mode === "FIXED") {
      setMode("FIXED");
      setStake(String(s.staking.stake));
    } else {
      setMode("MARTINGALE");
      setBaseStake(String(s.staking.baseStake));
      setMultiplier(String(s.staking.multiplierOnLoss));
      setMaxSteps(String(s.staking.maxSteps));
    }
    setStopLoss(s.riskLimits.stopLossAmount !== undefined ? String(s.riskLimits.stopLossAmount) : "");
    setTargetProfit(s.riskLimits.targetProfitAmount !== undefined ? String(s.riskLimits.targetProfitAmount) : "");
    setMaxLosses(s.riskLimits.maxConsecutiveLosses !== undefined ? String(s.riskLimits.maxConsecutiveLosses) : "");
    setMaxTrades(s.riskLimits.maxTradesPerSession !== undefined ? String(s.riskLimits.maxTradesPerSession) : "");
  }, [strategy]);

  const staking: BotStaking | null = useMemo(() => {
    if (mode === "FIXED") {
      const v = num(stake);
      return v && v > 0 ? { mode: "FIXED", stake: v } : null;
    }
    const b = num(baseStake);
    const m = num(multiplier);
    const n = num(maxSteps);
    return b && b > 0 && m && m > 1 && n && Number.isInteger(n) && n > 0 ? { mode: "MARTINGALE", baseStake: b, multiplierOnLoss: m, maxSteps: n, resetOnWin: true } : null;
  }, [mode, stake, baseStake, multiplier, maxSteps]);

  async function submit() {
    setError(null);
    if (!strategy || !account) return setError("Choose a strategy and an account.");
    if (!name.trim()) return setError("Give the bot a name.");
    if (!programStrategy && !staking) return setError("Check the stake settings — the multiplier must be above 1 and every amount above 0.");
    const riskLimits = { stopLossAmount: num(stopLoss), targetProfitAmount: num(targetProfit), maxConsecutiveLosses: num(maxLosses), maxTradesPerSession: num(maxTrades) };
    if (riskLimits.stopLossAmount === undefined && riskLimits.targetProfitAmount === undefined) {
      return setError("Set a stop-loss or a target profit. A bot can't run without a kill switch.");
    }
    const cleanLimits = Object.fromEntries(Object.entries(riskLimits).filter(([, v]) => v !== undefined));
    let riskParams: BotRiskParams;
    if (programStrategy) {
      const cap = num(maxStake);
      if (cap === undefined || cap <= 0) return setError("Set the most this bot may stake on a single trade.");
      const values: Record<string, number> = {};
      for (const label of programStrategy.prompts) {
        const v = num(inputs[label] ?? "");
        if (v === undefined) return setError(`Enter a number for "${label}".`);
        values[label] = v;
      }
      riskParams = { program: { maxStakePerTrade: cap, inputs: values }, riskLimits: cleanLimits };
    } else {
      riskParams = { staking: staking!, riskLimits: cleanLimits } satisfies IndicatorRiskParams;
    }

    setBusy(true);
    try {
      await api.createBot({ strategyId: strategy.id, accountId: account.id, name: name.trim(), symbol, riskParams, confirmReal: real ? confirmReal : false });
      onCreated();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  if (catalog.length === 0) {
    return (
      <div className="card">
        <p style={{ margin: 0, color: "var(--text-muted)" }}>No strategies are available yet. Check back once one has been published.</p>
        <button className="button button--inline button--ghost" style={{ marginTop: 12 }} onClick={onCancel}>
          Back
        </button>
      </div>
    );
  }

  const peak = !programStrategy && staking ? peakStake(staking) : null;

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>New bot</h2>

      <div className="field">
        <label htmlFor="bot-strategy">Strategy</label>
        <select id="bot-strategy" value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
          {catalog.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {strategy?.kind === "indicator" && (
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {strategy.description} Uses {strategy.indicators.join(", ")} on {strategy.candleGranularitySeconds / 60}-minute candles; places {strategy.contractTypes.join("/")} trades lasting {strategy.tradeParams.durationValue}
            {strategy.tradeParams.durationUnit === "t" ? " ticks" : strategy.tradeParams.durationUnit}.
          </span>
        )}
        {programStrategy && (
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {programStrategy.description} An imported Deriv Bot: it chooses its own stakes and when to trade, and places {programStrategy.contractTypes.join("/")} contracts.
            It runs on our server, not in your browser. Your limits below always win — if it tries to stake more than your per-trade limit, it is stopped.
          </span>
        )}
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="bot-account">Trade on account</label>
          <select id="bot-account" value={accountId} onChange={(e) => { setAccountId(e.target.value); setConfirmReal(false); }}>
            <option value="" disabled>
              Choose an account
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.accountType === "REAL" ? "REAL" : "Demo"} · {a.derivAccountId} ({a.currency})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="bot-symbol">Market</label>
          <select id="bot-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {(symbols.length ? symbols : [{ underlying_symbol: "R_100", market: "synthetic_index" } as ActiveSymbol]).map((s) => (
              <option key={s.underlying_symbol} value={s.underlying_symbol}>
                {s.underlying_symbol_name ?? s.underlying_symbol}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="bot-name">Bot name</label>
          <input id="bot-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="My R_100 bot" />
        </div>
      </div>

      {programStrategy ? (
        <>
          <h3 style={{ fontSize: 14, margin: "6px 0 10px" }}>Limits and the bot's own settings</h3>
          <div className="field" style={{ maxWidth: 260 }}>
            <label htmlFor="bot-maxstake">Most it may stake on one trade</label>
            <input id="bot-maxstake" inputMode="decimal" value={maxStake} onChange={(e) => setMaxStake(e.target.value)} />
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>The bot is stopped, not trimmed, if it tries to go higher. Some bots raise their stake after losses, so choose a ceiling you could afford to lose.</span>
          </div>
          {programStrategy.prompts.length > 0 && (
            <div className="field-row">
              {programStrategy.prompts.map((label, i) => (
                <div className="field" key={label}>
                  <label htmlFor={`bot-input-${i}`}>{label}</label>
                  <input id={`bot-input-${i}`} inputMode="decimal" value={inputs[label] ?? ""} onChange={(e) => setInputs((prev) => ({ ...prev, [label]: e.target.value }))} />
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
      <h3 style={{ fontSize: 14, margin: "6px 0 10px" }}>Stake</h3>
      <div className="field">
        <label htmlFor="bot-mode">Staking</label>
        <select id="bot-mode" value={mode} onChange={(e) => setMode(e.target.value as "FIXED" | "MARTINGALE")}>
          <option value="FIXED">Same stake every trade</option>
          <option value="MARTINGALE">Increase the stake after each loss (martingale)</option>
        </select>
      </div>
      {mode === "FIXED" ? (
        <div className="field" style={{ maxWidth: 200 }}>
          <label htmlFor="bot-stake">Stake per trade</label>
          <input id="bot-stake" inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} />
        </div>
      ) : (
        <div className="field-row">
          <div className="field">
            <label htmlFor="bot-base">Starting stake</label>
            <input id="bot-base" inputMode="decimal" value={baseStake} onChange={(e) => setBaseStake(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="bot-mult">Multiply stake after a loss by</label>
            <input id="bot-mult" inputMode="decimal" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="bot-steps">Most steps in the ladder</label>
            <input id="bot-steps" inputMode="numeric" value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} />
          </div>
        </div>
      )}
      {peak !== null && (
        <p className={`notice ${mode === "MARTINGALE" ? "notice--warn" : ""}`} style={{ margin: "0 0 14px" }}>
          The largest single stake this setup can reach is <strong className="numeric">{peak.toFixed(2)}</strong>
          {account ? ` ${account.currency}` : ""}.
          {mode === "MARTINGALE" && " Raising the stake after losses can lose several times your starting stake in a short run. Pick a stake you could afford to lose entirely."}
        </p>
      )}

        </>
      )}

      <h3 style={{ fontSize: 14, margin: "6px 0 10px" }}>Kill switches</h3>
      <div className="field-row">
        <div className="field">
          <label htmlFor="bot-sl">Stop-loss (stop after losing)</label>
          <input id="bot-sl" inputMode="decimal" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="bot-tp">Target profit (stop after winning)</label>
          <input id="bot-tp" inputMode="decimal" value={targetProfit} onChange={(e) => setTargetProfit(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="bot-ml">Stop after this many losses in a row (optional)</label>
          <input id="bot-ml" inputMode="numeric" value={maxLosses} onChange={(e) => setMaxLosses(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="bot-mt">Stop after this many trades (optional)</label>
          <input id="bot-mt" inputMode="numeric" value={maxTrades} onChange={(e) => setMaxTrades(e.target.value)} />
        </div>
      </div>

      {real && (
        <label className="notice notice--warn" style={{ display: "flex", gap: 10, alignItems: "flex-start", margin: "4px 0 14px", cursor: "pointer" }}>
          <input type="checkbox" checked={confirmReal} onChange={(e) => setConfirmReal(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            This is a <strong>real-money</strong> account. I understand the bot will place real trades automatically, including while I'm away, and I can lose money.
          </span>
        </label>
      )}

      {error && (
        <div role="alert" className="error-text">
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button className="button button--inline" disabled={busy || (real && !confirmReal)} onClick={submit}>
          {busy ? "Creating…" : "Create bot"}
        </button>
        <button className="button button--inline button--ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 0 }}>Creating a bot doesn't start it. You'll start it yourself from the list.</p>
    </div>
  );
}

export function BotsPage() {
  const [bots, setBots] = useState<BotView[] | null>(null);
  const [catalog, setCatalog] = useState<BotCatalogEntry[]>([]);
  const [symbols, setSymbols] = useState<ActiveSymbol[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.bots().then(setBots).catch((e) => setError(errMsg(e)));
  }, []);

  useEffect(() => {
    load();
    api.botCatalog().then(setCatalog).catch(() => undefined);
    api.marketSymbols().then(setSymbols).catch(() => undefined);
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <h1 style={{ fontSize: 20, margin: "0 0 6px" }}>Bots</h1>
        {!creating && (
          <button className="button button--inline" onClick={() => setCreating(true)}>
            New bot
          </button>
        )}
      </div>
      <p className="notice" style={{ margin: "0 0 18px" }}>
        Bots trade on your own Deriv account automatically, even when you're not on this site. You choose the stake and the stop-loss, and you can stop a bot at any time.
        Past results don't predict future ones, and no strategy avoids losses.
      </p>

      {error && (
        <div role="alert" className="error-text">
          {error}
        </div>
      )}

      {creating && (
        <NewBotForm
          catalog={catalog}
          symbols={symbols}
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      )}

      {bots === null ? (
        <p style={{ color: "var(--text-muted)" }}>Loading…</p>
      ) : bots.length === 0 && !creating ? (
        <div className="card">
          <p style={{ margin: 0, color: "var(--text-muted)" }}>You don't have any bots yet. Create one to get started. Try it on a demo account first.</p>
        </div>
      ) : (
        bots.map((b) => <BotCard key={b.id} bot={b} onChanged={() => { setError(null); load(); }} onError={setError} />)
      )}
    </div>
  );
}
