import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { addDays, buildForecast, minimumHistoryDays } from "../lib/forecast.ts";
import { applyMapping, createImportPreview, parseDelimited, suggestMappings } from "../lib/sales-import.ts";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/login", { headers: { accept: "text/html", host: "localhost" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the RetailPulse authentication shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>RetailPulse AI \| SME Sales Intelligence<\/title>/i);
  assert.match(html, /Sign in to your workspace/);
  assert.match(html, /Continue with Google/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("includes flexible local-AI importing and rolling predictive analysis", async () => {
  const [page, importer, aiMapper, forecastModule, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/sales-import.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/local-ai-mapper.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/forecast.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /sri_lanka_supermarket_sales_2025\.csv/);
  assert.doesNotMatch(page, /Confirm what your columns mean/);
  assert.doesNotMatch(page, /Generate compatible dashboard/);
  assert.match(page, /Understanding your sales columns/);
  assert.match(page, /applyMapping\(preview, mappings\)/);
  assert.match(page, /\.csv,\.tsv,\.txt,\.xlsx/);
  assert.match(importer, /Map both Sale date and Net sales/);
  assert.match(aiMapper, /all-MiniLM-L6-v2-ONNX/);
  assert.match(aiMapper, /dtype: "q4"/);
  assert.match(aiMapper, /Local AI \+ validation/);
  assert.match(page, /buildForecast\(dailyAll, forecastDays\)/);
  assert.match(page, /Upload complete/);
  assert.match(page, /input\.value = ""/);
  assert.match(page, /YOUR SALES FORECAST/);
  assert.match(page, /How close past estimates were/);
  assert.doesNotMatch(page, /forecast accuracy|Model accuracy/i);
  assert.match(forecastModule, /Seasonal naive/);
  assert.match(forecastModule, /Calendar ridge/);
  assert.match(forecastModule, /Robust weekday average/);
  assert.match(forecastModule, /folds\.length < 8/);
  assert.doesNotMatch(page, /WAPE/);
  assert.match(layout, /og\.png/);
  assert.match(packageJson, /@huggingface\/transformers/);
  assert.match(packageJson, /read-excel-file/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../public/data/sri_lanka_supermarket_sales_2025.csv", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../app/login/page.tsx", import.meta.url));
  await access(new URL("../app/signup/page.tsx", import.meta.url));
  await access(new URL("../proxy.ts", import.meta.url));
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await access(root);
});

test("maps unfamiliar sales headers and enables only supported analytics", () => {
  const data = [
    ["Monthly export"],
    ["Order Date", "Receipt No.", "Item Desc", "Dept", "Units Sold", "Final Amount", "Purchase Cost", "Tender Type"],
    ["01/01/2025", "R-1", "Tea", "Grocery", "2", "1,500.00", "900", "Cash"],
    ["02/01/2025", "R-2", "Milk", "Dairy", "1", "800.00", "500", "Card"],
    ["bad date", "R-3", "Bread", "Bakery", "1", "600.00", "400", "Cash"],
  ];
  const preview = createImportPreview("different-format.xlsx", { sheet: "Sales", data });
  assert.equal(preview.headerRow, 1);
  const mappings = suggestMappings(preview.profiles);
  const targets = new Set(mappings.map((mapping) => mapping.target));
  assert.ok(targets.has("date"));
  assert.ok(targets.has("netSales"));
  assert.ok(targets.has("product"));
  assert.ok(targets.has("category"));
  const result = applyMapping(preview, mappings);
  assert.equal(result.rows.length, 2);
  assert.equal(result.report.invalidDates, 1);
  assert.equal(result.report.capabilities.product, true);
  assert.equal(result.report.capabilities.category, true);
  assert.equal(result.report.capabilities.profit, true);
  assert.equal(result.report.capabilities.promotion, false);
  assert.equal(result.rows[0].net, 1500);
  assert.equal(result.rows[0].profit, 600);
});

test("accepts semicolon-delimited minimal sales data", () => {
  const data = parseDelimited("Business Date;Revenue\n2025-01-01;1200\n2025-01-02;1300");
  const preview = createImportPreview("minimal.csv", { sheet: "Data", data });
  const result = applyMapping(preview, suggestMappings(preview.profiles));
  assert.equal(result.rows.length, 2);
  assert.equal(result.report.capabilities.salesTrend, true);
  assert.equal(result.report.capabilities.product, false);
  assert.equal(result.report.capabilities.invoices, false);
});

