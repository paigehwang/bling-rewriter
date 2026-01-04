// app/api/centers/route.ts
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

export async function GET() {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID || process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId) {
      return NextResponse.json({ ok: false, error: "Missing GOOGLE_SHEET_ID" }, { status: 500 });
    }

    const sheets = getSheetsClient();
    const rows = await getValues(sheets, spreadsheetId, "센터정보!A1:Z500");

    const idxId = findCol(rows, "센터ID");
    const idxName = findCol(rows, "운영상 기관명 (해당 셀 메모 필독)");
    const idxTel = findCol(rows, "전화번호");
    const idxAddr = findCol(rows, "행정상 주소지");

    if (idxId < 0) {
      return NextResponse.json({ ok: false, error: "센터정보 시트에 '센터ID' 헤더가 없음" }, { status: 500 });
    }

    const list = rows
      .slice(1)
      .map((r) => ({
        centerId: normalize(r[idxId]),
        name: normalize(r[idxName]),
        tel: idxTel >= 0 ? normalize(r[idxTel]) : "",
        addr: idxAddr >= 0 ? normalize(r[idxAddr]) : "",
      }))
      .filter((c) => c.centerId && c.name);

    return NextResponse.json({ ok: true, centers: list });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "Unknown error" }, { status: 500 });
  }
}
