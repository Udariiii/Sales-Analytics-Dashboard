"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountMenu } from "@/components/account-menu";
import { addDays, buildForecast, DailyPoint, ForecastPoint, minimumHistoryDays } from "@/lib/forecast";

type SalesRow = {
  date: string;
  invoice: string;
  category: string;
  product: string;
  sku: string;
  quantity: number;
  gross: number;
  discount: number;
  net: number;
  profit: number;
  payment: string;
  promotion: string;
};

const money = new Intl.NumberFormat("en-LK", { style: "currency", currency: "LKR", maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const number = new Intl.NumberFormat("en-LK", { maximumFractionDigits: 0 });

function parseCsv(text: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(cell); cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(Boolean)) result.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); result.push(row); }
  return result;
}

function detectSlashDateOrder(values: string[]): "dmy" | "mdy" {
  for (const value of values) {
    const parts = value.trim().split(/[/-]/).map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) continue;
    if (parts[0] > 12) return "dmy";
    if (parts[1] > 12) return "mdy";
  }
  return "dmy";
}

function normalizeDate(value: string, slashOrder: "dmy" | "mdy"): string {
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parts = raw.split(/[/-]/).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return "";
  let year: number, month: number, day: number;
  if (String(parts[0]).length === 4) [year, month, day] = parts;
  else {
    year = parts[2];
    if (slashOrder === "dmy") { day = parts[0]; month = parts[1]; }
    else { month = parts[0]; day = parts[1]; }
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return date.toISOString().slice(0, 10);
}

function toRows(text: string): SalesRow[] {
  const parsed = parseCsv(text);
  if (parsed.length < 2) throw new Error("The CSV does not contain sales records.");
  const index = Object.fromEntries(parsed[0].map((h, i) => [h.trim(), i]));
  const required = ["Sale_Date", "Invoice_ID", "Category", "Product_Name", "Quantity", "Net_Sales_LKR", "Gross_Profit_LKR"];
  const missing = required.filter((key) => index[key] === undefined);
  if (missing.length) throw new Error(`Missing required columns: ${missing.join(", ")}`);
  const slashDateOrder = detectSlashDateOrder(parsed.slice(1, 1000).map((r) => r[index.Sale_Date] || ""));
  const n = (r: string[], key: string) => Number(r[index[key]] || 0);
  const s = (r: string[], key: string) => r[index[key]]?.trim() || "Unknown";
  const rows = parsed.slice(1).map((r) => ({
    date: normalizeDate(s(r, "Sale_Date"), slashDateOrder), invoice: s(r, "Invoice_ID"), category: s(r, "Category"),
    product: s(r, "Product_Name"), sku: s(r, "SKU"), quantity: n(r, "Quantity"),
    gross: n(r, "Gross_Sales_LKR"), discount: n(r, "Discount_Amount_LKR"),
    net: n(r, "Net_Sales_LKR"), profit: n(r, "Gross_Profit_LKR"),
    payment: s(r, "Payment_Method"), promotion: s(r, "Promotion"),
  })).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.net));
  if (!rows.length) throw new Error("No valid sales rows were found. Check the Sale_Date and numeric columns.");
  return rows;
}

