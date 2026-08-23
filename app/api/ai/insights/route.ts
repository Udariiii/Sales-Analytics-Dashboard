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
          content: 'You are a careful retail sales analyst. Use only the verified metrics supplied. Do not calculate new forecast values, invent causes, or claim causation. Return only JSON in exactly this shape: {"headline":"...","summary":"...","actions":["...","..."],"risks":["..."]}. Mention forecast uncertainty in plain language.',
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
