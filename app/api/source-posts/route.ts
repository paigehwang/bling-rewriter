// app/api/source-posts/route.ts
import { NextResponse } from "next/server";
import { google } from "googleapis";

function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!;
  const key = (
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ||
    process.env.GOOGLE_PRIVATE_KEY ||
    ""
  ).replace(/\\n/g, "\n");

  if (!email || !key) throw new Error("Missing Google service account env vars");

  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  return google.sheets({ version: "v4", auth });
}

async function getValues(sheets: any, spreadsheetId: string, range: string) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return (res.data.values ?? []) as string[][];
}

function normalize(v: any) {
  return (v ?? "").toString().trim();
}

// posts_full: B=title(1), C=pcUrl(2), J=service(9)
const RANGE_POSTS = "posts_full!A:J";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 400), 800);
    const service = normalize(url.searchParams.get("service") ?? "");

    const spreadsheetId = process.env.GOOGLE_SHEET_ID || process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId) {
      return NextResponse.json({ ok: false, error: "Missing GOOGLE_SHEET_ID" }, { status: 500 });
    }

    const sheets = getSheetsClient();
    const rows = await getValues(sheets, spreadsheetId, RANGE_POSTS);
    const data = rows.slice(1);

    let items = data
      .map((r) => {
        const title = normalize(r[1]);
        const pcUrl = normalize(r[2]);
        const svc = normalize(r[9]); // ✅ J열 (카테고리/서비스)
        return { title, pcUrl, service: svc };
      })
      // ✅ J열 비어있으면 그냥 넘어감(리스트에서 제외)
      .filter((x) => x.title && x.pcUrl && x.service);

    if (service) items = items.filter((x) => x.service === service);

    // 최신글이 아래로 쌓인다고 가정 → 뒤에서부터 limit개
    items = items.slice(-limit).reverse();

    return NextResponse.json({ ok: true, items });
  } catch (err: any) {
    console.error("🔥 source-posts error:", err?.message, err);
    return NextResponse.json({ ok: false, error: err?.message ?? "Unknown error" }, { status: 500 });
  }
}