function aggregateDaily(rows: SalesRow[]): DailyPoint[] {
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

function sumBy(rows: SalesRow[], key: keyof SalesRow, value: keyof SalesRow) {
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

export default function Home() {
  const [rows, setRows] = useState<SalesRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [uploadNotice, setUploadNotice] = useState("");
  const [section, setSection] = useState<"overview" | "forecast" | "products" | "methodology">("overview");
  const [category, setCategory] = useState("All categories");
  const [period, setPeriod] = useState("Full year");
  const [forecastDays, setForecastDays] = useState(30);

  const loadText = useCallback((text: string, name: string, announce = false) => {
    setLoading(true); setError("");
    if (announce) setUploadNotice("");
    window.setTimeout(() => {
      try {
        const parsed = toRows(text);
        setRows(parsed);
        setFileName(name);
        if (announce) {
          setCategory("All categories");
          setPeriod("Full year");
          setSection("overview");
          setUploadNotice(`${name} loaded successfully — ${number.format(parsed.length)} sales lines are now displayed.`);
        }
      }
      catch (e) { setError(e instanceof Error ? e.message : "Unable to read the CSV file."); }
      finally { setLoading(false); }
    }, 20);
  }, []);

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0]; if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) { setError("Please select a CSV file."); return; }
    file.text()
      .then((text) => loadText(text, file.name, true))
      .catch(() => setError("The selected CSV file could not be read."))
      .finally(() => { input.value = ""; });
  };

  const categories = useMemo(() => ["All categories", ...new Set(rows.map((r) => r.category))], [rows]);
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
  const forecast = useMemo(() => buildForecast(dailyAll, forecastDays), [dailyAll, forecastDays]);
  const categorySales = useMemo(() => sumBy(filtered, "category", "net"), [filtered]);
  const productSales = useMemo(() => sumBy(filtered, "product", "net").slice(0, 10), [filtered]);
  const payments = useMemo(() => sumBy(filtered, "payment", "net"), [filtered]);
  const promotions = useMemo(() => sumBy(filtered.filter((r) => r.promotion !== "None"), "promotion", "discount"), [filtered]);

  const metrics = useMemo(() => {
    const net = filtered.reduce((a, r) => a + r.net, 0), profit = filtered.reduce((a, r) => a + r.profit, 0);
    const units = filtered.reduce((a, r) => a + r.quantity, 0), invoices = new Set(filtered.map((r) => r.invoice)).size;
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
    if (!forecast || !rows.length) return [];
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
  }, [forecast, rows, dailyAll, categories, futureTotal]);

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

  if (loading) return <main className="loading"><div className="loading-mark">RP</div><h1>Preparing your sales intelligence</h1><p>Validating your transactions and calculating the forecast...</p><div className="loader"><span /></div></main>;

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
        {error && <div className="error-banner"><strong>CSV issue</strong><span>{error}</span></div>}
        <section className="empty-upload">
          <div className="empty-upload-mark" aria-hidden="true">⇧</div>
          <p className="eyebrow">YOUR DATA, YOUR WORKSPACE</p>
          <h2>Upload a sales CSV to begin</h2>
          <p>RetailPulse does not include or preload transaction data. Select your own file and the dashboard will validate and analyse it in your browser.</p>
          <label className="upload-button upload-primary">Choose CSV file<input aria-label="Upload sales CSV" type="file" accept=".csv,text/csv" onChange={upload} /></label>
          <div className="upload-requirements">
            <div><strong>Accepted format</strong><span>CSV with a header row</span></div>
            <div><strong>Required fields</strong><span>Date, Invoice ID, Category, Product, Quantity, Net Sales and Profit</span></div>
            <div><strong>Privacy</strong><span>The file is not uploaded to a server or retained after you close the tab</span></div>
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
          <button className={section === "products" ? "active" : ""} onClick={() => setSection("products")}><Icon>▦</Icon>Products & categories</button>
          <button className={section === "methodology" ? "active" : ""} onClick={() => setSection("methodology")}><Icon>◎</Icon>Methodology</button>
        </nav>
        <div className="sidebar-note"><span>Academic prototype</span><p>AI-supported decision-making for Sri Lankan SMEs.</p></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">SME PERFORMANCE CENTRE</p><h1>{section === "overview" ? "Sales overview" : section === "forecast" ? "Predictive analysis" : section === "products" ? "Product intelligence" : "Model methodology"}</h1></div>
          <div className="top-actions">
            <div className="data-status"><span className="status-dot" /><div><strong>{fileName}</strong><small>{number.format(rows.length)} validated lines</small></div></div>
            <label className="upload-button">Upload CSV<input aria-label="Upload sales CSV" type="file" accept=".csv,text/csv" onChange={upload} /></label>
            <AccountMenu />
          </div>
        </header>

        {error && <div className="error-banner"><strong>CSV issue</strong><span>{error}</span></div>}
        {uploadNotice && <div className="upload-success" role="status" data-testid="upload-status"><span className="success-check">✓</span><div><strong>Upload complete</strong><span>{uploadNotice}</span></div><button aria-label="Dismiss upload message" onClick={() => setUploadNotice("")}>×</button></div>}

        {section !== "methodology" && <div className="filterbar">
          <label>Category<select value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label>Historical period<select value={period} onChange={(e) => setPeriod(e.target.value)}><option>Full year</option><option>Last 90 days</option><option>Last 30 days</option></select></label>
          <div className="filter-meta"><span>Data period</span><strong>{dailyAll[0]?.date} — {dailyAll.at(-1)?.date}</strong></div>
        </div>}

        {section === "overview" && <>
          <section className="kpi-grid">
            <article className="kpi primary"><span>Net sales</span><strong>{money.format(metrics.net)}</strong><small>{number.format(metrics.invoices)} completed invoices</small></article>
            <article className="kpi"><span>Gross profit</span><strong>{money.format(metrics.profit)}</strong><small className="positive">{pct(metrics.margin)} gross margin</small></article>
            <article className="kpi"><span>Units sold</span><strong>{number.format(metrics.units)}</strong><small>{(metrics.units / Math.max(1, metrics.invoices)).toFixed(1)} units per basket</small></article>
            <article className="kpi"><span>Average basket</span><strong>{money.format(metrics.basket)}</strong><small>Across selected transactions</small></article>
          </section>

          <section className="dashboard-grid">
            <article className="panel span-2"><div className="panel-head"><div><p>PERFORMANCE TREND</p><h2>Daily net sales</h2></div><span className="legend"><i />Actual sales</span></div><LineChart historical={dailyFiltered} forecast={[]} mode="history" /></article>
            <article className="panel"><div className="panel-head"><div><p>SALES MIX</p><h2>Revenue by category</h2></div></div><div className="bar-list">{categorySales.slice(0, 7).map(([name, value]) => <div className="bar-row" key={name}><div><span>{name}</span><strong>{compact.format(value)}</strong></div><div className="bar-track"><i style={{ width: `${value / maxCategory * 100}%` }} /></div></div>)}</div></article>
            <article className="panel"><div className="panel-head"><div><p>CUSTOMER BEHAVIOUR</p><h2>Payment mix</h2></div></div><div className="donut-wrap"><div className="donut" style={{ background: donut }}><span><strong>{payments.length}</strong>methods</span></div><div className="donut-legend">{payments.map(([name, value], i) => <div key={name}><i style={{ background: paymentColors[i % paymentColors.length] }} /><span>{name}</span><strong>{pct(value / paymentTotal)}</strong></div>)}</div></div></article>
            <article className="panel"><div className="panel-head"><div><p>TRADING PATTERN</p><h2>Average sales by weekday</h2></div></div><div className="weekday-chart">{weekday.map((d) => <div key={d.name}><span>{compact.format(d.value)}</span><i style={{ height: `${Math.max(7, d.value / maxWeekday * 100)}%` }} /><small>{d.name}</small></div>)}</div></article>
            <article className="panel span-2 insight-panel"><div className="insight-mark">AI</div><div><p>MANAGEMENT BRIEF</p><h2>{topCategory ? `${topCategory[0]} leads the selected sales mix` : "Sales data is ready"}</h2><p>{topCategory ? `${topCategory[0]} contributes ${pct(topCategory[1] / Math.max(1, metrics.net))} of net sales. ${promotions.length ? `${promotions[0][0]} generated the largest promotional discount value.` : "No promotion is selected in this view."} Open Predictive Analysis for the next-period outlook.` : "Upload a compatible CSV to begin."}</p></div><button onClick={() => setSection("forecast")}>View forecast →</button></article>
          </section>
        </>}

        {section === "forecast" && !forecast && <section className="panel forecast-unavailable"><p className="eyebrow">INSUFFICIENT HISTORY</p><h2>More daily sales history is needed</h2><p>The {forecastDays}-day forecast requires at least {minimumHistoryDays(forecastDays)} calendar days so models can be tested on unseen periods. This file currently provides {dailyAll.length} days.</p></section>}

        {section === "forecast" && forecast && <>
          <section className="forecast-hero">
            <div><p className="eyebrow">ROLLING-BACKTESTED FORECAST</p><h2>{forecastDays}-day sales outlook</h2><div className="forecast-value"><strong>{money.format(futureTotal)}</strong><span className={forecastChange >= 0 ? "positive-pill" : "negative-pill"}>{forecastChange >= 0 ? "+" : ""}{pct(forecastChange)} vs previous {forecastDays} days</span></div><p>{forecast.winner.name} was selected from five candidates across {forecast.folds} unseen historical periods. Daily ranges reflect the model&apos;s historical absolute errors.</p></div>
            <div className="horizon-toggle" aria-label="Forecast horizon"><button className={forecastDays === 7 ? "active" : ""} onClick={() => setForecastDays(7)}>7 days</button><button className={forecastDays === 30 ? "active" : ""} onClick={() => setForecastDays(30)}>30 days</button></div>
          </section>
          <div className={`forecast-confidence ${forecast.confidence.toLowerCase().replace(" ", "-")}`} role="status"><strong>{forecast.confidence} confidence</strong><span>Rolling historical error is {pct(forecast.winner.wape)}. {cautiousForecast ? "Use this as a planning range, not an automatic purchasing instruction." : "The forecast is useful for planning when combined with current business information."}</span></div>
          <section className="dashboard-grid forecast-grid">
            <article className="panel span-2"><div className="panel-head"><div><p>FORWARD VIEW</p><h2>Actual and predicted sales</h2></div><div className="two-legends"><span className="legend"><i />Actual</span><span className="legend forecast"><i />Forecast + 80% historical-error range</span></div></div><LineChart historical={dailyAll} forecast={forecast.points} mode="forecast" /></article>
            <article className="panel accuracy-card"><div className="panel-head"><div><p>ROLLING BACKTEST</p><h2>Historical forecast error</h2></div></div><div className="accuracy-score"><strong>{pct(forecast.winner.wape)}</strong><span>WAPE · lower is better</span></div><dl><div><dt>Confidence</dt><dd>{forecast.confidence}</dd></div><div><dt>Selected model</dt><dd>{forecast.winner.name}</dd></div><div><dt>Typical daily error</dt><dd>±{money.format(forecast.winner.mae)}</dd></div><div><dt>Forecast bias</dt><dd>{pct(Math.abs(forecast.winner.bias))} {forecast.winner.bias >= 0 ? "under" : "over"}</dd></div><div><dt>Validation coverage</dt><dd>{forecast.folds} tests · {forecast.evaluatedDays} days</dd></div></dl></article>
            <article className="panel"><div className="panel-head"><div><p>MODEL COMPARISON</p><h2>Rolling historical error</h2></div></div><div className="model-compare">{comparedModels.map((model) => <div className={model.name === forecast.winner.name ? "winner" : ""} key={model.name}><span>{model.name}</span><strong>{pct(model.wape)} WAPE</strong><i><b style={{ width: `${model.wape / maxComparedWape * 100}%` }} /></i></div>)}</div><small className="fine-print">Longer bars mean more error. The selected model has the lowest combined WAPE across unseen periods and improves on the weekly baseline by {pct(forecast.relativeImprovement)}.</small></article>
            <article className="panel span-2"><div className="panel-head"><div><p>CATEGORY OUTLOOK</p><h2>Expected demand over the next {forecastDays} days</h2></div></div><div className="forecast-table"><div className="table-head"><span>Category</span><span>Forecast sales</span><span>Expected units</span><span>Momentum</span></div>{categoryForecasts.map((c) => <div className="table-row" key={c.name}><strong>{c.name}</strong><span>{money.format(c.sales)}</span><span>{number.format(c.units)}</span><span className={c.change >= 0 ? "positive" : "negative"}>{c.change >= 0 ? "+" : ""}{pct(c.change)}</span></div>)}</div></article>
            <article className="panel executive-card"><div className="executive-label"><span>AI</span>DECISION BRIEF</div><h2>{cautiousForecast ? "Low-confidence outlook — use a planning range" : forecastChange >= 0 ? "Sales momentum may strengthen" : "A softer trading period may follow"}</h2><p>The selected {forecast.winner.name.toLowerCase()} estimates {money.format(futureTotal)} over the next {forecastDays} days, a {Math.abs(forecastChange * 100).toFixed(1)}% {forecastChange >= 0 ? "increase" : "decrease"} from the previous comparable period. Historical rolling error is {pct(forecast.winner.wape)}.</p><p>{topGrowth ? `${topGrowth.name} has the strongest recent category momentum at ${topGrowth.change >= 0 ? "+" : ""}${pct(topGrowth.change)}. This category allocation is reconciled to the total forecast.` : "Category momentum will appear when sufficient records are available."}</p><div className="summary-action"><strong>{cautiousForecast ? "Required manager check" : "Recommended action"}</strong><span>{cautiousForecast ? "Do not change purchase quantities from the point estimate alone. Compare the chart range with current stock, promotions and supplier lead times." : "Review high-demand stock, confirm supplier lead times, and monitor forecast error weekly."}</span></div></article>
            <article className="panel span-3 data-readiness"><div className="panel-head"><div><p>DATA READINESS</p><h2>What the model had available</h2></div></div><div><span><strong>{dataProfile.historyDays}</strong>calendar days</span><span><strong>{dataProfile.zeroDays}</strong>zero or missing-date days</span><span><strong>{dataProfile.unusualDays}</strong>IQR-flagged high-sales days</span><span><strong>{pct(forecast.intervalCoverage)}</strong>historical range coverage</span></div></article>
          </section>
        </>}

        {section === "products" && <section className="dashboard-grid products-grid">
          <article className="panel span-2"><div className="panel-head"><div><p>PRODUCT RANKING</p><h2>Top products by net sales</h2></div></div><div className="product-ranking">{productSales.map(([name, value], i) => <div key={name}><span className="rank">{String(i + 1).padStart(2, "0")}</span><div><strong>{name}</strong><i><b style={{ width: `${value / maxProduct * 100}%` }} /></i></div><span>{money.format(value)}</span></div>)}</div></article>
          <article className="panel"><div className="panel-head"><div><p>CATEGORY CONTRIBUTION</p><h2>Portfolio concentration</h2></div></div><div className="category-cards">{categorySales.slice(0, 5).map(([name, value], i) => <div key={name}><span>{i + 1}</span><div><strong>{name}</strong><small>{pct(value / Math.max(1, metrics.net))} of sales</small></div><b>{compact.format(value)}</b></div>)}</div></article>
          <article className="panel span-3"><div className="panel-head"><div><p>DECISION SUPPORT</p><h2>How to use product forecasts</h2></div></div><div className="decision-steps"><div><span>01</span><strong>Prioritise</strong><p>Focus forecasting on top-selling SKUs where stock-outs have the greatest revenue impact.</p></div><div><span>02</span><strong>Plan</strong><p>Combine expected unit demand with supplier lead time and a manager-defined safety-stock level.</p></div><div><span>03</span><strong>Review</strong><p>Track actual versus predicted demand weekly and investigate large exceptions before reordering.</p></div></div></article>
        </section>}

        {section === "methodology" && <section className="methodology">
          <div className="method-intro"><p className="eyebrow">TRANSPARENT PREDICTIVE ANALYTICS</p><h2>Forecasts that can be explained and evaluated</h2><p>The dashboard separates descriptive reporting from genuine forward-looking analysis. Predictions are calculated from historical transactions; the executive summary only explains those calculated results.</p></div>
          <div className="method-flow"><article><span>1</span><div><h3>Prepare</h3><p>Validate the CSV, fill the calendar to daily grain, and surface zero or missing-date days and unusual sales values.</p></div></article><article><span>2</span><div><h3>Build candidates</h3><p>Fit weekly baseline, recent-weekday, robust-weekday, damped-trend and calendar-ridge candidates using only information available before each forecast date.</p></div></article><article><span>3</span><div><h3>Run rolling backtests</h3><p>Test the requested 7-day or 30-day horizon across up to eight chronological unseen periods. Random splitting and future-data leakage are avoided.</p></div></article><article><span>4</span><div><h3>Select and qualify</h3><p>Select the lowest-WAPE candidate for that horizon, report MAE and bias, and assign confidence from observed error rather than displaying a misleading accuracy percentage.</p></div></article><article><span>5</span><div><h3>Forecast responsibly</h3><p>Retrain the winner on complete history and use empirical historical errors for the displayed 80% range. Low-confidence recommendations require manager review.</p></div></article></div>
          <div className="method-cards"><article><p>PRIMARY METRIC</p><strong>WAPE</strong><span>Total absolute forecast error divided by actual sales. Lower is better; it is not converted into an “accuracy” claim.</span></article><article><p>CONTROL MODEL</p><strong>Seasonal naive</strong><span>A candidate must demonstrate value against simply repeating the most recent week.</span></article><article><p>VALIDATION DESIGN</p><strong>Up to 8 folds</strong><span>Each horizon is evaluated separately across chronological historical periods before a model is selected.</span></article></div>
          <div className="disclosure"><strong>Data-use disclosure</strong><p>RetailPulse does not include a sales dataset. Users must upload their own CSV, which is processed locally in the browser and is not retained by the application.</p></div>
        </section>}
        <footer><span>RetailPulse AI · CIS 6000 Research Prototype</span><span>Predictions support decisions; they do not replace managerial judgement.</span></footer>
      </section>
    </main>
  );
}
