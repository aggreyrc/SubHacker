import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { LiveCandleChart } from "../components/LiveCandleChart";

interface PlaceholderProps {
  title: string;
  note: string;
}

function Placeholder({ title, note }: PlaceholderProps) {
  return (
    <div className="card">
      <h1 style={{ marginTop: 0, fontSize: 18 }}>{title}</h1>
      <p style={{ color: "var(--text-muted)", fontSize: 14 }}>{note}</p>
    </div>
  );
}

const CHART_SIZES = [
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
];

export function DashboardPage() {
  const [symbols, setSymbols] = useState<string[]>(["R_100"]);
  const [symbol, setSymbol] = useState("R_100");
  const [granularity, setGranularity] = useState(60);

  // Offer the user's watchlist; fall back to R_100 if it is empty or can't be loaded.
  useEffect(() => {
    api
      .watchlist()
      .then((list) => {
        if (list.length === 0) return;
        setSymbols(list);
        setSymbol(list[0]!);
      })
      .catch(() => undefined);
  }, []);

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>Live chart</h1>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select aria-label="Market" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {symbols.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {CHART_SIZES.map((g) => (
            <button key={g.seconds} className={`button button--inline ${granularity === g.seconds ? "" : "button--ghost"}`} onClick={() => setGranularity(g.seconds)}>
              {g.label}
            </button>
          ))}
        </div>
      </div>
      <LiveCandleChart symbol={symbol} granularity={granularity} height={380} />
    </div>
  );
}

export function SettingsPage() {
  return <Placeholder title="Settings" note="Application preferences." />;
}
