import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { addDays, buildForecast, minimumHistoryDays } from "../lib/forecast.ts";

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

test("includes the CSV analytics and rolling predictive-analysis implementation", async () => {
  const [page, forecastModule, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/forecast.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /sri_lanka_supermarket_sales_2025\.csv/);
  assert.match(page, /function parseCsv/);
  assert.match(page, /function normalizeDate/);
  assert.match(page, /detectSlashDateOrder/);
  assert.match(page, /buildForecast\(dailyAll, forecastDays\)/);
  assert.match(page, /Upload complete/);
  assert.match(page, /loaded successfully/);
  assert.match(page, /input\.value = ""/);
  assert.match(page, /ROLLING-BACKTESTED FORECAST/);
  assert.match(page, /Historical forecast error/);
  assert.doesNotMatch(page, /forecast accuracy|Model accuracy/i);
  assert.match(forecastModule, /Seasonal naive/);
  assert.match(forecastModule, /Calendar ridge/);
  assert.match(forecastModule, /Robust weekday average/);
  assert.match(forecastModule, /folds\.length < 8/);
  assert.match(page, /WAPE/);
  assert.match(layout, /og\.png/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../public/data/sri_lanka_supermarket_sales_2025.csv", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../app/login/page.tsx", import.meta.url));
  await access(new URL("../app/signup/page.tsx", import.meta.url));
  await access(new URL("../proxy.ts", import.meta.url));
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await access(root);
});

test("forecasting uses horizon-specific rolling tests and honest confidence", () => {
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
