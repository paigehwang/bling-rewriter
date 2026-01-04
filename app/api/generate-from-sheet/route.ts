// app/api/generate-from-sheet/route.ts
import { NextResponse } from "next/server";
import { google } from "googleapis";
import { GoogleGenerativeAI } from "@google/generative-ai";

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
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

async function getValues(sheets: any, spreadsheetId: string, range: string) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return (res.data.values ?? []) as string[][];
}

function findCol(rows: string[][], headerName: string) {
  const header = rows[0] ?? [];
  return header.findIndex((h) => (h || "").trim() === headerName.trim());
}

function stripMarkdown(s: string) {
  return (s || "")
    .replaceAll("**", "")
    .replaceAll("##", "")
    .replaceAll("###", "")
    .replaceAll("####", "")
    .replaceAll("`", "")
    .replaceAll("> ", "")
    .trim();
}

function countOccurrences(text: string, keyword: string) {
  const k = (keyword || "").trim();
  if (!k) return 0;
  let idx = 0;
  let count = 0;
  while (true) {
    idx = text.indexOf(k, idx);
    if (idx === -1) break;
    count += 1;
    idx += k.length;
  }
  return count;
}

function normalize(v: any) {
  return (v ?? "").toString().trim();
}

/* =====================
   Ranges
===================== */
const RANGE_POSTS = "posts_full!A:F"; // B=title, C=pcUrl, F=contentText

/* =====================
   Main
===================== */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));

    const centerId = normalize(body?.centerId);
    const keyword1 = normalize(body?.keyword1);
    const sourcePcUrl = normalize(body?.sourcePcUrl);

    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({ ok: false, error: "Missing GEMINI_API_KEY" }, { status: 500 });
    }

    const spreadsheetId = process.env.GOOGLE_SHEET_ID || process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId) {
      return NextResponse.json({ ok: false, error: "Missing GOOGLE_SHEET_ID" }, { status: 500 });
    }

    if (!centerId) {
      return NextResponse.json({ ok: false, error: "centerId required" }, { status: 400 });
    }
    if (!keyword1) {
      return NextResponse.json({ ok: false, error: "keyword1 required" }, { status: 400 });
    }
    if (!sourcePcUrl) {
      return NextResponse.json({ ok: false, error: "sourcePcUrl required" }, { status: 400 });
    }

    const sheets = getSheetsClient();

    /* =====================
       1) 센터 정보
    ===================== */
    const centerRows = await getValues(sheets, spreadsheetId, "센터정보!A1:Z2000");
    const idxId = findCol(centerRows, "센터ID");
    const idxName = findCol(centerRows, "운영상 기관명 (해당 셀 메모 필독)");
    const idxTel = findCol(centerRows, "전화번호");
    const idxAddr = findCol(centerRows, "행정상 주소지");

    if (idxId < 0) {
      return NextResponse.json({ ok: false, error: "센터정보 시트에 '센터ID' 헤더가 없음" }, { status: 500 });
    }

    const centerRow = centerRows.slice(1).find((r) => normalize(r[idxId]) === centerId);
    if (!centerRow) {
      return NextResponse.json({ ok: false, error: `센터ID를 찾을 수 없음: ${centerId}` }, { status: 404 });
    }

    const centerName = normalize(centerRow[idxName]);
    const tel = normalize(centerRow[idxTel]) || "1522-6585";
    const addr = normalize(centerRow[idxAddr]);

    /* =====================
       2) 원본 원고 찾기
    ===================== */
    const postRows = await getValues(sheets, spreadsheetId, RANGE_POSTS);
    const posts = postRows.slice(1);

    // C열 = PC URL
    const sourceRow = posts.find((r) => normalize(r[2]) === sourcePcUrl);
    if (!sourceRow) {
      return NextResponse.json(
        { ok: false, error: `원본 원고를 찾을 수 없음 (pcUrl): ${sourcePcUrl}` },
        { status: 404 }
      );
    }

    const sourceTitle = normalize(sourceRow[1]); // B
    const sourceContent = normalize(sourceRow[5]); // F

    if (!sourceContent) {
      return NextResponse.json({ ok: false, error: "원본 본문(contentText)이 비어있음" }, { status: 500 });
    }

    /* =====================
       3) Gemini
    ===================== */
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    /* =====================
       4) Prompt
    ===================== */
    const voiceBlock = `
[화자/역할]
- 당신은 장기요양센터 센터장 / 사회복지사입니다.
- 새로운 글을 창작하지 않고, 기존 글을 자연스럽게 ‘편집·재작성’합니다.
- 보호자에게 설명하듯 친절하고 담백하게 씁니다.
- 과장/단정/공격적 광고 문구는 피합니다.
- 의료 판단, 법적 확정 표현은 하지 않습니다.
`.trim();

    const rewriteRule = `
[리라이팅 규칙]
1) 원본 글의 전체 흐름과 구조를 유지합니다.
2) 문장 표현만 자연스럽게 바꾸되 의미는 바꾸지 않습니다.
3) 원본에 없는 제도/숫자/조건/혜택/단가는 추가하지 않습니다.
4) 다른 기관/상호/브랜드는 삭제하거나 일반화합니다.
5) 센터명/주소/전화는 반드시 [센터 정보] 기준으로 통일합니다.
6) 목표키워드는 본문에 2~3회만 자연스럽게 포함합니다.
7) AI/자동생성/패러프레이즈/리라이트 같은 메타 표현은 사용하지 않습니다.
`.trim();

    const formatRule = `
[출력 형식 - 반드시 지켜]
- 아래 토큰을 그대로 출력합니다.
- SEO 제목은 제목만 3줄.
- 본문은 공백 제외 한글 1000~1200자.

<<SEO_TITLES>>

<<BODY>>

1. 소제목
(본문 2~3문단)

2. 소제목
(본문 2~3문단)

3. 소제목
(본문 2~3문단)

4. 소제목
(본문 2~3문단)

<<END>>

- 마크다운 금지
- 연속 줄바꿈 3줄 이상 금지
`.trim();

