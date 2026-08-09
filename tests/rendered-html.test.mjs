import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html", host: "localhost" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the RetailPulse application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>RetailPulse AI \| SME Sales Intelligence<\/title>/i);
  assert.match(html, /Preparing your sales intelligence/);
  assert.match(html, /Reading transactions and training the forecast model/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("includes the CSV analytics and predictive-analysis implementation", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /sri_lanka_supermarket_sales_2025\.csv/);
  assert.match(page, /function parseCsv/);
  assert.match(page, /function buildForecast/);
  assert.match(page, /Seasonal naive/);
  assert.match(page, /Trend \+ weekday model/);
  assert.match(page, /WAPE/);
  assert.match(layout, /og\.png/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await access(new URL("../public/data/sri_lanka_supermarket_sales_2025.csv", import.meta.url));
  await access(new URL("../public/og.png", import.meta.url));
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await access(root);
});
