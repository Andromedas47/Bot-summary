import { NextRequest, NextResponse } from "next/server";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>).text !== "string") {
    return NextResponse.json({ error: 'Body must be { "text": string }' }, { status: 400 });
  }

  const text = ((body as Record<string, unknown>).text as string).trim();
  if (!text) {
    return NextResponse.json({ error: '"text" must not be empty' }, { status: 400 });
  }

  const result = parseWeighSession(text);

  return NextResponse.json({
    success: result.parse_errors.length === 0,
    session: {
      date:          result.date,
      staff_name:    result.staff_name,
      session_title: result.session_title,
    },
    items:  result.items,
    errors: result.parse_errors,
  });
}
