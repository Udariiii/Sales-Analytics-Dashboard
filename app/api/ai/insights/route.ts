import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "DeepSeek is not configured yet." }, { status: 503 });

  const input = await request.json().catch(() => null);
  const serialized = JSON.stringify(input);
  if (!input || serialized.length > 50_000) return NextResponse.json({ error: "The analysis summary is invalid or too large." }, { status: 400 });

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      thinking: { type: "disabled" },
      temperature: 0.2,
      max_tokens: 1100,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: 'Write a compact management brief for a small-business owner with no analytics knowledge. Start with the uploaded historical business performance, then explain the forecast. Use only the supplied aggregated facts. Never use statistical or model terms such as WAPE, MAE, bias, confidence interval, model, or algorithm. The headline must be under 12 words and state the main business trend. The summary must be 2-3 short sentences covering recent sales movement, the most important current business implication, and the expected direction ahead. Provide 3-5 business highlights using only the strongest available facts about sales movement, profit, leading categories or products, busiest day, payment mix, promotions, or data quality. Each highlight must combine a useful number with what it means. Give 2-3 specific practical actions that begin with a verb and follow directly from the highlights. Give at most one simple thing to check. Do not invent causes, targets, or numbers. If a metric is null or unavailable, omit it. Use the supplied currency and round money and percentages for readability. Return only JSON in exactly this shape: {"headline":"...","summary":"...","highlights":["...","...","..."],"actions":["...","..."],"risks":["..."]}.',
        },
        { role: "user", content: serialized },
      ],
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) return NextResponse.json({ error: body?.error?.message || "DeepSeek analysis failed." }, { status: 502 });
  try {
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("Empty response");
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const result = JSON.parse(cleaned);
    if (
      typeof result?.headline !== "string" ||
      typeof result?.summary !== "string" ||
      !Array.isArray(result?.highlights) ||
      !Array.isArray(result?.actions) ||
      !Array.isArray(result?.risks)
    ) throw new Error("Invalid response shape");
    return NextResponse.json({
      headline: result.headline,
      summary: result.summary,
      highlights: result.highlights.filter((item: unknown) => typeof item === "string").slice(0, 5),
      actions: result.actions.filter((item: unknown) => typeof item === "string").slice(0, 3),
      risks: result.risks.filter((item: unknown) => typeof item === "string").slice(0, 2),
    });
  } catch {
    return NextResponse.json({ error: "DeepSeek returned an invalid analysis response." }, { status: 502 });
  }
}
