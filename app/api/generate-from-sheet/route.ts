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

/** 주소에서 시/도 + 구/군 정도만 뽑아 지역 힌트로 제공 */
function getRegionHint(addr: string) {
  const a = normalize(addr);
  if (!a) return "";
  const tokens = a.split(/\s+/).filter(Boolean);
  const first = tokens[0] || "";
  const second = tokens[1] || "";
  return [first, second].filter(Boolean).join(" ");
}

/* =====================
   Output Parsing & Guards
===================== */
function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSeoTitles(raw: string) {
  const m = raw.match(/<<SEO_TITLES>>\s*([\s\S]*?)\s*<<BODY>>/);
  const block = (m?.[1] ?? "").trim();
  const lines = block
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  return lines.slice(0, 3);
}

function extractBody(raw: string) {
  const m = raw.match(/<<BODY>>\s*([\s\S]*?)\s*<<END>>/);
  return (m?.[1] ?? "").trim();
}

/** BODY 블록만 교체 */
function replaceBody(raw: string, newBody: string) {
  return raw.replace(
    /(<<BODY>>\s*)([\s\S]*?)(\s*<<END>>)/,
    `$1${newBody}$3`
  );
}

function reduceKeywordToMax(body: string, keyword: string, max: number) {
  const k = keyword.trim();
  if (!k) return body;

  // keyword 발생 위치를 전부 찾고, 뒤에서부터 max개 남기고 제거
  const positions: number[] = [];
  let idx = 0;
  while (true) {
    const hit = body.indexOf(k, idx);
    if (hit === -1) break;
    positions.push(hit);
    idx = hit + k.length;
  }
  if (positions.length <= max) return body;

  // 제거해야 하는 개수 = positions.length - max
  const removeCount = positions.length - max;
  // 뒤에서부터 removeCount개 제거
  let out = body;
  for (let i = 0; i < removeCount; i++) {
    // out에서 "마지막" keyword 1개 제거
    const last = out.lastIndexOf(k);
    if (last === -1) break;
    out = out.slice(0, last) + out.slice(last + k.length);
  }

  // 공백 정리
  out = out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

/**
 * 키워드 2~3회 강제 보정:
 * - 부족하면 도입부/마무리에 자연스럽게 1~2문장 삽입
 * - 과다하면 뒤에서부터 keyword 문자열을 제거(최소한의 보험)
 */
function ensureKeywordCount(raw: string, keyword: string, min = 2, max = 3) {
  const k = keyword.trim();
  if (!k) return raw;

  const body = extractBody(raw);
  if (!body) return raw;

  const cnt = countOccurrences(body, k);
  let newBody = body;

  if (cnt < min) {
    const need = min - cnt;

    const insertTop = `\n\n이번 글에서는 ${k}를 중심으로 보호자분들이 자주 궁금해하시는 내용을 차근차근 정리해보겠습니다.\n`;
    const insertBottom = `\n\n마지막으로 ${k} 이용 전에는 어르신의 상황과 일정에 맞춰 준비사항을 한 번 더 점검해두면 도움이 됩니다.\n`;

    if (need >= 1) newBody = insertTop + newBody;
    if (need >= 2) newBody = newBody + insertBottom;

    // 혹시 4회 이상이 되진 않았는지 방어
    newBody = reduceKeywordToMax(newBody, k, max);
  } else if (cnt > max) {
    newBody = reduceKeywordToMax(newBody, k, max);
  }

  return replaceBody(raw, newBody);
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
      return NextResponse.json(
        { ok: false, error: "Missing GEMINI_API_KEY" },
        { status: 500 }
      );
    }

    const spreadsheetId =
      process.env.GOOGLE_SHEET_ID || process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId) {
      return NextResponse.json(
        { ok: false, error: "Missing GOOGLE_SHEET_ID" },
        { status: 500 }
      );
    }

    if (!centerId) {
      return NextResponse.json(
        { ok: false, error: "centerId required" },
        { status: 400 }
      );
    }
    if (!keyword1) {
      return NextResponse.json(
        { ok: false, error: "keyword1 required" },
        { status: 400 }
      );
    }
    if (!sourcePcUrl) {
      return NextResponse.json(
        { ok: false, error: "sourcePcUrl required" },
        { status: 400 }
      );
    }

    const sheets = getSheetsClient();

    /* =====================
       1) 센터 정보
    ===================== */
    const centerRows = await getValues(
      sheets,
      spreadsheetId,
      "센터정보!A1:Z2000"
    );
    const idxId = findCol(centerRows, "센터ID");
    const idxName = findCol(centerRows, "운영상 기관명 (해당 셀 메모 필독)");
    const idxTel = findCol(centerRows, "전화번호");
    const idxAddr = findCol(centerRows, "행정상 주소지");

    if (idxId < 0) {
      return NextResponse.json(
        { ok: false, error: "센터정보 시트에 '센터ID' 헤더가 없음" },
        { status: 500 }
      );
    }

    const centerRow = centerRows
      .slice(1)
      .find((r) => normalize(r[idxId]) === centerId);
    if (!centerRow) {
      return NextResponse.json(
        { ok: false, error: `센터ID를 찾을 수 없음: ${centerId}` },
        { status: 404 }
      );
    }

    const centerName = normalize(centerRow[idxName]);
    const tel = normalize(centerRow[idxTel]) || "1522-6585";
    const addr = normalize(centerRow[idxAddr]);
    const regionHint = getRegionHint(addr);

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
      return NextResponse.json(
        { ok: false, error: "원본 본문(contentText)이 비어있음" },
        { status: 500 }
      );
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
- 기존 글을 자연스럽게 ‘편집·재작성’합니다.
- 보호자에게 설명하듯 친절하고 담백하게 씁니다.
- 과장/단정/공격적 광고 문구는 피합니다.
- 의료 판단, 법적 확정 표현은 하지 않습니다.
`.trim();

    const rewriteRule = `
