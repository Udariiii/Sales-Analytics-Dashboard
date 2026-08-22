"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { AccountMenu } from "@/components/account-menu";
import { addDays, buildForecast, DailyPoint, ForecastPoint, ForecastResult, minimumHistoryDays } from "@/lib/forecast";
import { readSalesFile } from "@/lib/file-reader";
import { requestStatsForecast } from "@/lib/remote-forecast";
import { mapColumnsWithLocalAI } from "@/lib/local-ai-mapper";
import { AnalyticsCapabilities, applyMapping, createImportPreview, ImportReport, RawSheet, SalesRow as FlexibleSalesRow, suggestMappings } from "@/lib/sales-import";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const number = new Intl.NumberFormat("en-LK", { maximumFractionDigits: 0 });
const paymentColors = ["#13A6A0", "#17324D", "#F4B942", "#8D6CCF", "#EF7B68"];

function aggregateDaily(rows: FlexibleSalesRow[]): DailyPoint[] {
  const map = new Map<string, { sales: number; profit: number; units: number; invoices: Set<string> }>();
  rows.forEach((r) => {
    const x = map.get(r.date) || { sales: 0, profit: 0, units: 0, invoices: new Set<string>() };
    x.sales += r.net; x.profit += r.profit; x.units += r.quantity; x.invoices.add(r.invoice); map.set(r.date, x);
  });
  const keys = [...map.keys()].sort();
  if (!keys.length) return [];
  const output: DailyPoint[] = [];
  for (let date = keys[0]; date <= keys.at(-1)!; date = addDays(date, 1)) {
    const x = map.get(date);
    output.push({ date, sales: x?.sales || 0, profit: x?.profit || 0, units: x?.units || 0, invoices: x?.invoices.size || 0 });
  }
  return output;
}

