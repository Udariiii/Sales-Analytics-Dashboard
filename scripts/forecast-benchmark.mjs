import { readFile } from "node:fs/promises";
import { buildForecast } from "../lib/forecast.ts";

const source = process.argv[2] || new URL("../sri_lanka_supermarket_sales_2025.csv", import.meta.url);
const text = await readFile(source, "utf8");
const rows = text.trim().split(/\r?\n/);
const headers = rows[0].split(",");
const dateIndex = headers.indexOf("Sale_Date");
const salesIndex = headers.indexOf("Net_Sales_LKR");
const dailySales = new Map();

for (const line of rows.slice(1)) {
  const cells = line.split(",");
  const [day, month, year] = cells[dateIndex].split("/").map(Number);
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  dailySales.set(date, (dailySales.get(date) || 0) + Number(cells[salesIndex]));
}

const addDays = (date, days) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const dates = [...dailySales.keys()].sort();
const daily = [];
for (let date = dates[0]; date <= dates.at(-1); date = addDays(date, 1)) {
  daily.push({ date, sales: dailySales.get(date) || 0, profit: 0, units: 0, invoices: 0 });
}

console.log(JSON.stringify({
  source: String(source),
  transactionLines: rows.length - 1,
  calendarDays: daily.length,
  startDate: daily[0].date,
  endDate: daily.at(-1).date,
  zeroSalesDays: daily.filter((point) => point.sales === 0).length,
  minimumDailySales: Math.min(...daily.map((point) => point.sales)),
  maximumDailySales: Math.max(...daily.map((point) => point.sales)),
}, null, 2));

for (const horizon of [7, 30, 90, 180]) {
  const result = buildForecast(daily, horizon);
  if (!result) throw new Error(`Insufficient data for the ${horizon}-day benchmark.`);
  console.log(`\n${horizon}-DAY ROLLING BACKTEST (${result.folds} folds / ${result.evaluatedDays} evaluated days)`);
  console.table(result.models.map((model) => ({
    model: model.name,
    wape: `${(model.wape * 100).toFixed(2)}%`,
    maeLkr: Math.round(model.mae),
    bias: `${(model.bias * 100).toFixed(2)}%`,
  })));
  console.log(`Selected: ${result.winner.name}; confidence: ${result.confidence}; baseline improvement: ${(result.relativeImprovement * 100).toFixed(1)}%`);
}