const seoTitleRule = `
[SEO 제목 규칙 - 매우 중요]
- 아래 3개의 SEO 제목은 모두 목표 키워드를 반드시 포함해야 합니다.
- 3개 제목 모두에 목표 키워드를 그대로 포함합니다. (동의어 치환 금지)
- 키워드는 제목의 앞/중간/뒤 등 위치만 바꿔서 변주합니다.
- 키워드를 제외한 나머지 표현만 다르게 구성합니다.
`.trim();


    const finalPrompt = `
${voiceBlock}

${rewriteRule}

${seoTitleRule}

${formatRule}

[센터 정보]
- 센터명: ${centerName}
- 주소: ${addr || "(미기재)"}
- 전화: ${tel}

[목표 키워드]
- ${keyword1}

[원본 원고]
제목: ${sourceTitle}
URL: ${sourcePcUrl}

${sourceContent}

위 규칙을 지키며 출력하세요.
`.trim();

    let raw = "";

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await model.generateContent(
        finalPrompt +
          (attempt === 1
            ? `
[재요청]
- 목표 키워드는 본문에 2~3회만 포함
- 토큰 누락 금지
- 분량 조건 반드시 준수
`
            : "")
      );

      raw = stripMarkdown(result.response.text() || "");

      raw = raw
        .replace(/\b(AI|자동\s?생성|패러프레이즈|리라이트|rewrite)\b/gi, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      const ok1 = countOccurrences(raw, keyword1) >= 2;
      const okTok = raw.includes("<<SEO_TITLES>>") && raw.includes("<<BODY>>") && raw.includes("<<END>>");
      if (ok1 && okTok) break;
    }

    /* =====================
       5) Log
    ===================== */
    const createdAt = new Date().toISOString();
    const len = raw.length;

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Log!A:O",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          createdAt,
          centerId,
          centerName,
          "",
          "정보성(리라이팅)",
          "",
          keyword1,
          "",
          sourceTitle,
          0,
          len,
          "",
          "",
          sourcePcUrl,
          sourceTitle,
        ]],
      },
    });

    return NextResponse.json({
      ok: true,
      meta: {
        centerId,
        centerName,
        keyword1,
        tel,
        addr,
        sourcePcUrl,
        sourceTitle,
      },
      text: raw,
    });
  } catch (err: any) {
    console.error("🔥 generate-from-sheet error:", err?.message, err);
    return NextResponse.json({ ok: false, error: err?.message ?? "Unknown error" }, { status: 500 });
  }
}