function sumBy(rows: FlexibleSalesRow[], key: keyof FlexibleSalesRow, value: keyof FlexibleSalesRow) {
  const map = new Map<string, number>();
  rows.forEach((r) => map.set(String(r[key]), (map.get(String(r[key])) || 0) + Number(r[value])));
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function pct(value: number) { return `${(value * 100).toFixed(1)}%`; }
function shortDate(date: string) { return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-LK", { day: "numeric", month: "short" }); }
function fullDate(date: string) { return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-LK", { weekday: "short", day: "numeric", month: "short", year: "numeric" }); }

function friendlyModelName(name: string) {
  const normalized = name.toLowerCase();
  if (normalized.includes("calendar ridge")) return "Sales trend and calendar pattern";
  if (normalized.includes("annual seasonal") || normalized.includes("yearly sales")) return "Last year adjusted to today";
  if (normalized.includes("calendar + annual") || normalized.includes("calendar and yearly")) return "Calendar and yearly sales pattern";
  if (normalized.includes("weekly and yearly")) return "Trend, weekly and yearly pattern";
  if (normalized.includes("seasonal naive")) return "Recent weekly pattern";
  if (normalized.includes("recent weekday")) return "Recent weekday pattern";
  if (normalized.includes("robust weekday")) return "Stable weekday pattern";
  if (normalized.includes("trend + weekday")) return "Trend and weekday pattern";
  if (normalized.includes("autoets")) return "Trend and seasonal pattern";
  if (normalized.includes("autoarima")) return "Historical sales pattern";
  if (normalized.includes("theta")) return "Long-term trend pattern";
  return "Best-performing sales pattern";
}

function detectCurrency(headers: string[]) {
  const headerText = headers.join(" ").toLowerCase();
  if (/\b(?:usd|dollar)\b/.test(headerText)) return "USD";
  if (/\b(?:eur|euro)\b/.test(headerText)) return "EUR";
  if (/\b(?:gbp|pound)\b/.test(headerText)) return "GBP";
  if (/\b(?:inr|rupee)\b/.test(headerText) && !/lkr|sri lanka/.test(headerText)) return "INR";
  return "LKR";
}

type LineTooltip = { left: number; top: number; date: string; label: string; value: string; range?: string };

function LineChart({ historical, forecast, mode, currency }: { historical: DailyPoint[]; forecast: ForecastPoint[]; mode: "history" | "forecast"; currency: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [tooltip, setTooltip] = useState<LineTooltip | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    canvas.width = width * ratio; canvas.height = height * ratio;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.scale(ratio, ratio);
    const pad = { l: 52, r: 18, t: 18, b: 34 };
    const history = mode === "history" ? historical : historical.slice(-60);
    const values = [...history.map((d) => d.sales), ...forecast.map((d) => d.value)];
    const max = Math.max(...values) * 1.12, min = 0;
    const count = Math.max(2, values.length);
    const x = (i: number) => pad.l + i * (width - pad.l - pad.r) / (count - 1);
    const y = (v: number) => height - pad.b - (v - min) * (height - pad.t - pad.b) / Math.max(1, max - min);
    const draw = (vals: number[], offset: number, color: string, dashed = false) => {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.setLineDash(dashed ? [6, 5] : []);
      vals.forEach((v, i) => { const xx = x(i + offset), yy = y(v); if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy); });
      ctx.stroke(); ctx.setLineDash([]);
    };
    const labels = mode === "history" ? [history[0]?.date, history[Math.floor(history.length / 2)]?.date, history.at(-1)?.date] : [history[0]?.date, history.at(-1)?.date, forecast.at(-1)?.date];
    const allValues = [...history.map((d) => d.sales), ...forecast.map((d) => d.value)];
    const render = (progress: number, hoveredIndex: number | null = null) => {
      ctx.clearRect(0, 0, width, height);
      ctx.font = "11px Segoe UI, Arial"; ctx.textAlign = "left"; ctx.fillStyle = "#718096"; ctx.strokeStyle = "#E2E8F0"; ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const value = max * i / 4, yy = y(value);
        ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(width - pad.r, yy); ctx.stroke();
        ctx.fillText(compact.format(value), 5, yy + 4);
      }

      ctx.save();
      ctx.beginPath(); ctx.rect(pad.l - 4, pad.t - 4, (width - pad.l - pad.r + 8) * progress, height - pad.t - pad.b + 8); ctx.clip();
      draw(history.map((d) => d.sales), 0, "#0C9B8E");
      if (forecast.length) {
        const offset = history.length - 1;
        const joined = [history.at(-1)!.sales, ...forecast.map((d) => d.value)];
        ctx.beginPath();
        forecast.forEach((d, i) => { const xx = x(offset + i + 1), yy = y(d.upper); if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy); });
        [...forecast].reverse().forEach((d, reverseIndex) => { const i = forecast.length - 1 - reverseIndex; ctx.lineTo(x(offset + i + 1), y(d.lower)); });
        ctx.closePath(); ctx.fillStyle = "rgba(245,185,64,.18)"; ctx.fill();
        draw(joined, offset, "#D99518", true);
        ctx.strokeStyle = "#AAB9C5"; ctx.beginPath(); ctx.moveTo(x(offset), pad.t); ctx.lineTo(x(offset), height - pad.b); ctx.stroke();
      }
      ctx.restore();

      if (hoveredIndex === null && allValues.length > 1 && progress > 0.02) {
        const position = (allValues.length - 1) * progress;
        const left = Math.floor(position), right = Math.min(allValues.length - 1, left + 1), fraction = position - left;
        const markerValue = allValues[left] + (allValues[right] - allValues[left]) * fraction;
        ctx.beginPath(); ctx.arc(x(position), y(markerValue), 4, 0, Math.PI * 2);
        ctx.fillStyle = position < history.length - 1 ? "#0C9B8E" : "#D99518"; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = "#FFFFFF"; ctx.stroke();
      }

      ctx.fillStyle = "#718096"; ctx.textAlign = "center";
      labels.forEach((label, i) => { if (label) ctx.fillText(shortDate(label), pad.l + i * (width - pad.l - pad.r) / 2, height - 10); });

      if (hoveredIndex !== null) {
        const xx = x(hoveredIndex), yy = y(allValues[hoveredIndex]);
        ctx.save();
        ctx.setLineDash([3, 4]); ctx.strokeStyle = "#8EA4B4"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(xx, pad.t); ctx.lineTo(xx, height - pad.b); ctx.stroke();
        ctx.setLineDash([]); ctx.beginPath(); ctx.arc(xx, yy, 5, 0, Math.PI * 2);
        ctx.fillStyle = hoveredIndex < history.length ? "#0C9B8E" : "#D99518"; ctx.fill();
        ctx.lineWidth = 2.5; ctx.strokeStyle = "#FFFFFF"; ctx.stroke(); ctx.restore();
      }
    };

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let animationFrame = 0;
    if (reducedMotion) render(1);
    else {
      const startedAt = performance.now();
      const animate = (time: number) => {
        const elapsed = Math.min(1, (time - startedAt) / 900);
        render(1 - Math.pow(1 - elapsed, 3));
        if (elapsed < 1) animationFrame = requestAnimationFrame(animate);
      };
      animationFrame = requestAnimationFrame(animate);
    }

    const money = new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 });
    const hideTooltip = () => { setTooltip(null); render(1); };
    const showTooltip = (event: PointerEvent) => {
      cancelAnimationFrame(animationFrame);
      const rect = canvas.getBoundingClientRect();
      const localX = (event.clientX - rect.left) * width / Math.max(1, rect.width);
      const index = Math.max(0, Math.min(allValues.length - 1, Math.round((localX - pad.l) / Math.max(1, width - pad.l - pad.r) * (count - 1))));
      const pointX = x(index), pointY = y(allValues[index]);
      const isForecast = index >= history.length;
      const forecastPoint = isForecast ? forecast[index - history.length] : null;
      const date = isForecast ? forecastPoint!.date : history[index].date;
      setTooltip({
        left: Math.max(86, Math.min(width - 86, pointX)),
        top: Math.max(20, pointY - 10),
        date: fullDate(date),
        label: isForecast ? "Expected sales" : "Sales",
        value: money.format(allValues[index]),
        range: forecastPoint ? `${money.format(forecastPoint.lower)} – ${money.format(forecastPoint.upper)}` : undefined,
      });
      render(1, index);
    };
    canvas.addEventListener("pointermove", showTooltip);
    canvas.addEventListener("pointerleave", hideTooltip);
    return () => {
      cancelAnimationFrame(animationFrame);
      canvas.removeEventListener("pointermove", showTooltip);
      canvas.removeEventListener("pointerleave", hideTooltip);
    };
  }, [historical, forecast, mode, currency]);
  return <div className="line-chart-wrap"><canvas ref={ref} className="line-canvas" aria-label={mode === "forecast" ? "Historical and forecast sales line chart. Hover to see daily values." : "Historical daily sales line chart. Hover to see daily values."} />{tooltip && <div className="chart-tooltip line-tooltip" role="tooltip" style={{ left: tooltip.left, top: tooltip.top }}><strong>{tooltip.date}</strong><span>{tooltip.label}: {tooltip.value}</span>{tooltip.range && <small>Likely range: {tooltip.range}</small>}</div>}</div>;
}

