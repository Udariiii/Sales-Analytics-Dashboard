import { DailyPoint, ForecastResult } from "@/lib/forecast";

export async function requestStatsForecast(daily: DailyPoint[], horizon: number, signal?: AbortSignal): Promise<ForecastResult> {
  const baseUrl = process.env.NEXT_PUBLIC_FORECAST_API_URL?.replace(/\/$/, "");
  if (!baseUrl) throw new Error("The StatsForecast service has not been connected yet.");
  const response = await fetch(`${baseUrl}/forecast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ daily: daily.map(({ date, sales }) => ({ date, sales })), horizon }),
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || "The forecasting service could not complete this request.");
  return body as ForecastResult;
}
