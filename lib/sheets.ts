// lib/sheets.ts
import { google } from "googleapis";

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const keyRaw = process.env.GOOGLE_PRIVATE_KEY;

  // ✅ 디버그: 값이 실제로 잡히는지 확인 (테스트 끝나면 지워도 됨)
  console.log(
    "[ENV CHECK]",
    "email?",
    !!email,
    "key?",
    !!keyRaw,
    "emailPrefix:",
    email ? email.slice(0, 12) : "none"
  );

  const key = keyRaw?.replace(/\\n/g, "\n");
  if (!email || !key) throw new Error("Missing Google service account env vars");

  return new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

export async function sheetsGetValues({ range }: { range: string }): Promise<string[][]> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) throw new Error("Missing GOOGLE_SHEETS_ID");

  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: "FORMATTED_VALUE",
  });

  return (res.data.values as string[][]) ?? [];
}