function PaymentDonut({ payments, currency }: { payments: [string, number][]; currency: string }) {
  const [tooltip, setTooltip] = useState<{ left: number; top: number; name: string; value: string; share: string } | null>(null);
  const total = payments.reduce((sum, payment) => sum + payment[1], 0) || 1;
  const stops = payments.reduce<{ cursor: number; stops: string[] }>((result, payment, index) => {
    const start = result.cursor, end = start + payment[1] / total * 100;
    return { cursor: end, stops: [...result.stops, `${paymentColors[index % paymentColors.length]} ${start}% ${end}%`] };
  }, { cursor: 0, stops: [] });
  const donut = `conic-gradient(${stops.stops.join(",")})`;
  const money = useMemo(() => new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }), [currency]);
  const showTooltip = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const dx = x - rect.width / 2, dy = y - rect.height / 2;
    const radius = Math.sqrt(dx * dx + dy * dy);
    if (radius < 35 || radius > rect.width / 2 + 4) { setTooltip(null); return; }
    const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 450) % 360;
    let cursor = 0;
    const selected = payments.find((payment) => { cursor += payment[1] / total * 360; return angle <= cursor; }) || payments.at(-1);
    if (!selected) return;
    setTooltip({ left: Math.max(68, Math.min(rect.width - 68, x)), top: Math.max(10, y - 10), name: selected[0], value: money.format(selected[1]), share: pct(selected[1] / total) });
  };
  return <div className="donut-wrap"><div className="donut-interaction"><div className="donut" style={{ background: donut }} onPointerMove={showTooltip} onPointerLeave={() => setTooltip(null)} role="img" aria-label="Payment method share chart. Hover a section to see exact sales."><span><strong>{payments.length}</strong>methods</span></div>{tooltip && <div className="chart-tooltip donut-tooltip" role="tooltip" style={{ left: tooltip.left, top: tooltip.top }}><strong>{tooltip.name}</strong><span>{tooltip.value}</span><small>{tooltip.share} of sales</small></div>}</div><div className="donut-legend">{payments.map(([name, value], i) => <div key={name} title={`${name}: ${money.format(value)} (${pct(value / total)})`}><i style={{ background: paymentColors[i % paymentColors.length] }} /><span>{name}</span><strong>{pct(value / total)}</strong></div>)}</div></div>;
}

function WeekdayChart({ days, max, currency }: { days: { name: string; value: number }[]; max: number; currency: string }) {
  const money = useMemo(() => new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }), [currency]);
  return <div className="weekday-chart">{days.map((day) => <button type="button" className="weekday-column" key={day.name} aria-label={`${day.name}: average sales ${money.format(day.value)}`}><span>{compact.format(day.value)}</span><i style={{ height: `${Math.max(7, day.value / max * 100)}%` }} /><small>{day.name}</small><div className="chart-tooltip weekday-tooltip" role="tooltip"><strong>{day.name}</strong><span>Average sales</span><small>{money.format(day.value)}</small></div></button>)}</div>;
}

function Icon({ children }: { children: React.ReactNode }) { return <span className="icon" aria-hidden="true">{children}</span>; }

type DeepSeekInsight = { headline: string; summary: string; actions: string[]; risks: string[] };

function combineForecasts(local: ForecastResult | null, stats: ForecastResult | null) {
  if (!local) return stats;
  if (!stats) return local;
  const selected = stats.winner.wape < local.winner.wape ? stats : local;
  const models = [...local.models, ...stats.models]
    .filter((model, index, all) => all.findIndex((candidate) => candidate.name === model.name) === index)
    .sort((a, b) => a.wape - b.wape);
  return {
    ...selected,
    models,
    baseline: local.baseline,
    relativeImprovement: local.baseline.wape ? (local.baseline.wape - selected.winner.wape) / local.baseline.wape : 0,
    engine: "Hybrid selection" as const,
  };
}