test("distinguishes net from gross sales and rates from monetary amounts", () => {
  const data = [
    ["Date", "Gross Sales", "Discount Pct", "Discount Amount", "Net Sales", "Unit Cost", "Total Cost"],
    ["2025-01-01", 1000, 10, 100, 900, 250, 500],
    ["2025-01-02", 2000, 5, 100, 1900, 300, 900],
  ];
  const preview = createImportPreview("financial.csv", { sheet: "Data", data });
  const mappings = suggestMappings(preview.profiles);
  const byHeader = Object.fromEntries(mappings.filter((mapping) => mapping.target).map((mapping) => [preview.headers[mapping.sourceIndex], mapping.target]));
  assert.equal(byHeader["Gross Sales"], "grossSales");
  assert.equal(byHeader["Discount Pct"], "discountRate");
  assert.equal(byHeader["Discount Amount"], "discount");
  assert.equal(byHeader["Net Sales"], "netSales");
  assert.equal(byHeader["Unit Cost"], "unitCost");
  assert.equal(byHeader["Total Cost"], "cost");
});

test("forecasting uses horizon-specific rolling tests and honest confidence", () => {
  assert.equal(minimumHistoryDays(7), 105);
  assert.equal(minimumHistoryDays(30), 174);
  assert.equal(minimumHistoryDays(90), 450);

  const start = "2025-01-01";
  const weeklyPattern = [40_000, 42_000, 45_000, 48_000, 55_000, 70_000, 62_000];
  const daily = Array.from({ length: 180 }, (_, index) => ({
    date: addDays(start, index),
    sales: weeklyPattern[index % 7],
    profit: 0,
    units: 0,
    invoices: 0,
  }));

  assert.equal(buildForecast(daily.slice(0, minimumHistoryDays(30) - 1), 30), null);
  const sevenDay = buildForecast(daily, 7);
  const thirtyDay = buildForecast(daily, 30);
  assert.ok(sevenDay);
  assert.ok(thirtyDay);
  assert.equal(sevenDay.points.length, 7);
  assert.equal(thirtyDay.points.length, 30);
  assert.equal(sevenDay.folds, 8);
  assert.equal(thirtyDay.folds, 3);
  assert.ok(sevenDay.winner.wape < 1e-10);
  assert.equal(sevenDay.confidence, "High");
  assert.ok(sevenDay.points.every((point) => point.lower <= point.value && point.value <= point.upper));
});
test("integrates StatsForecast and DeepSeek without exposing raw rows or secrets", async () => {
  const [page, service, remoteForecast, insightRoute, renderConfig, envExample] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../forecast_service/app.py", import.meta.url), "utf8"),
    readFile(new URL("../lib/remote-forecast.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/ai/insights/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../render.yaml", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);

  assert.match(page, />3 months</);
  assert.doesNotMatch(page, />6 months</);
  assert.match(page, /AI BUSINESS ADVISER/);
  assert.match(page, /Summarise my business/);
  assert.match(page, /businessSnapshot/);
  assert.match(page, /Business highlights/);
  assert.match(page, /For more reliable forecasts/);
  assert.match(page, /Your uploaded data contains/);
  assert.match(page, /forecast: forecast \?/);
  assert.match(page, /Your advanced forecast is loading/);
  assert.match(page, /Quick backup forecast/);
  assert.match(page, /statsForecast\?\.points\.length === forecastDays/);
  assert.doesNotMatch(page, /combineForecasts|Hybrid selection/);
  assert.doesNotMatch(page, /<span>Confidence<\/span>/);
  assert.match(service, /AutoETS/);
  assert.match(service, /SeasonalNaive/);
  assert.match(service, /CalendarBlend/);
  assert.doesNotMatch(service, /AutoARIMA|DynamicOptimizedTheta|HybridDynamicAnnual/);
  assert.match(service, /distance_scale/);
  assert.match(service, /cross_validation/);
  assert.match(remoteForecast, /daily\.map\(\(\{ date, sales \}\)/);
  assert.match(remoteForecast, /75_000/);
  assert.doesNotMatch(page, /className="loading"/);
  assert.match(insightRoute, /deepseek-v4-flash/);
  assert.match(insightRoute, /DEEPSEEK_API_KEY/);
  assert.match(insightRoute, /result\?\.highlights/);
  assert.match(insightRoute, /If the forecast field is null/);
  assert.doesNotMatch(insightRoute, /NEXT_PUBLIC_DEEPSEEK/);
  assert.match(renderConfig, /rootDir: forecast_service/);
  assert.match(envExample, /NEXT_PUBLIC_FORECAST_API_URL/);
});
