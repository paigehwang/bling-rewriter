// app/api/source-posts/route.ts
import { NextResponse } from "next/server";
import { google } from "googleapis";

/* =====================
   Google Sheets Client
===================== */
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

function normalize(s: any) {
  return (s ?? "").toString().trim();
}

/**
 * posts_full!A:F 가정 (너 말 기준)
 * - B(1): title
 * - C(2): pcUrl  ✅ 고유키로 사용
 * - D(3): mobileUrl (비어있음)
 * - F(5): contentText
 */
const RANGE_POSTS = "posts_full!A:F";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "200") || 200, 500);

    const spreadsheetId = process.env.GOOGLE_SHEET_ID || process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId) {
      return NextResponse.json({ ok: false, error: "Missing GOOGLE_SHEET_ID" }, { status: 500 });
    }

    const sheets = getSheetsClient();
    const rows = await getValues(sheets, spreadsheetId, RANGE_POSTS);
    const data = rows.slice(1);

    const sliced = data.slice(-limit).reverse();

    const items = sliced
      .map((r) => {
        const title = normalize(r[1]); // B
        const pcUrl = normalize(r[2]); // C
        return { title, pcUrl };
      })
      .filter((x) => x.title && x.pcUrl);

    return NextResponse.json({ ok: true, items });
  } catch (err: any) {
    console.error("🔥 source-posts error:", err?.message, err);
    return NextResponse.json({ ok: false, error: err?.message ?? "Unknown error" }, { status: 500 });
  }
}
