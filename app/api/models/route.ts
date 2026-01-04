import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function GET() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ ok: false, error: "Missing GEMINI_API_KEY" }, { status: 500 });

  const genAI = new GoogleGenerativeAI(apiKey);

  try {
    // SDK에 listModels가 있으면 이게 동작
    // (버전에 따라 없을 수 있음 → 그럼 아래 3번으로)
    // @ts-ignore
    const res = await genAI.listModels();
    return NextResponse.json({ ok: true, models: res });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, message: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}