[리라이팅 규칙]
1) 원본 글의 전체 흐름과 구조를 유지합니다.
2) 문장 표현만 자연스럽게 바꾸되 의미는 바꾸지 않습니다.
3) 원본에 없는 제도/숫자/조건/혜택/단가를 새로 만들어 추가하지 않습니다. (원본에 있는 내용은 그대로 사용 가능)
4) 원본에 등장하는 다른 기관/상호/브랜드/센터명/지역명(예: 광주, 여수 등)은 모두 삭제하거나 일반화합니다.
5) 센터명/주소/전화는 반드시 아래 [센터 정보] 기준으로 통일합니다. (다른 센터명/지역명/연락처가 절대 등장하면 안 됨)
6) "[센터 정보]" 같은 플레이스홀더/대괄호 토큰은 절대 출력하지 않습니다. 실제 센터명으로 바로 써야 합니다.
7) 반드시! 목표키워드는 본문에 2~3회 자연스럽게 포함합니다.
8) AI/자동생성/패러프레이즈/리라이트 같은 메타 표현은 사용하지 않습니다.
9) 원본 URL/출처/참고글 언급은 하지 않습니다.
10) 소제목은 반드시 실제 의미 있는 문장으로 작성하며, "소제목"이라는 단어를 그대로 사용하지 않습니다.
`.trim();

    const formatRule = `
[출력 형식 - 반드시 지켜]
- 아래 토큰을 그대로 출력합니다.
- SEO 제목은 제목만 3줄.
- 본문은 공백 제외 한글 1000~1200자.

<<SEO_TITLES>>

<<BODY>>

1. {소제목}
(본문 2~3문단)

2. {소제목}
(본문 2~3문단)

3. {소제목}
(본문 2~3문단)

4. {소제목}
(본문 2~3문단)

