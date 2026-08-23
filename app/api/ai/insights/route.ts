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
      max_tokens: 900,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: 'Write for a small-business owner with no analytics knowledge. Use only the supplied facts. Never use statistical or model terms such as WAPE, MAE, bias, confidence interval, model, or algorithm. The headline must be under 12 words. The summary must be 1-2 short sentences explaining what may happen to sales and the most important business implication. Give 2-3 specific, practical actions that begin with a verb. Give at most one simple thing to check. Do not invent causes or new numbers. Return only JSON in exactly this shape: {"headline":"...","summary":"...","actions":["...","..."],"risks":["..."]}.',
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
      !Array.isArray(result?.actions) ||
      !Array.isArray(result?.risks)
    ) throw new Error("Invalid response shape");
    return NextResponse.json({
      headline: result.headline,
      summary: result.summary,
      actions: result.actions.filter((item: unknown) => typeof item === "string").slice(0, 3),
      risks: result.risks.filter((item: unknown) => typeof item === "string").slice(0, 2),
    });
  } catch {
    return NextResponse.json({ error: "DeepSeek returned an invalid analysis response." }, { status: 502 });
  }
}
