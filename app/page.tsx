"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountMenu } from "@/components/account-menu";
import { addDays, buildForecast, DailyPoint, ForecastPoint, ForecastResult, minimumHistoryDays } from "@/lib/forecast";
import { readSalesFile } from "@/lib/file-reader";
import { requestStatsForecast } from "@/lib/remote-forecast";
import { mapColumnsWithLocalAI } from "@/lib/local-ai-mapper";
import { AnalyticsCapabilities, applyMapping, CANONICAL_FIELDS, CanonicalField, confidenceLabel, createImportPreview, FIELD_DEFINITIONS, ImportPreview, ImportReport, MappingChoice, RawSheet, SalesRow as FlexibleSalesRow, suggestMappings } from "@/lib/sales-import";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const number = new Intl.NumberFormat("en-LK", { maximumFractionDigits: 0 });

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

function LineChart({ historical, forecast, mode }: { historical: DailyPoint[]; forecast: ForecastPoint[]; mode: "history" | "forecast" }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    canvas.width = width * ratio; canvas.height = height * ratio;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height);
    const pad = { l: 52, r: 18, t: 18, b: 34 };
    const history = mode === "history" ? historical : historical.slice(-60);
    const values = [...history.map((d) => d.sales), ...forecast.map((d) => d.value)];
    const max = Math.max(...values) * 1.12, min = 0;
    const count = Math.max(2, values.length);
    const x = (i: number) => pad.l + i * (width - pad.l - pad.r) / (count - 1);
    const y = (v: number) => height - pad.b - (v - min) * (height - pad.t - pad.b) / Math.max(1, max - min);
    ctx.font = "11px Arial"; ctx.fillStyle = "#718096"; ctx.strokeStyle = "#E2E8F0"; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const value = max * i / 4, yy = y(value);
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(width - pad.r, yy); ctx.stroke();
      ctx.fillText(compact.format(value), 5, yy + 4);
    }
    const draw = (vals: number[], offset: number, color: string, dashed = false) => {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.setLineDash(dashed ? [6, 5] : []);
      vals.forEach((v, i) => { const xx = x(i + offset), yy = y(v); if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy); });
      ctx.stroke(); ctx.setLineDash([]);
    };
    draw(history.map((d) => d.sales), 0, "#13A6A0");
    if (forecast.length) {
      const offset = history.length - 1;
      const joined = [history.at(-1)!.sales, ...forecast.map((d) => d.value)];
      ctx.beginPath();
      forecast.forEach((d, i) => { const xx = x(offset + i + 1), yy = y(d.upper); if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy); });
      [...forecast].reverse().forEach((d, reverseIndex) => { const i = forecast.length - 1 - reverseIndex; ctx.lineTo(x(offset + i + 1), y(d.lower)); });
      ctx.closePath(); ctx.fillStyle = "rgba(244,185,66,.2)"; ctx.fill();
      draw(joined, offset, "#E59C16", true);
      ctx.strokeStyle = "#C8D1DC"; ctx.beginPath(); ctx.moveTo(x(offset), pad.t); ctx.lineTo(x(offset), height - pad.b); ctx.stroke();
    }
    const labels = mode === "history" ? [history[0]?.date, history[Math.floor(history.length / 2)]?.date, history.at(-1)?.date] : [history[0]?.date, history.at(-1)?.date, forecast.at(-1)?.date];
    ctx.fillStyle = "#718096"; ctx.textAlign = "center";
    labels.forEach((label, i) => { if (label) ctx.fillText(shortDate(label), pad.l + i * (width - pad.l - pad.r) / 2, height - 10); });
  }, [historical, forecast, mode]);
  return <canvas ref={ref} className="line-canvas" aria-label={mode === "forecast" ? "Historical and forecast sales line chart" : "Historical daily sales line chart"} />;
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
  const [error, setError] = useState("");
  const [uploadNotice, setUploadNotice] = useState("");
  const [section, setSection] = useState<"overview" | "forecast" | "products" | "methodology">("overview");
  const [category, setCategory] = useState("All categories");
  const [period, setPeriod] = useState("Full year");
  const [forecastDays, setForecastDays] = useState(30);
  const [availableSheets, setAvailableSheets] = useState<RawSheet[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mappings, setMappings] = useState<MappingChoice[]>([]);
  const [aiState, setAiState] = useState<"idle" | "loading" | "ready" | "fallback">("idle");
  const [aiMessage, setAiMessage] = useState("");
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

  const aiRequest = useRef(0);

  const preparePreview = useCallback((candidate: RawSheet, name: string) => {
    const next = createImportPreview(name, candidate);
    const request = ++aiRequest.current;
    setPreview(next);
    setMappings(suggestMappings(next.profiles));
    setAiState("loading");
    setAiMessage("Downloading the private browser AI model for its first use…");
    setError("");
    const headerText = next.headers.join(" ").toLowerCase();
    if (/\b(?:usd|dollar)\b/.test(headerText)) setCurrency("USD");
    else if (/\b(?:eur|euro)\b/.test(headerText)) setCurrency("EUR");
    else if (/\b(?:gbp|pound)\b/.test(headerText)) setCurrency("GBP");
    else if (/\b(?:inr|rupee)\b/.test(headerText) && !/lkr|sri lanka/.test(headerText)) setCurrency("INR");
    else setCurrency("LKR");
    mapColumnsWithLocalAI(next.profiles, (message) => { if (aiRequest.current === request) setAiMessage(message); })
      .then((choices) => {
        if (aiRequest.current !== request) return;
        setMappings(choices);
        setAiState("ready");
        setAiMessage("Local AI mapping complete. Review uncertain fields before continuing.");
      })
      .catch(() => {
        if (aiRequest.current !== request) return;
        setAiState("fallback");
        setAiMessage("The browser AI could not load on this device. Privacy-safe smart rules produced the mapping instead.");
      });
  }, []);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { setError("Choose a file smaller than 25 MB so it can be processed safely in the browser."); input.value = ""; return; }
    setLoading(true); setError(""); setUploadNotice("");
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
      setAvailableSheets(sheets);
      preparePreview(usable[0].sheet, file.name);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "The selected file could not be read.");
    } finally {
      setLoading(false);
      input.value = "";
    }
  };

  const updateMapping = (sourceIndex: number, target: CanonicalField | null) => {
    setMappings((current) => current.map((choice) => {
      if (choice.sourceIndex === sourceIndex) return { ...choice, target, confidence: target ? 1 : 0, method: "Manual", reason: target ? "Confirmed by the user." : "Ignored by the user." };
      if (target && choice.target === target) return { ...choice, target: null, confidence: 0, method: "Manual", reason: "Replaced by another selected column." };
      return choice;
    }));
  };

  const confirmImport = () => {
    if (!preview) return;
    try {
      const applied = applyMapping(preview, mappings);
      setRows(applied.rows);
      setImportReport(applied.report);
      setFileName(preview.fileName);
      setCategory("All categories");
      setPeriod("Full year");
      setSection("overview");
      setUploadNotice(`${preview.fileName} loaded — ${number.format(applied.report.acceptedRows)} valid rows and ${applied.report.mappedFields.length} mapped fields.`);
      setPreview(null);
      setAvailableSheets([]);
      setError("");
    } catch (mappingError) {
      setError(mappingError instanceof Error ? mappingError.message : "The selected mapping could not be applied.");
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
      setForecastServiceMessage("StatsForecast is ready in the codebase and will activate after the Render service URL is added to Vercel.");
      return;
    }
    const controller = new AbortController();
    setForecastServiceState("loading");
    setForecastServiceMessage("Testing StatsForecast models on unseen historical periods.");
    requestStatsForecast(dailyAll, forecastDays, controller.signal)
      .then((result) => {
        setStatsForecast(result);
        setForecastServiceState("ready");
        setForecastServiceMessage("StatsForecast and local candidates were compared; the lowest historical error was selected.");
      })
      .catch((forecastError) => {
        if (forecastError instanceof DOMException && forecastError.name === "AbortError") return;
        setForecastServiceState("fallback");
        setForecastServiceMessage(forecastError instanceof Error ? forecastError.message : "StatsForecast is temporarily unavailable; the validated local candidate is shown.");
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
  const paymentTotal = payments.reduce((a, b) => a + b[1], 0) || 1;
  const paymentColors = ["#13A6A0", "#17324D", "#F4B942", "#8D6CCF", "#EF7B68"];
  const donutStops = payments.reduce<{ cursor: number; stops: string[] }>((result, payment, index) => {
    const start = result.cursor;
    const end = start + payment[1] / paymentTotal * 100;
    return { cursor: end, stops: [...result.stops, `${paymentColors[index % paymentColors.length]} ${start}% ${end}%`] };
  }, { cursor: 0, stops: [] });
  const donut = `conic-gradient(${donutStops.stops.join(",")})`;

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

  const mappedTargets = new Set(mappings.flatMap((choice) => choice.target ? [choice.target] : []));
  const canImport = mappedTargets.has("date") && mappedTargets.has("netSales");
  const enabledAnalytics = [
    "Sales KPIs and trends",
    "Weekday patterns",
    "7-day, 30-day, 3-month and 6-month forecasts",
    mappedTargets.has("profit") || mappedTargets.has("cost") ? "Profit and margin" : "",
    mappedTargets.has("invoice") ? "Invoices and basket value" : "",
    mappedTargets.has("quantity") ? "Units and demand" : "",
    mappedTargets.has("category") ? "Category mix and outlook" : "",
    mappedTargets.has("product") ? "Product rankings" : "",
    mappedTargets.has("payment") ? "Payment mix" : "",
    mappedTargets.has("promotion") || mappedTargets.has("discount") ? "Promotion analysis" : "",
  ].filter(Boolean);

  if (preview) return (
    <main className="import-page">
      <header className="import-topbar">
        <div className="brand"><div className="brand-mark">RP</div><div><strong>RetailPulse</strong><span>AI DATA IMPORT</span></div></div>
        <button className="text-button" onClick={() => { setPreview(null); setAvailableSheets([]); setError(""); }}>Cancel import</button>
      </header>
      <section className="import-shell">
        <div className="import-heading">
          <div><p className="eyebrow">PRIVATE, LOCAL AI</p><h1>Confirm what your columns mean</h1><p>The file stays in this browser. A free open-source model interprets the headers, while value checks prevent unsafe mappings.</p></div>
          <div className={`ai-status ${aiState}`}><span>{aiState === "loading" ? "AI" : aiState === "ready" ? "✓" : "!"}</span><div><strong>{aiState === "loading" ? "Local AI is working" : aiState === "ready" ? "AI mapping ready" : "Smart fallback active"}</strong><small>{aiMessage || "Preparing the mapping model…"}</small></div></div>
        </div>
        {error && <div className="error-banner"><strong>Import issue</strong><span>{error}</span></div>}
        <section className="import-controls">
          <label>Worksheet<select value={preview.sheetName} onChange={(event) => {
            const sheet = availableSheets.find((candidate) => candidate.sheet === event.target.value);
            if (sheet) preparePreview(sheet, preview.fileName);
          }}>{availableSheets.map((sheet) => <option key={sheet.sheet}>{sheet.sheet}</option>)}</select></label>
          <label>Currency<select value={currency} onChange={(event) => setCurrency(event.target.value)}><option value="LKR">LKR — Sri Lankan rupee</option><option value="USD">USD — US dollar</option><option value="EUR">EUR — Euro</option><option value="GBP">GBP — British pound</option><option value="INR">INR — Indian rupee</option><option value="AUD">AUD — Australian dollar</option><option value="CAD">CAD — Canadian dollar</option></select></label>
          <div><span>Detected header</span><strong>Row {preview.headerRow + 1} · {number.format(preview.rows.length)} data rows</strong></div>
        </section>
        <div className="core-requirement"><strong>Only two fields are essential:</strong> Sale date and Net sales. Other fields automatically unlock additional analytics.</div>
        <section className="mapping-card">
          <div className="mapping-head"><span>Uploaded column</span><span>Detected samples</span><span>Use as</span><span>Status</span></div>
          {preview.profiles.map((profile) => {
            const choice = mappings.find((item) => item.sourceIndex === profile.index);
            const level = confidenceLabel(choice?.confidence || 0);
            const mappingStatus = !choice?.target ? "Not used" : level === "High" ? "Ready" : "Check";
            return <div className="mapping-row" key={profile.index}>
              <div><strong>{profile.header}</strong><small>{profile.kind} · {number.format(profile.nonBlank)} values</small></div>
              <span className="sample-values">{profile.samples.slice(0, 2).join(" · ") || "Empty"}</span>
              <select disabled={aiState === "loading"} value={choice?.target || ""} onChange={(event) => updateMapping(profile.index, (event.target.value || null) as CanonicalField | null)}>
                <option value="">Ignore this column</option>
                {CANONICAL_FIELDS.map((field) => <option value={field} key={field}>{FIELD_DEFINITIONS[field].label}</option>)}
              </select>
              <div className={`mapping-confidence ${!choice?.target ? "unmapped" : level === "High" ? "ready" : "check"}`}><strong>{mappingStatus}</strong><small>{choice?.target ? choice.method : "Ignored automatically"}</small></div>
            </div>;
          })}
        </section>
        <section className="analytics-preview">
          <div><p className="eyebrow">DYNAMIC DASHBOARD</p><h2>{enabledAnalytics.length} analytics capabilities will be enabled</h2><p>Features without supporting columns will be hidden rather than calculated from invented values.</p></div>
          <div>{enabledAnalytics.map((item) => <span key={item}>✓ {item}</span>)}</div>
        </section>
        <div className="import-actions">
          <button className="text-button" onClick={() => { setPreview(null); setAvailableSheets([]); setError(""); }}>Cancel</button>
          <button className="auth-submit import-confirm" disabled={!canImport || aiState === "loading"} onClick={confirmImport}>{aiState === "loading" ? "Waiting for local AI…" : canImport ? "Generate compatible dashboard" : "Map date and sales to continue"}</button>
        </div>
      </section>
    </main>
  );

  if (loading) return <main className="loading"><div className="loading-mark">RP</div><h1>Reading your sales file</h1><p>Finding worksheets, headers and usable sales columns…</p><div className="loader"><span /></div></main>;

  if (!rows.length) return (
    <main className="app-shell empty-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">RP</div><div><strong>RetailPulse</strong><span>AI Sales Intelligence</span></div></div>
        <nav aria-label="Dashboard sections">
          <button className="active"><Icon>⌂</Icon>Get started</button>
          <button disabled><Icon>↗</Icon>Predictive analysis</button>
          <button disabled><Icon>▦</Icon>Products & categories</button>
          <button disabled><Icon>◎</Icon>Methodology</button>
        </nav>
        <div className="sidebar-note"><span>Private workspace</span><p>Your uploaded file is processed locally in this browser.</p></div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">SME PERFORMANCE CENTRE</p><h1>Start your sales analysis</h1></div>
          <AccountMenu />
        </header>
        {error && <div className="error-banner"><strong>File issue</strong><span>{error}</span></div>}
        <section className="empty-upload">
          <div className="empty-upload-mark" aria-hidden="true">⇧</div>
          <p className="eyebrow">YOUR DATA, YOUR WORKSPACE</p>
          <h2>Upload almost any sales spreadsheet</h2>
          <p>RetailPulse uses free local AI to understand your columns, confirms uncertain mappings, and builds only the analytics your data can support.</p>
          <label className="upload-button upload-primary">Choose sales file<input aria-label="Upload sales data file" type="file" accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={upload} /></label>
          <div className="upload-requirements">
            <div><strong>Accepted formats</strong><span>CSV, TSV and Excel XLSX · multiple worksheets supported</span></div>
            <div><strong>Minimum information</strong><span>A date column and a sales or revenue amount</span></div>
            <div><strong>Private local AI</strong><span>Mapping runs in your browser; sales rows are not sent to an AI provider</span></div>
          </div>
        </section>
        <footer><span>RetailPulse AI · CIS 6000 Research Prototype</span><span>Predictions support decisions; they do not replace managerial judgement.</span></footer>
      </section>
    </main>
  );

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">RP</div><div><strong>RetailPulse</strong><span>AI Sales Intelligence</span></div></div>
        <nav aria-label="Dashboard sections">
          <button className={section === "overview" ? "active" : ""} onClick={() => setSection("overview")}><Icon>⌂</Icon>Overview</button>
          <button className={section === "forecast" ? "active" : ""} onClick={() => setSection("forecast")}><Icon>↗</Icon>Predictive analysis</button>
          <button disabled={!capabilities.product && !capabilities.category} className={section === "products" ? "active" : ""} onClick={() => setSection("products")}><Icon>▦</Icon>Products & categories</button>
          <button className={section === "methodology" ? "active" : ""} onClick={() => setSection("methodology")}><Icon>◎</Icon>Methodology</button>
        </nav>
        <div className="sidebar-note"><span>Academic prototype</span><p>AI-supported decision-making for Sri Lankan SMEs.</p></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">SME PERFORMANCE CENTRE</p><h1>{section === "overview" ? "Sales overview" : section === "forecast" ? "Predictive analysis" : section === "products" ? "Product intelligence" : "Model methodology"}</h1></div>
          <div className="top-actions">
            <div className="data-status"><span className="status-dot" /><div><strong>{fileName}</strong><small>{number.format(rows.length)} validated lines</small></div></div>
            <label className="upload-button">Upload new file<input aria-label="Upload sales data file" type="file" accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={upload} /></label>
            <AccountMenu />
          </div>
        </header>

        {error && <div className="error-banner"><strong>File issue</strong><span>{error}</span></div>}
        {uploadNotice && <div className="upload-success" role="status" data-testid="upload-status"><span className="success-check">✓</span><div><strong>Upload complete</strong><span>{uploadNotice}</span></div><button aria-label="Dismiss upload message" onClick={() => setUploadNotice("")}>×</button></div>}

        {section !== "methodology" && <div className="filterbar">
          {capabilities.category && <label>Category<select value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((c) => <option key={c}>{c}</option>)}</select></label>}
          <label>Historical period<select value={period} onChange={(e) => setPeriod(e.target.value)}><option>Full year</option><option>Last 90 days</option><option>Last 30 days</option></select></label>
          <div className="filter-meta"><span>Data period</span><strong>{dailyAll[0]?.date} — {dailyAll.at(-1)?.date}</strong></div>
        </div>}

        {section === "overview" && <>
          <section className="kpi-grid">
            <article className="kpi primary"><span>Net sales</span><strong>{money.format(metrics.net)}</strong><small>{capabilities.invoices ? `${number.format(metrics.invoices)} completed invoices` : `${number.format(filtered.length)} accepted sales rows`}</small></article>
            {capabilities.profit && <article className="kpi"><span>Gross profit</span><strong>{money.format(metrics.profit)}</strong><small className="positive">{pct(metrics.margin)} gross margin</small></article>}
            {capabilities.quantity && <article className="kpi"><span>Units sold</span><strong>{number.format(metrics.units)}</strong><small>{capabilities.invoices ? `${(metrics.units / Math.max(1, metrics.invoices)).toFixed(1)} units per basket` : "From the mapped quantity column"}</small></article>}
            {capabilities.invoices && <article className="kpi"><span>Average basket</span><strong>{money.format(metrics.basket)}</strong><small>Across selected invoices</small></article>}
          </section>
          {importReport && <section className="import-summary" aria-label="Import quality summary">
            <div><span>AI-mapped fields</span><strong>{importReport.mappedFields.length}</strong></div>
            <div><span>Accepted rows</span><strong>{number.format(importReport.acceptedRows)}</strong></div>
            <div><span>Rejected rows</span><strong>{number.format(importReport.rejectedRows)}</strong></div>
            <div><span>Possible duplicates</span><strong>{number.format(importReport.exactDuplicateRows)}</strong></div>
            <p>{importReport.rejectedRows || importReport.exactDuplicateRows ? "Review rejected or duplicate source rows before using this dashboard for financial reporting." : "The mapped date and sales fields passed the import checks."}</p>
          </section>}

          <section className="dashboard-grid">
            <article className="panel span-2"><div className="panel-head"><div><p>PERFORMANCE TREND</p><h2>Daily net sales</h2></div><span className="legend"><i />Actual sales</span></div><LineChart historical={dailyFiltered} forecast={[]} mode="history" /></article>
            {capabilities.category && <article className="panel"><div className="panel-head"><div><p>SALES MIX</p><h2>Revenue by category</h2></div></div><div className="bar-list">{categorySales.slice(0, 7).map(([name, value]) => <div className="bar-row" key={name}><div><span>{name}</span><strong>{compact.format(value)}</strong></div><div className="bar-track"><i style={{ width: `${value / maxCategory * 100}%` }} /></div></div>)}</div></article>}
            {capabilities.payment && <article className="panel"><div className="panel-head"><div><p>CUSTOMER BEHAVIOUR</p><h2>Payment mix</h2></div></div><div className="donut-wrap"><div className="donut" style={{ background: donut }}><span><strong>{payments.length}</strong>methods</span></div><div className="donut-legend">{payments.map(([name, value], i) => <div key={name}><i style={{ background: paymentColors[i % paymentColors.length] }} /><span>{name}</span><strong>{pct(value / paymentTotal)}</strong></div>)}</div></div></article>}
            <article className="panel"><div className="panel-head"><div><p>TRADING PATTERN</p><h2>Average sales by weekday</h2></div></div><div className="weekday-chart">{weekday.map((d) => <div key={d.name}><span>{compact.format(d.value)}</span><i style={{ height: `${Math.max(7, d.value / maxWeekday * 100)}%` }} /><small>{d.name}</small></div>)}</div></article>
            <article className="panel span-2 insight-panel"><div className="insight-mark">AI</div><div><p>MANAGEMENT BRIEF</p><h2>{topCategory ? `${topCategory[0]} leads the selected sales mix` : "Sales data is ready"}</h2><p>{topCategory ? `${topCategory[0]} contributes ${pct(topCategory[1] / Math.max(1, metrics.net))} of net sales. ${promotions.length ? `${promotions[0][0]} generated the largest promotional discount value.` : "No promotion is selected in this view."} Open Predictive Analysis for the next-period outlook.` : "Core sales trends are available. Additional panels appear only when matching columns are present."}</p></div><button onClick={() => setSection("forecast")}>View forecast →</button></article>
          </section>
        </>}

        {section === "forecast" && !forecast && <section className="panel forecast-unavailable"><p className="eyebrow">INSUFFICIENT HISTORY</p><h2>More daily sales history is needed</h2><p>The {forecastDays}-day forecast requires at least {minimumHistoryDays(forecastDays)} calendar days so models can be tested on unseen periods. This file currently provides {dailyAll.length} days.</p></section>}

        {section === "forecast" && forecast && <>
          <section className="forecast-hero">
            <div><p className="eyebrow">ROLLING-BACKTESTED FORECAST</p><h2>{forecastDays}-day sales outlook</h2><div className="forecast-value"><strong>{money.format(futureTotal)}</strong><span className={forecastChange >= 0 ? "positive-pill" : "negative-pill"}>{forecastChange >= 0 ? "+" : ""}{pct(forecastChange)} vs previous {forecastDays} days</span></div><p>{forecast.winner.name} was selected from {forecast.models.length} local and StatsForecast candidates across {forecast.folds} unseen historical periods. Daily ranges reflect historical errors.</p></div>
            <div className="horizon-toggle" aria-label="Forecast horizon"><button className={forecastDays === 7 ? "active" : ""} onClick={() => setForecastDays(7)}>7 days</button><button className={forecastDays === 30 ? "active" : ""} onClick={() => setForecastDays(30)}>30 days</button><button className={forecastDays === 90 ? "active" : ""} onClick={() => setForecastDays(90)}>3 months</button><button className={forecastDays === 180 ? "active" : ""} onClick={() => setForecastDays(180)}>6 months</button></div>
          </section>
          <div className={`service-status ${forecastServiceState}`} role="status"><strong>{forecastServiceState === "loading" ? "Testing models" : forecastServiceState === "ready" ? "Hybrid engine ready" : forecastServiceState === "setup" ? "Render setup required" : forecastServiceState === "fallback" ? "Local model active" : "Forecast ready"}</strong><span>{forecastServiceMessage || "The best backtested candidate is shown."}</span></div>
          <div className={`forecast-confidence ${forecast.confidence.toLowerCase().replace(" ", "-")}`} role="status"><strong>{cautiousForecast ? "Planning estimate" : "Decision-support forecast"}</strong><span>Expected historical error is approximately {pct(forecast.winner.wape)}. {cautiousForecast ? "Use the displayed range and current business information before acting." : "The result is suitable for planning when combined with current business information."}</span></div>
          <section className="dashboard-grid forecast-grid">
            <article className="panel span-2"><div className="panel-head"><div><p>FORWARD VIEW</p><h2>Actual and predicted sales</h2></div><div className="two-legends"><span className="legend"><i />Actual</span><span className="legend forecast"><i />Forecast + 80% historical-error range</span></div></div><LineChart historical={dailyAll} forecast={forecast.points} mode="forecast" /></article>
            <article className="panel accuracy-card"><div className="panel-head"><div><p>ROLLING BACKTEST</p><h2>Historical forecast error</h2></div></div><div className="accuracy-score"><strong>{pct(forecast.winner.wape)}</strong><span>Expected error · lower is better</span></div><dl><div><dt>Engine</dt><dd>{forecast.engine || "Local models"}</dd></div><div><dt>Selected model</dt><dd>{forecast.winner.name}</dd></div><div><dt>Typical daily error</dt><dd>±{money.format(forecast.winner.mae)}</dd></div><div><dt>Forecast bias</dt><dd>{pct(Math.abs(forecast.winner.bias))} {forecast.winner.bias >= 0 ? "under" : "over"}</dd></div><div><dt>Validation coverage</dt><dd>{forecast.folds} tests · {forecast.evaluatedDays} days</dd></div></dl></article>
            <article className="panel"><div className="panel-head"><div><p>MODEL COMPARISON</p><h2>Rolling historical error</h2></div></div><div className="model-compare">{comparedModels.map((model) => <div className={model.name === forecast.winner.name ? "winner" : ""} key={model.name}><span>{model.name}</span><strong>{pct(model.wape)} WAPE</strong><i><b style={{ width: `${model.wape / maxComparedWape * 100}%` }} /></i></div>)}</div><small className="fine-print">Longer bars mean more error. The selected model has the lowest combined WAPE across unseen periods and improves on the weekly baseline by {pct(forecast.relativeImprovement)}.</small></article>
            {capabilities.category && <article className="panel span-2"><div className="panel-head"><div><p>CATEGORY OUTLOOK</p><h2>Expected demand over the next {forecastDays} days</h2></div></div><div className="forecast-table"><div className="table-head"><span>Category</span><span>Forecast sales</span><span>Expected units</span><span>Momentum</span></div>{categoryForecasts.map((c) => <div className="table-row" key={c.name}><strong>{c.name}</strong><span>{money.format(c.sales)}</span><span>{capabilities.quantity ? number.format(c.units) : "Not available"}</span><span className={c.change >= 0 ? "positive" : "negative"}>{c.change >= 0 ? "+" : ""}{pct(c.change)}</span></div>)}</div></article>}
            <article className="panel executive-card"><div className="executive-label"><span>AI</span>DEEPSEEK ANALYST</div>{deepSeekInsight ? <><h2>{deepSeekInsight.headline}</h2><p>{deepSeekInsight.summary}</p><div className="ai-recommendations"><strong>Recommended actions</strong><ul>{deepSeekInsight.actions.map((action) => <li key={action}>{action}</li>)}</ul></div>{deepSeekInsight.risks.length > 0 && <div className="summary-action"><strong>Risks to check</strong><span>{deepSeekInsight.risks.join(" ")}</span></div>}</> : <><h2>Verified forecast ready for explanation</h2><p>The selected {forecast.winner.name.toLowerCase()} estimates {money.format(futureTotal)} over the next {forecastDays} days, with expected historical error of {pct(forecast.winner.wape)}.</p><p>{topGrowth ? `${topGrowth.name} has the strongest recent category momentum at ${topGrowth.change >= 0 ? "+" : ""}${pct(topGrowth.change)}.` : "Category momentum will appear when matching data is available."}</p><button className="deepseek-button" disabled={deepSeekState === "loading"} onClick={generateDeepSeekInsight}>{deepSeekState === "loading" ? "DeepSeek is analysing…" : "Generate AI analysis"}</button>{deepSeekMessage && <small className="deepseek-message">{deepSeekMessage}</small>}</>}</article>
            <article className="panel span-3 data-readiness"><div className="panel-head"><div><p>DATA READINESS</p><h2>What the model had available</h2></div></div><div><span><strong>{dataProfile.historyDays}</strong>calendar days</span><span><strong>{dataProfile.zeroDays}</strong>zero or missing-date days</span><span><strong>{dataProfile.unusualDays}</strong>IQR-flagged high-sales days</span><span><strong>{pct(forecast.intervalCoverage)}</strong>historical range coverage</span></div></article>
          </section>
        </>}

        {section === "products" && <section className="dashboard-grid products-grid">
          {capabilities.product && <article className="panel span-2"><div className="panel-head"><div><p>PRODUCT RANKING</p><h2>Top products by net sales</h2></div></div><div className="product-ranking">{productSales.map(([name, value], i) => <div key={name}><span className="rank">{String(i + 1).padStart(2, "0")}</span><div><strong>{name}</strong><i><b style={{ width: `${value / maxProduct * 100}%` }} /></i></div><span>{money.format(value)}</span></div>)}</div></article>}
          {capabilities.category && <article className="panel"><div className="panel-head"><div><p>CATEGORY CONTRIBUTION</p><h2>Portfolio concentration</h2></div></div><div className="category-cards">{categorySales.slice(0, 5).map(([name, value], i) => <div key={name}><span>{i + 1}</span><div><strong>{name}</strong><small>{pct(value / Math.max(1, metrics.net))} of sales</small></div><b>{compact.format(value)}</b></div>)}</div></article>}
          <article className="panel span-3"><div className="panel-head"><div><p>DECISION SUPPORT</p><h2>How to use the available product data</h2></div></div><div className="decision-steps"><div><span>01</span><strong>Prioritise</strong><p>Focus forecasting on top-selling SKUs where stock-outs have the greatest revenue impact.</p></div><div><span>02</span><strong>Plan</strong><p>{capabilities.quantity ? "Combine expected unit demand with supplier lead time and a manager-defined safety-stock level." : "Add a quantity column in a future file to unlock unit-demand planning."}</p></div><div><span>03</span><strong>Review</strong><p>Track actual versus predicted demand weekly and investigate large exceptions before reordering.</p></div></div></article>
        </section>}

        {section === "methodology" && <section className="methodology">
          <div className="method-intro"><p className="eyebrow">TRANSPARENT PREDICTIVE ANALYTICS</p><h2>Forecasts that can be explained and evaluated</h2><p>RetailPulse first interprets unfamiliar spreadsheets, then enables only evidence-supported analytics. Forecasts remain calculated and backtested rather than generated by a language model.</p></div>
          <div className="method-flow"><article><span>1</span><div><h3>Interpret locally</h3><p>Read CSV, TSV or XLSX sheets, find the header row, and use the browser model to understand unfamiliar columns.</p></div></article><article><span>2</span><div><h3>Validate the data</h3><p>Require date and sales, reject invalid core rows, and never invent missing financial fields.</p></div></article><article><span>3</span><div><h3>Test forecast engines</h3><p>Compare local candidates with StatsForecast AutoETS, AutoARIMA and Theta models on chronological unseen periods.</p></div></article><article><span>4</span><div><h3>Select by evidence</h3><p>Choose the lowest-error candidate separately for 7-day, 30-day, 3-month and 6-month horizons.</p></div></article><article><span>5</span><div><h3>Explain with DeepSeek</h3><p>Send only verified summary metrics to DeepSeek for plain-language findings and actions; raw spreadsheet rows are not sent.</p></div></article></div>
          <div className="method-cards"><article><p>PRIMARY METRIC</p><strong>WAPE</strong><span>Total absolute forecast error divided by actual sales. Lower is better; it is not converted into an “accuracy” claim.</span></article><article><p>CONTROL MODEL</p><strong>Seasonal naive</strong><span>A candidate must demonstrate value against simply repeating the most recent week.</span></article><article><p>VALIDATION DESIGN</p><strong>Up to 8 folds</strong><span>Each horizon is evaluated separately across chronological historical periods before a model is selected.</span></article></div>
          <div className="disclosure"><strong>Data-use disclosure</strong><p>Raw spreadsheet rows are processed in the browser and are not retained. Daily date-and-sales totals are sent to the Render forecasting service. DeepSeek receives only compact verified metrics when the user requests an AI analysis.</p></div>
        </section>}
        <footer><span>RetailPulse AI · CIS 6000 Research Prototype</span><span>Predictions support decisions; they do not replace managerial judgement.</span></footer>
      </section>
    </main>
  );
}