<<END>>

- {소제목}은 실제 문장으로 작성한다.
- 원본 글에 소제목이 있으면 의미를 유지해 재작성한다.
- 원본 글에 소제목이 없으면 내용을 요약해 적절한 소제목을 새로 만든다.
- "소제목"이라는 단어를 그대로 출력하지 않는다.
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

[센터 정보]  (이 정보만이 유일한 기준입니다. 원본의 지역/센터 정보는 사용 금지)
- 센터명: ${centerName}
- 주소: ${addr || "(미기재)"}
- 지역 힌트: ${regionHint || "(미기재)"}
- 전화: ${tel}

[목표 키워드]
- ${keyword1}

[원본 원고]
제목: ${sourceTitle}

${sourceContent}

위 규칙을 지키며 출력하세요.
`.trim();

    /* =====================
       4-1) Generate with Hard Guards
    ===================== */
    let raw = "";
    let passed = false;

    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await model.generateContent(
        finalPrompt +
          (attempt > 0
            ? `
[재요청 - 실패 보정]
- "[센터 정보]" 플레이스홀더/대괄호 표기는 절대 출력 금지 (실제 센터명으로 바로 작성)
- 원본의 지역명/센터명/연락처가 그대로 나오면 실패입니다. 반드시 선택 센터 정보로 통일하세요.
- 목표 키워드는 본문에 정확히 2~3회 포함되어야 합니다. (누락/과다 모두 실패)
- SEO 제목 3개 모두 목표 키워드를 반드시 포함해야 합니다.
- 토큰 누락 금지
- 분량 조건 반드시 준수 (1000자~1200자)
`
            : "")
      );

      raw = stripMarkdown(result.response.text() || "");

      raw = raw
        .replace(/\b(AI|자동\s?생성|패러프레이즈|리라이트|rewrite)\b/gi, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      // 보험: [센터 정보] 노출되면 치환
      raw = raw.replace(/\[\s*센터\s*정보\s*\]/g, `${centerName}(${tel})`);

      const titles = extractSeoTitles(raw);
      const bodyText = extractBody(raw);

      const okTok =
        raw.includes("<<SEO_TITLES>>") &&
        raw.includes("<<BODY>>") &&
        raw.includes("<<END>>");

      const okTitles = titles.length === 3 && titles.every((t) => t.includes(keyword1));
      const bodyCnt = countOccurrences(bodyText, keyword1);
      const okBody = bodyCnt >= 2 && bodyCnt <= 3;

      const noPlaceholder = !/\[\s*센터\s*정보\s*\]/.test(raw);

      if (okTok && okTitles && okBody && noPlaceholder) {
        passed = true;
        break;
      }
    }

    // 마지막 보험: 그래도 실패하면 BODY에서만 키워드 2~3회로 보정 시도
    if (!passed) {
      raw = ensureKeywordCount(raw, keyword1, 2, 3);

      const titles = extractSeoTitles(raw);
      const bodyText = extractBody(raw);

      const okTok =
        raw.includes("<<SEO_TITLES>>") &&
        raw.includes("<<BODY>>") &&
        raw.includes("<<END>>");

      const okTitles = titles.length === 3 && titles.every((t) => t.includes(keyword1));
      const bodyCnt = countOccurrences(bodyText, keyword1);
      const okBody = bodyCnt >= 2 && bodyCnt <= 3;

      if (!(okTok && okTitles && okBody)) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "목표 키워드(본문 2~3회) / SEO 제목(3개 모두 키워드 포함) / 토큰 조건을 만족하는 결과 생성에 실패했습니다.",
          },
          { status: 502 }
        );
      }
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
        values: [
          [
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
          ],
        ],
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
        regionHint,
        sourcePcUrl,
        sourceTitle,
      },
      text: raw,
    });
  } catch (err: any) {
    console.error("🔥 generate-from-sheet error:", err?.message, err);
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
