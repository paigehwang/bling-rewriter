// app/api/topics/route.ts
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
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

async function getValues(sheets: any, spreadsheetId: string, range: string) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return (res.data.values ?? []) as string[][];
}

function normalize(s: string) {
  return (s || "").toString().trim();
}

function findCol(rows: string[][], headerName: string) {
  const header = rows[0] ?? [];
  return header.findIndex((h) => (h || "").trim() === headerName.trim());
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const service = normalize(url.searchParams.get("service") || "");

    const spreadsheetId = process.env.GOOGLE_SHEET_ID || process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId) {
      return NextResponse.json({ ok: false, error: "Missing GOOGLE_SHEET_ID" }, { status: 500 });
    }

    const sheets = getSheetsClient();
    const rows = await getValues(sheets, spreadsheetId, "주제!A:E");

    const idxTopicId = findCol(rows, "topic_id");
    const idxService = findCol(rows, "service");
    const idxTag = findCol(rows, "topic_tag");
    const idxName = findCol(rows, "display_name");
    const idxKeywords = findCol(rows, "keywords");

    const items = rows
      .slice(1)
      .map((r) => ({
        topic_id: idxTopicId >= 0 ? normalize(r[idxTopicId]) : "",
        service: idxService >= 0 ? normalize(r[idxService]) : "",
        topic_tag: idxTag >= 0 ? normalize(r[idxTag]) : "",
        display_name: idxName >= 0 ? normalize(r[idxName]) : "",
        keywords: idxKeywords >= 0 ? normalize(r[idxKeywords]) : "",
      }))
      .filter((t) => t.topic_tag && t.display_name);

    const filtered = service ? items.filter((t) => t.service === service) : items;

    const services = Array.from(new Set(items.map((t) => t.service).filter(Boolean))).sort();

    return NextResponse.json({
      ok: true,
      services,
      topics: filtered,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "Unknown error" }, { status: 500 });
  }
}
