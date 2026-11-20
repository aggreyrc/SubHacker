import { useEffect, useRef, useState } from "react";
import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { api, ApiError } from "../lib/api";
import { useMarketTick } from "../lib/useMarketTick";

interface Props {
  symbol: string;
  /** Candle size in seconds: 60 = 1 minute, 300 = 5 minutes, 3600 = 1 hour … */
  granularity?: number;
  height?: number;
}

interface LiveCandle {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Candlestick chart that stays live: it loads the recent candles once, then folds every price
 *  tick into the forming candle (or opens a new one when the next period starts). */
export function LiveCandleChart({ symbol, granularity = 60, height = 360 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastRef = useRef<LiveCandle | null>(null); // the newest candle on the chart
  const pipRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const tick = useMarketTick(symbol);

  // 1) Create the chart once and keep it sized to its container.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: { background: { color: "transparent" }, textColor: "#8b93a3" },
      grid: { vertLines: { color: "#232a36" }, horzLines: { color: "#232a36" } },
      rightPriceScale: { borderColor: "#232a36" },
      timeScale: { borderColor: "#232a36", timeVisible: true, secondsVisible: false },
      width: el.clientWidth,
      height,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#3dd68c",
      downColor: "#f2545b",
      borderVisible: false,
      wickUpColor: "#3dd68c",
      wickDownColor: "#f2545b",
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const observer = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height]);

  // 2) (Re)load history whenever the market or candle size changes.
  useEffect(() => {
    let cancelled = false; // a slow response for an old symbol must never overwrite a newer one
    lastRef.current = null;
    setLoading(true);
    setError(null);
    api
      .marketCandles(symbol, granularity, 200)
      .then(({ candles, pipSize }) => {
        if (cancelled || !seriesRef.current) return;
        const data = candles.map((c) => ({ time: c.epoch as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
        seriesRef.current.setData(data);
        lastRef.current = data[data.length - 1] ?? null;
        pipRef.current = pipSize;
        chartRef.current?.timeScale().fitContent();
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Could not load the chart"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [symbol, granularity]);

  // 3) Fold each live tick into the chart.
  useEffect(() => {
    const series = seriesRef.current;
    const last = lastRef.current;
    if (!tick || !series || !last) return; // no history yet: nothing to attach the tick to
    const bucket = (Math.floor(tick.epoch / granularity) * granularity) as UTCTimestamp;
    if (bucket < last.time) return; // a late tick for a candle that has already closed

    const next: LiveCandle =
      bucket === last.time
        ? { time: last.time, open: last.open, high: Math.max(last.high, tick.quote), low: Math.min(last.low, tick.quote), close: tick.quote }
        : { time: bucket, open: tick.quote, high: tick.quote, low: tick.quote, close: tick.quote }; // new period
    lastRef.current = next;
    series.update(next);
  }, [tick, granularity]);

  const price = tick ? (pipRef.current !== null ? tick.quote.toFixed(pipRef.current) : String(tick.quote)) : "…";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{symbol}</span>
        <span className="numeric" style={{ fontSize: 18 }}>
          {price}
        </span>
      </div>
      {error && (
        <div role="alert" className="error-text">
          {error}
        </div>
      )}
      <div ref={containerRef} style={{ width: "100%", opacity: loading ? 0.5 : 1 }} />
    </div>
  );
}