export default function Home() {
  const [rows, setRows] = useState<FlexibleSalesRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("Reading your sales file…");
  const [error, setError] = useState("");
  const [uploadNotice, setUploadNotice] = useState("");
  const [section, setSection] = useState<"overview" | "forecast" | "products" | "methodology">("overview");
  const [category, setCategory] = useState("All categories");
  const [period, setPeriod] = useState("Full year");
  const [forecastDays, setForecastDays] = useState(30);
  const [currency, setCurrency] = useState("LKR");
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const [statsForecast, setStatsForecast] = useState<ForecastResult | null>(null);
  const [forecastServiceState, setForecastServiceState] = useState<"idle" | "loading" | "ready" | "setup" | "fallback">("idle");
  const [forecastServiceMessage, setForecastServiceMessage] = useState("");
  const [deepSeekInsight, setDeepSeekInsight] = useState<DeepSeekInsight | null>(null);
  const [deepSeekState, setDeepSeekState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [deepSeekMessage, setDeepSeekMessage] = useState("");

  const money = useMemo(() => new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }), [currency]);
  const capabilities: AnalyticsCapabilities = importReport?.capabilities || {
    salesTrend: true, forecast: true, profit: true, quantity: true, invoices: true,
    category: true, product: true, payment: true, promotion: true, customer: false, store: false,
  };


  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { setError("Choose a file smaller than 25 MB so it can be processed safely in the browser."); input.value = ""; return; }
    setLoading(true); setLoadingMessage("Reading your spreadsheet…"); setError(""); setUploadNotice("");
    try {
      const sheets = await readSalesFile(file);
      const usable = sheets.map((sheet) => {
        try {
          const candidate = createImportPreview(file.name, sheet);
          const suggested = suggestMappings(candidate.profiles);
          const coreScore = suggested.filter((choice) => choice.target === "date" || choice.target === "netSales").reduce((sum, choice) => sum + choice.confidence, 0);
          return { sheet, score: coreScore * 1000 + candidate.rows.length };
        } catch { return null; }
      }).filter((value): value is { sheet: RawSheet; score: number } => Boolean(value));
      if (!usable.length) throw new Error("No worksheet with a usable header and sales rows was found.");
      usable.sort((a, b) => b.score - a.score);
      const preview = createImportPreview(file.name, usable[0].sheet);
      const safeMappings = suggestMappings(preview.profiles);
      setCurrency(detectCurrency(preview.headers));
      setLoadingMessage("Understanding your sales columns…");
      let mappings = safeMappings;
      try {
        mappings = await mapColumnsWithLocalAI(preview.profiles, (message) => setLoadingMessage(message));
      } catch {
        setLoadingMessage("Using built-in sales matching rules…");
      }
      let applied;
      try {
        applied = applyMapping(preview, mappings);
      } catch {
        applied = applyMapping(preview, safeMappings);
      }
      setRows(applied.rows);
      setImportReport(applied.report);
      setFileName(file.name);
      setCategory("All categories");
      setPeriod("Full year");
      setSection("overview");
      setUploadNotice(`${file.name} is ready — ${number.format(applied.report.acceptedRows)} sales records loaded using ${applied.report.mappedFields.length} useful columns.`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "The selected file could not be read.");
    } finally {
      setLoading(false);
      input.value = "";
    }
  };


  const categories = useMemo(() => capabilities.category ? ["All categories", ...new Set(rows.map((r) => r.category))] : ["All categories"], [rows, capabilities.category]);
  const filtered = useMemo(() => {
    let output = category === "All categories" ? rows : rows.filter((r) => r.category === category);
    if (period !== "Full year" && output.length) {
      const days = period === "Last 30 days" ? 30 : 90;
      const last = output.reduce((m, r) => r.date > m ? r.date : m, "");
      const start = addDays(last, -(days - 1)); output = output.filter((r) => r.date >= start);
    }
    return output;
  }, [rows, category, period]);

  const dailyAll = useMemo(() => aggregateDaily(rows), [rows]);
  const dailyFiltered = useMemo(() => aggregateDaily(filtered), [filtered]);
  const localForecast = useMemo(() => buildForecast(dailyAll, forecastDays), [dailyAll, forecastDays]);
  /* eslint-disable react-hooks/set-state-in-effect -- reset stale async results before synchronizing with the external forecast service */

  useEffect(() => {
    setStatsForecast(null);
    setDeepSeekInsight(null);
    setDeepSeekState("idle");
    setDeepSeekMessage("");
    if (!localForecast) {
      setForecastServiceState("idle");
      setForecastServiceMessage("");
      return;
    }
    if (!process.env.NEXT_PUBLIC_FORECAST_API_URL) {
      setForecastServiceState("setup");
      setForecastServiceMessage("The quick forecast is ready. Connect the online forecast service to compare more approaches.");
      return;
    }
    const controller = new AbortController();
    setForecastServiceState("loading");
    setForecastServiceMessage("Checking additional forecast approaches. You can use the estimate below while this finishes.");
    requestStatsForecast(dailyAll, forecastDays, controller.signal)
      .then((result) => {
        setStatsForecast(result);
        setForecastServiceState("ready");
        setForecastServiceMessage("Several approaches were checked against past sales. The best-performing estimate is now shown.");
      })
      .catch((forecastError) => {
        if (forecastError instanceof DOMException && forecastError.name === "AbortError") return;
        setForecastServiceState("fallback");
        setForecastServiceMessage(forecastError instanceof Error ? forecastError.message : "The online check is unavailable, so the quick forecast is shown instead.");
      });
    return () => controller.abort();
  }, [dailyAll, forecastDays, localForecast]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const forecast = useMemo(() => combineForecasts(localForecast, statsForecast), [localForecast, statsForecast]);
  const categorySales = useMemo(() => capabilities.category ? sumBy(filtered, "category", "net") : [], [filtered, capabilities.category]);
  const productSales = useMemo(() => capabilities.product ? sumBy(filtered, "product", "net").slice(0, 10) : [], [filtered, capabilities.product]);
  const payments = useMemo(() => capabilities.payment ? sumBy(filtered, "payment", "net") : [], [filtered, capabilities.payment]);
  const promotions = useMemo(() => capabilities.promotion ? sumBy(filtered.filter((r) => r.promotion !== "None"), "promotion", "discount") : [], [filtered, capabilities.promotion]);

  const metrics = useMemo(() => {
    const net = filtered.reduce((a, r) => a + r.net, 0), profit = filtered.reduce((a, r) => a + r.profit, 0);
    const units = filtered.reduce((a, r) => a + r.quantity, 0), invoices = new Set(filtered.map((r) => r.invoice).filter(Boolean)).size;
    return { net, profit, units, invoices, basket: invoices ? net / invoices : 0, margin: net ? profit / net : 0 };
  }, [filtered]);

  const weekday = useMemo(() => {
    const sums = Array(7).fill(0), counts = Array(7).fill(0), names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    dailyFiltered.forEach((d) => { const i = new Date(`${d.date}T00:00:00Z`).getUTCDay(); sums[i] += d.sales; counts[i]++; });
    return names.map((name, i) => ({ name, value: counts[i] ? sums[i] / counts[i] : 0 }));
  }, [dailyFiltered]);

  const dataProfile = useMemo(() => {
    const sales = dailyAll.map((point) => point.sales).sort((a, b) => a - b);
    const quartile = (probability: number) => {
      if (!sales.length) return 0;
      const index = (sales.length - 1) * probability;
      const lower = Math.floor(index), fraction = index - lower;
      return sales[lower] + (sales[lower + 1] - sales[lower] || 0) * fraction;
    };
    const q1 = quartile(0.25), q3 = quartile(0.75), upperFence = q3 + 1.5 * (q3 - q1);
    return {
      historyDays: dailyAll.length,
      zeroDays: dailyAll.filter((point) => point.sales === 0).length,
      unusualDays: dailyAll.filter((point) => point.sales > upperFence).length,
    };
  }, [dailyAll]);

  const futureTotal = forecast?.points.reduce((a, b) => a + b.value, 0) || 0;

  const categoryForecasts = useMemo(() => {
    if (!forecast || !rows.length || !capabilities.category) return [];
    const latest = dailyAll.at(-1)!.date, previousStart = addDays(latest, -59), recentStart = addDays(latest, -29);
    const estimates = categories.slice(1).map((name) => {
      const recentRows = rows.filter((r) => r.category === name && r.date >= recentStart);
      const previousRows = rows.filter((r) => r.category === name && r.date >= previousStart && r.date < recentStart);
      const recentSales = recentRows.reduce((a, r) => a + r.net, 0), previousSales = previousRows.reduce((a, r) => a + r.net, 0);
      const recentUnits = recentRows.reduce((a, r) => a + r.quantity, 0);
      const momentum = previousSales ? Math.max(0.85, Math.min(1.15, recentSales / previousSales)) : 1;
      return { name, weight: recentSales * (0.85 + 0.15 * momentum), unitsPerLkr: recentSales ? recentUnits / recentSales : 0, change: momentum - 1 };
    });
    const totalWeight = estimates.reduce((sum, estimate) => sum + estimate.weight, 0) || 1;
    return estimates.map((estimate) => {
      const sales = futureTotal * estimate.weight / totalWeight;
      return { name: estimate.name, sales, units: sales * estimate.unitsPerLkr, change: estimate.change };
    }).sort((a, b) => b.sales - a.sales).slice(0, 6);
  }, [forecast, rows, dailyAll, categories, futureTotal, capabilities.category]);

  const previousComparable = dailyAll.slice(-forecastDays).reduce((a, b) => a + b.sales, 0);
  const forecastChange = previousComparable ? futureTotal / previousComparable - 1 : 0;
  const comparedModels = forecast ? [...forecast.models.slice(0, 3), ...(forecast.models.slice(0, 3).some((model) => model.name === "Seasonal naive") ? [] : [forecast.baseline])] : [];
  const maxComparedWape = Math.max(...comparedModels.map((model) => model.wape), 0.01);
  const cautiousForecast = forecast?.confidence === "Low" || forecast?.confidence === "Very low";
  const topGrowth = [...categoryForecasts].sort((a, b) => b.change - a.change)[0];
  const topCategory = categorySales[0];
  const maxCategory = categorySales[0]?.[1] || 1;
  const maxProduct = productSales[0]?.[1] || 1;
  const maxWeekday = Math.max(...weekday.map((d) => d.value), 1);

  const generateDeepSeekInsight = async () => {
    if (!forecast) return;
    setDeepSeekState("loading");
    setDeepSeekMessage("");
    try {
      const response = await fetch("/api/ai/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: fileName,
          currency,
          history: { days: dataProfile.historyDays, zeroDays: dataProfile.zeroDays, unusualDays: dataProfile.unusualDays },
          forecast: {
            horizonDays: forecastDays,
            model: forecast.winner.name,
            engine: forecast.engine,
            total: futureTotal,
            changeFromPreviousPeriod: forecastChange,
            wape: forecast.winner.wape,
            mae: forecast.winner.mae,
            bias: forecast.winner.bias,
            intervalCoverage: forecast.intervalCoverage,
          },
          currentSales: metrics.net,
          topCategories: categorySales.slice(0, 5).map(([name, sales]) => ({ name, sales })),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "DeepSeek analysis failed.");
      setDeepSeekInsight(body as DeepSeekInsight);
      setDeepSeekState("ready");
    } catch (insightError) {
      setDeepSeekState("error");
      setDeepSeekMessage(insightError instanceof Error ? insightError.message : "DeepSeek analysis failed.");
    }
  };


  if (loading) return <main className="app-loading"><div className="loading-mark">RP</div><h1>Preparing your dashboard</h1><p>{loadingMessage}</p><div className="loader"><span /></div><small>This usually takes less than a minute on first use.</small></main>;

  if (!rows.length) return (
    <main className="app-shell empty-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">RP</div><div><strong>RetailPulse</strong><span>AI Sales Intelligence</span></div></div>
        <nav aria-label="Dashboard sections">
          <button className="active"><Icon>⌂</Icon>Get started</button>
          <button disabled><Icon>↗</Icon>Sales forecast</button>
          <button disabled><Icon>▦</Icon>What sells best</button>
          <button disabled><Icon>◎</Icon>How it works</button>
        </nav>
        <div className="sidebar-note"><span>Private workspace</span><p>Your uploaded file is processed locally in this browser.</p></div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">YOUR BUSINESS DASHBOARD</p><h1>Turn sales data into clear decisions</h1></div>
          <AccountMenu />
        </header>
        {error && <div className="error-banner"><strong>File issue</strong><span>{error}</span></div>}
        <section className="empty-upload">
          <div className="empty-upload-mark" aria-hidden="true">⇧</div>
          <p className="eyebrow">YOUR DATA, YOUR WORKSPACE</p>
          <h2>Upload almost any sales spreadsheet</h2>
          <p>Choose your file and RetailPulse will automatically understand it, check it, and take you straight to the insights your business can use.</p>
          <label className="upload-button upload-primary">Choose sales file<input aria-label="Upload sales data file" type="file" accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={upload} /></label>
          <div className="upload-requirements">
            <div><strong>Accepted formats</strong><span>CSV, TSV and Excel XLSX · multiple worksheets supported</span></div>
            <div><strong>Minimum information</strong><span>A date column and a sales or revenue amount</span></div>
            <div><strong>Private local AI</strong><span>Mapping runs in your browser; sales rows are not sent to an AI provider</span></div>
          </div>
        </section>
        <footer><span>RetailPulse · Sales intelligence for SMEs</span><span>Your file stays private in this browser.</span></footer>
      </section>
    </main>
  );

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">RP</div><div><strong>RetailPulse</strong><span>AI Sales Intelligence</span></div></div>
        <nav aria-label="Dashboard sections">
          <button className={section === "overview" ? "active" : ""} onClick={() => setSection("overview")}><Icon>⌂</Icon>Overview</button>
          <button className={section === "forecast" ? "active" : ""} onClick={() => setSection("forecast")}><Icon>↗</Icon>Sales forecast</button>
          <button disabled={!capabilities.product && !capabilities.category} className={section === "products" ? "active" : ""} onClick={() => setSection("products")}><Icon>▦</Icon>What sells best</button>
          <button className={section === "methodology" ? "active" : ""} onClick={() => setSection("methodology")}><Icon>◎</Icon>How it works</button>
        </nav>
        <div className="sidebar-note"><span>Made for business owners</span><p>Clear answers from your own sales data, without analytics jargon.</p></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">YOUR BUSINESS DASHBOARD</p><h1>{section === "overview" ? "Your business at a glance" : section === "forecast" ? "Plan your next sales period" : section === "products" ? "See what drives your sales" : "How your forecast works"}</h1></div>
          <div className="top-actions">
            <div className="data-status"><span className="status-dot" /><div><strong>{fileName}</strong><small>{number.format(rows.length)} sales records ready</small></div></div>
            <label className="upload-button">Upload new file<input aria-label="Upload sales data file" type="file" accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={upload} /></label>
            <AccountMenu />
          </div>
        </header>

        {error && <div className="error-banner"><strong>File issue</strong><span>{error}</span></div>}
        {uploadNotice && <div className="upload-success" role="status" data-testid="upload-status"><span className="success-check">✓</span><div><strong>Upload complete</strong><span>{uploadNotice}</span></div><button aria-label="Dismiss upload message" onClick={() => setUploadNotice("")}>×</button></div>}

        {section !== "methodology" && <div className="filterbar">
          {capabilities.category && <label>Category<select value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((c) => <option key={c}>{c}</option>)}</select></label>}
          <label>Show results for<select value={period} onChange={(e) => setPeriod(e.target.value)}><option value="Full year">All available data</option><option value="Last 90 days">Last 90 days</option><option value="Last 30 days">Last 30 days</option></select></label>
          <div className="filter-meta"><span>Data period</span><strong>{dailyAll[0]?.date} — {dailyAll.at(-1)?.date}</strong></div>
        </div>}

        {section === "overview" && <>
          <section className="kpi-grid">
            <article className="kpi primary"><span>Sales revenue</span><strong>{money.format(metrics.net)}</strong><small>{capabilities.invoices ? `${number.format(metrics.invoices)} customer sales` : `${number.format(filtered.length)} sales records`}</small></article>
            {capabilities.profit && <article className="kpi"><span>Gross profit</span><strong>{money.format(metrics.profit)}</strong><small className="positive">{pct(metrics.margin)} of revenue kept as gross profit</small></article>}
            {capabilities.quantity && <article className="kpi"><span>Items sold</span><strong>{number.format(metrics.units)}</strong><small>{capabilities.invoices ? `${(metrics.units / Math.max(1, metrics.invoices)).toFixed(1)} items per customer sale` : "Total quantity in this period"}</small></article>}
            {capabilities.invoices && <article className="kpi"><span>Average customer sale</span><strong>{money.format(metrics.basket)}</strong><small>Average revenue per invoice</small></article>}
          </section>
          {importReport && <section className="import-summary" aria-label="Import quality summary">
            <div><span>Useful columns found</span><strong>{importReport.mappedFields.length}</strong></div>
            <div><span>Sales records used</span><strong>{number.format(importReport.acceptedRows)}</strong></div>
            <div><span>Rows skipped</span><strong>{number.format(importReport.rejectedRows)}</strong></div>
            <div><span>Possible duplicates</span><strong>{number.format(importReport.exactDuplicateRows)}</strong></div>
            <p>{importReport.rejectedRows || importReport.exactDuplicateRows ? "Some records may need attention before using these totals for formal accounts." : "Your sales file passed the automatic checks."}</p>
          </section>}

          <section className="dashboard-grid">
            <article className="panel span-2"><div className="panel-head"><div><p>SALES MOVEMENT</p><h2>How your sales changed over time</h2></div><span className="legend"><i />Your sales</span></div><LineChart historical={dailyFiltered} forecast={[]} mode="history" currency={currency} /></article>
            {capabilities.category && <article className="panel"><div className="panel-head"><div><p>WHERE MONEY COMES FROM</p><h2>Sales by category</h2></div></div><div className="bar-list">{categorySales.slice(0, 7).map(([name, value]) => <div className="bar-row" key={name}><div><span>{name}</span><strong>{compact.format(value)}</strong></div><div className="bar-track"><i style={{ width: `${value / maxCategory * 100}%` }} /></div></div>)}</div></article>}
            {capabilities.payment && <article className="panel"><div className="panel-head"><div><p>HOW CUSTOMERS PAY</p><h2>Payment methods used</h2></div></div><PaymentDonut payments={payments} currency={currency} /></article>}
            <article className="panel"><div className="panel-head"><div><p>BUSIEST DAYS</p><h2>Your average sales by weekday</h2></div></div><WeekdayChart days={weekday} max={maxWeekday} currency={currency} /></article>
            <article className="panel span-2 insight-panel"><div className="insight-mark">AI</div><div><p>BUSINESS SNAPSHOT</p><h2>{topCategory ? `${topCategory[0]} brings in the most sales` : "Your sales data is ready"}</h2><p>{topCategory ? `${topCategory[0]} provides ${pct(topCategory[1] / Math.max(1, metrics.net))} of revenue. ${promotions.length ? `${promotions[0][0]} created the highest promotional discount value.` : "No promotion details are available for this view."} Open Sales Forecast to plan ahead.` : "Your main sales trends are ready. More views appear automatically when your file contains matching information."}</p></div><button onClick={() => setSection("forecast")}>Plan ahead →</button></article>
          </section>
        </>}

        {section === "forecast" && !forecast && <section className="panel forecast-unavailable"><p className="eyebrow">MORE SALES HISTORY NEEDED</p><h2>There is not enough past data for this forecast yet</h2><p>A {forecastDays}-day forecast needs at least {minimumHistoryDays(forecastDays)} days of sales history. Your file currently contains {dailyAll.length} days. Choose a shorter forecast period or upload more history.</p></section>}

        {section === "forecast" && forecast && <>
          <section className="forecast-hero">
            <div><p className="eyebrow">YOUR SALES FORECAST</p><h2>Expected sales for the next {forecastDays} days</h2><div className="forecast-value"><strong>{money.format(futureTotal)}</strong><span className={forecastChange >= 0 ? "positive-pill" : "negative-pill"}>{forecastChange >= 0 ? "+" : ""}{pct(forecastChange)} compared with the previous {forecastDays} days</span></div><p>Based on {dataProfile.historyDays} days of your sales history. RetailPulse checked several approaches and chose the one that worked best on your past data.</p></div>
            <div className="horizon-toggle" aria-label="Forecast horizon"><button className={forecastDays === 7 ? "active" : ""} onClick={() => setForecastDays(7)}>7 days</button><button className={forecastDays === 30 ? "active" : ""} onClick={() => setForecastDays(30)}>30 days</button><button className={forecastDays === 90 ? "active" : ""} onClick={() => setForecastDays(90)}>3 months</button><button className={forecastDays === 180 ? "active" : ""} onClick={() => setForecastDays(180)}>6 months</button></div>
          </section>
          <div className={`service-status is-${forecastServiceState}`} role="status"><strong>{forecastServiceState === "loading" ? "Improving your forecast" : forecastServiceState === "ready" ? "Forecast updated" : forecastServiceState === "setup" || forecastServiceState === "fallback" ? "Quick forecast active" : "Forecast ready"}</strong><span>{forecastServiceMessage || "The estimate with the smallest past difference is shown."}</span></div>
          <div className={`forecast-confidence ${forecast.confidence.toLowerCase().replace(" ", "-")}`} role="status"><strong>{cautiousForecast ? "Use with care" : "Useful for planning"}</strong><span>When tested on past sales, estimates typically differed by about {pct(forecast.winner.wape)}. {cautiousForecast ? "Plan using the shaded range, not only the centre number." : "Use this with what you know about upcoming promotions, holidays and stock changes."}</span></div>
          <section className="dashboard-grid forecast-grid">
            <article className="panel span-2"><div className="panel-head"><div><p>WHAT MAY HAPPEN NEXT</p><h2>Past sales and expected future sales</h2></div><div className="two-legends"><span className="legend"><i />Past sales</span><span className="legend forecast"><i />Expected sales range</span></div></div><LineChart historical={dailyAll} forecast={forecast.points} mode="forecast" currency={currency} /></article>
            <article className="panel accuracy-card"><div className="panel-head"><div><p>HOW RELIABLE IS IT?</p><h2>How close past estimates were</h2></div></div><div className="accuracy-score"><strong>{pct(forecast.winner.wape)}</strong><span>Typical past difference · lower is better</span></div><dl><div><dt>Chosen approach</dt><dd>{friendlyModelName(forecast.winner.name)}</dd></div><div><dt>Typical daily difference</dt><dd>±{money.format(forecast.winner.mae)}</dd></div><div><dt>Usual direction</dt><dd>{pct(Math.abs(forecast.winner.bias))} {forecast.winner.bias >= 0 ? "below actual sales" : "above actual sales"}</dd></div><div><dt>Past checks completed</dt><dd>{forecast.folds} periods covering {forecast.evaluatedDays} days</dd></div></dl></article>
            <article className="panel"><div className="panel-head"><div><p>WHY THIS ESTIMATE?</p><h2>Past performance of each approach</h2></div></div><div className="model-compare">{comparedModels.map((model) => <div className={model.name === forecast.winner.name ? "winner" : ""} key={model.name}><span>{friendlyModelName(model.name)}</span><strong>{pct(model.wape)} difference</strong><i><b style={{ width: `${model.wape / maxComparedWape * 100}%` }} /></i></div>)}</div><small className="fine-print">Shorter bars performed better on past sales. RetailPulse automatically uses the best result for the period you selected.</small></article>
            {capabilities.category && <article className="panel span-2"><div className="panel-head"><div><p>PLAN BY CATEGORY</p><h2>Expected sales over the next {forecastDays} days</h2></div></div><div className="forecast-table"><div className="table-head"><span>Category</span><span>Expected sales</span><span>Expected items</span><span>Change</span></div>{categoryForecasts.map((c) => <div className="table-row" key={c.name}><strong>{c.name}</strong><span>{money.format(c.sales)}</span><span>{capabilities.quantity ? number.format(c.units) : "Not available"}</span><span className={c.change >= 0 ? "positive" : "negative"}>{c.change >= 0 ? "+" : ""}{pct(c.change)}</span></div>)}</div></article>}
            <article className="panel executive-card"><div className="executive-label"><span>AI</span>AI BUSINESS ADVISER</div>{deepSeekInsight ? <><h2>{deepSeekInsight.headline}</h2><p>{deepSeekInsight.summary}</p><div className="ai-recommendations"><strong>Recommended actions</strong><ul>{deepSeekInsight.actions.map((action) => <li key={action}>{action}</li>)}</ul></div>{deepSeekInsight.risks.length > 0 && <div className="summary-action"><strong>Things to check</strong><span>{deepSeekInsight.risks.join(" ")}</span></div>}</> : <><h2>Turn this forecast into an action plan</h2><p>RetailPulse expects about {money.format(futureTotal)} in sales over the next {forecastDays} days. Past estimates using this approach differed by around {pct(forecast.winner.wape)}.</p><p>{topGrowth ? `${topGrowth.name} currently shows the strongest category growth at ${topGrowth.change >= 0 ? "+" : ""}${pct(topGrowth.change)}.` : "Category opportunities will appear when that information is available."}</p><button className="deepseek-button" disabled={deepSeekState === "loading"} onClick={generateDeepSeekInsight}>{deepSeekState === "loading" ? "Preparing recommendations…" : "Explain this forecast"}</button>{deepSeekMessage && <small className="deepseek-message">{deepSeekMessage}</small>}</>}</article>
            <article className="panel span-3 data-readiness"><div className="panel-head"><div><p>DATA BEHIND THIS FORECAST</p><h2>What RetailPulse used</h2></div></div><div><span><strong>{dataProfile.historyDays}</strong>days of sales history</span><span><strong>{dataProfile.zeroDays}</strong>days with no recorded sales</span><span><strong>{dataProfile.unusualDays}</strong>unusually high-sales days</span><span><strong>{importReport?.mappedFields.length || 2}</strong>useful columns identified</span></div></article>
          </section>
        </>}

        {section === "products" && <section className="dashboard-grid products-grid">
          {capabilities.product && <article className="panel span-2"><div className="panel-head"><div><p>YOUR BEST SELLERS</p><h2>Products bringing in the most revenue</h2></div></div><div className="product-ranking">{productSales.map(([name, value], i) => <div key={name}><span className="rank">{String(i + 1).padStart(2, "0")}</span><div><strong>{name}</strong><i><b style={{ width: `${value / maxProduct * 100}%` }} /></i></div><span>{money.format(value)}</span></div>)}</div></article>}
          {capabilities.category && <article className="panel"><div className="panel-head"><div><p>YOUR SALES MIX</p><h2>Share of sales by category</h2></div></div><div className="category-cards">{categorySales.slice(0, 5).map(([name, value], i) => <div key={name}><span>{i + 1}</span><div><strong>{name}</strong><small>{pct(value / Math.max(1, metrics.net))} of sales</small></div><b>{compact.format(value)}</b></div>)}</div></article>}
          <article className="panel span-3"><div className="panel-head"><div><p>SIMPLE NEXT STEPS</p><h2>How to use these product insights</h2></div></div><div className="decision-steps"><div><span>01</span><strong>Protect best sellers</strong><p>Keep your strongest products available because stock-outs here put the most revenue at risk.</p></div><div><span>02</span><strong>Plan stock</strong><p>{capabilities.quantity ? "Compare expected item demand with supplier delivery time before placing orders." : "Include an item quantity column next time to unlock stock planning."}</p></div><div><span>03</span><strong>Check weekly</strong><p>Compare actual demand with the forecast each week and investigate large changes early.</p></div></div></article>
        </section>}

        {section === "methodology" && <section className="methodology">
          <div className="method-intro"><p className="eyebrow">CLEAR AND HONEST</p><h2>How RetailPulse creates your forecast</h2><p>You do not need to choose a statistical model. RetailPulse checks the options, shows how close they were on past sales, and explains the result in everyday language.</p></div>
          <div className="method-flow"><article><span>1</span><div><h3>Understand your spreadsheet</h3><p>RetailPulse automatically finds the date, sales and other useful columns in your file.</p></div></article><article><span>2</span><div><h3>Check the information</h3><p>Invalid dates and sales values are skipped, and missing financial figures are never invented.</p></div></article><article><span>3</span><div><h3>Find what works best</h3><p>Several forecasting approaches are tried on older parts of your own sales history. The approach that came closest is used.</p></div></article><article><span>4</span><div><h3>Turn the result into action</h3><p>The forecast provides the numbers. DeepSeek can then explain them and suggest practical questions or actions.</p></div></article></div>
          <div className="method-cards"><article><p>CHECKED ON YOUR HISTORY</p><strong>Past performance first</strong><span>The dashboard tests each approach on sales it already knows, before using it for the future.</span></article><article><p>NO MADE-UP NUMBERS</p><strong>Calculations stay separate from AI</strong><span>The forecast engine calculates the estimate. AI only explains verified results.</span></article><article><p>PRIVATE BY DESIGN</p><strong>Your raw rows stay local</strong><span>Your spreadsheet is read in this browser and is not uploaded to DeepSeek.</span></article></div>
          <details className="technical-details"><summary>Technical details for reviewers</summary><p>Forecasts compare local calendar and weekday approaches with StatsForecast AutoETS, AutoARIMA and Theta candidates. Selection uses rolling historical tests and WAPE; lower values mean smaller past differences.</p></details>
          <div className="disclosure"><strong>How your data is used</strong><p>Your spreadsheet rows are processed in this browser and are not retained. Only daily date-and-sales totals go to the forecasting service. DeepSeek receives a short summary only when you click “Explain this forecast.”</p></div>
        </section>}
        <footer><span>RetailPulse · Sales intelligence for SMEs</span><span>Use forecasts as a planning guide alongside your business knowledge.</span></footer>
      </section>
    </main>
  );
}
