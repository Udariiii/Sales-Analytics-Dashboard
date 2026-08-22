import { DailyPoint, ForecastResult } from "@/lib/forecast";

export async function requestStatsForecast(daily: DailyPoint[], horizon: number, signal?: AbortSignal): Promise<ForecastResult> {
  const baseUrl = process.env.NEXT_PUBLIC_FORECAST_API_URL?.replace(/\/$/, "");
  if (!baseUrl) throw new Error("The online forecast service has not been connected yet.");
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, 75_000);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const response = await fetch(`${baseUrl}/forecast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daily: daily.map(({ date, sales }) => ({ date, sales })), horizon }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || "The online forecast could not complete this request.");
    return body as ForecastResult;
  } catch (error) {
    if (timedOut) throw new Error("The online forecast took too long, so the quick forecast is shown instead.");
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", forwardAbort);
  }
}
