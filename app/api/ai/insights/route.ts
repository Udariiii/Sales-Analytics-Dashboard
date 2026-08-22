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
      temperature: 0.2,
      max_tokens: 700,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are a careful retail sales analyst. Use only the verified metrics supplied. Do not calculate new forecast values, invent causes, or claim causation. Return JSON with headline (string), summary (string), actions (array of 2-3 short strings), and risks (array of 1-2 short strings). Mention forecast uncertainty in plain language.",
        },
        { role: "user", content: serialized },
      ],
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) return NextResponse.json({ error: body?.error?.message || "DeepSeek analysis failed." }, { status: 502 });
  try {
    const result = JSON.parse(body.choices[0].message.content);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "DeepSeek returned an invalid analysis response." }, { status: 502 });
  }
}
