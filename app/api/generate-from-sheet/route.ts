// app/api/generate-from-sheet/route.ts

export const maxDuration = 60; 
export const dynamic = 'force-dynamic';

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

function getRegionHint(addr: string) {
  const a = normalize(addr);
  if (!a) return "";
  const tokens = a.split(/\s+/).filter(Boolean);
  return [tokens[0], tokens[1]].filter(Boolean).join(" ");
}

/* =====================
   Output Parsing & Guards
===================== */
function extractSeoTitles(raw: string) {
  const m = raw.match(/<<SEO_TITLES>>\s*([\s\S]*?)\s*<<BODY>>/);
  const block = (m?.[1] ?? "").trim();
  const lines = block.split("\n").map((x) => x.trim()).filter(Boolean);
  return lines.slice(0, 3);
}

function extractBody(raw: string) {
  const m = raw.match(/<<BODY>>\s*([\s\S]*?)\s*<<END>>/);
  return (m?.[1] ?? "").trim();
}

function replaceBody(raw: string, newBody: string) {
  return raw.replace(/(<<BODY>>\s*)([\s\S]*?)(\s*<<END>>)/, `$1${newBody}$3`);
}

function reduceKeywordToMax(body: string, keyword: string, max: number) {
  const k = keyword.trim();
  if (!k) return body;

  const positions: number[] = [];
  let idx = 0;
  while (true) {
    const hit = body.indexOf(k, idx);
    if (hit === -1) break;
    positions.push(hit);
    idx = hit + k.length;
  }
  if (positions.length <= max) return body;

  const removeCount = positions.length - max;
  let out = body;
  for (let i = 0; i < removeCount; i++) {
    const last = out.lastIndexOf(k);
    if (last === -1) break;
    out = out.slice(0, last) + out.slice(last + k.length);
  }

  out = out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

/**
 * [강력 보정] 키워드 개수가 부족하면 하단에 문구를 추가하여 강제로 맞춤
 */
function ensureKeywordCount(raw: string, keyword: string, tel: string, isRecruitment: boolean, min = 2, max = 3) {
  const k = keyword.trim();
  if (!k) return raw;

  const body = extractBody(raw);
  if (!body) return raw;

  const cnt = countOccurrences(body, k);
  let newBody = body;

  const heavyBottomRecruit = `\n\n${k} 관련하여 궁금한 점이 있으신가요? 저희는 선생님들의 열정을 응원하며, ${k}로서 자부심을 가지고 일하실 수 있도록 최선을 다합니다. ${tel}로 편하게 연락주세요.\n`;
  const heavyBottomInfo = `\n\n${k}에 대해 더 궁금하신 점이 있으시다면 언제든 문의주세요. 보호자님의 상황에 딱 맞는 ${k} 서비스를 안내해 드리겠습니다. 상담 전화는 ${tel}입니다.\n`;

  const lightBottomRecruit = `\n\n${k} 지원을 희망하시거나 근무 조건이 궁금하시다면 ${tel}로 편하게 연락주세요. 좋은 인연을 기다립니다.\n`;
  const lightBottomInfo = `\n\n${k} 관련하여 구체적인 상담이 필요하시다면 ${tel}로 편하게 전화 주셔요. 친절하게 안내해 드리겠습니다.\n`;

  const targetHeavy = isRecruitment ? heavyBottomRecruit : heavyBottomInfo;
  const targetLight = isRecruitment ? lightBottomRecruit : lightBottomInfo;

  if (cnt === 0) {
    newBody = newBody + targetHeavy;
  } else if (cnt < min) {
    newBody = newBody + targetLight;
  } 
  
  newBody = reduceKeywordToMax(newBody, k, max);
  
  if (!newBody.includes(tel)) {
      if (!newBody.trim().endsWith(targetLight.trim()) && !newBody.trim().endsWith(targetHeavy.trim())) { 
          newBody = newBody + targetLight;
      }
  }

  return replaceBody(raw, newBody);
}

const RANGE_POSTS = "posts_full!A:F"; 

/* =====================
   Main
===================== */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));

    const centerId = normalize(body?.centerId);
    const keyword1 = normalize(body?.keyword1);
    const sourcePcUrl = normalize(body?.sourcePcUrl);
    const service = normalize(body?.service); 

    if (!process.env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");
    const spreadsheetId = process.env.GOOGLE_SHEET_ID || process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId) throw new Error("Missing GOOGLE_SHEET_ID");

    if (!centerId || !keyword1 || !sourcePcUrl) throw new Error("Required fields missing");

    const isRecruitment = service === "요양보호사";
    const sheets = getSheetsClient();

    /* 1) 센터 정보 */
    const centerRows = await getValues(sheets, spreadsheetId, "센터정보!A1:Z2000");
    const idxId = findCol(centerRows, "센터ID");
    const idxName = findCol(centerRows, "운영상 기관명 (해당 셀 메모 필독)");
    const idxTel = findCol(centerRows, "전화번호");
    const idxAddr = findCol(centerRows, "행정상 주소지");

    if (idxId < 0) throw new Error("센터정보 시트 헤더 오류");
    const centerRow = centerRows.slice(1).find((r) => normalize(r[idxId]) === centerId);
    if (!centerRow) throw new Error(`센터ID 못찾음: ${centerId}`);

    const centerName = normalize(centerRow[idxName]);
    const tel = normalize(centerRow[idxTel]) || "1522-6585";
    const addr = normalize(centerRow[idxAddr]);
    const regionHint = getRegionHint(addr);

    /* 2) 원본 원고 */
    const postRows = await getValues(sheets, spreadsheetId, RANGE_POSTS);
    const posts = postRows.slice(1);
    const sourceRow = posts.find((r) => normalize(r[2]) === sourcePcUrl);
    if (!sourceRow) throw new Error(`원본 원고 못찾음: ${sourcePcUrl}`);

    const sourceTitle = normalize(sourceRow[1]);
    const sourceContent = normalize(sourceRow[5]);

    /* 3) Gemini 설정 */
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    /* 4) Prompt 구성 */
    const voiceBlock = isRecruitment
      ? `
[화자: ${centerName} 채용 담당자]
- 구직 중인 요양보호사 선생님들에게 "일하고 싶은 센터"라는 인상을 줍니다.
- 존중하는 태도(해요체)와 공감 능력을 발휘하세요.
`.trim()
      : `
[화자: ${centerName} 상담 센터장]
- 보호자에게 친절한 상담사가 공감하며 따뜻하게 말하듯 씁니다.
- 딱딱한 설명문이 아닌, 사람 냄새 나는 말투를 씁니다.
`.trim();

    const rewriteRule = isRecruitment
      ? `
[리라이팅 규칙 - 채용/구인 모드]
1) **대상**: 구직자/요양보호사 (보호자 대상 X)
2) **도입부**: "일자리 찾기 힘드시죠?" 등 고충에 공감하며 시작. (기계적 요약 금지)
3) **본문**: 센터의 좋은 근무 환경, 체계적인 시스템을 강조. (타 지역명은 ${centerName}(${regionHint})로 변경)
4) **결론**: 상담/면접 유도 (전화번호 필수)
`.trim()
      : `
[리라이팅 규칙 - 보호자 상담 모드]
1) **대상**: 보호자/가족 (구직자 대상 X)
2) **도입부**: 보호자의 걱정에 공감하며 자연스럽게 시작. (기계적 요약 금지)
3) **본문**: 어르신을 잘 모신다는 신뢰/케어 강점 강조. (타 지역명은 ${centerName}(${regionHint})로 변경)
4) **결론**: 등급/입소 상담 유도 (전화번호 필수)
`.trim();

    const seoRule = `
[SEO 필수 규칙 (어길 시 0점 처리)]
1) **SEO 제목**: 출력하는 3개의 제목 모두에 목표 키워드 '${keyword1}'를 토씨 하나 틀리지 않고 그대로 포함하세요. (동의어/변형 금지)
2) **본문 키워드**: 본문 내용 중에 목표 키워드 '${keyword1}'가 정확히 2회~3회 등장해야 합니다.
3) **소제목**: 소제목 4개 중 2개 이상에 ${centerName} 또는 ${regionHint}를 포함하세요.
`.trim();

    // ✅ [수정됨] 예시 텍스트에서 괄호 설명 모두 제거
    const formatRule = `
[출력 형식]
<<SEO_TITLES>>
(제목 3개)
<<BODY>>
(자연스러운 도입부 줄글)

1. 첫번째 소제목
(본문 내용)

2. 두번째 소제목
(본문 내용)
<<END>>

- 도입부(인트로)에는 번호를 붙이지 않습니다.
- 소제목부터 "1."을 붙여서 시작합니다.
`.trim();

    const finalPrompt = `
${voiceBlock}

${rewriteRule}

${seoRule}

${formatRule}

[센터 정보]
- 센터명: ${centerName}
- 전화: ${tel}
- 주소: ${addr}
- 지역: ${regionHint}

[목표 키워드]
- ${keyword1} (반드시 포함할 것!)

[원본 원고]
제목: ${sourceTitle}
${sourceContent}
`.trim();

    /* 4-1) Generate Loop */
    let raw = "";
    let bestResult = ""; 

    for (let attempt = 0; attempt < 5; attempt++) {
      let retryMsg = "";
      if (attempt > 0) {
        retryMsg = "\n\n[수정 요청]";
        retryMsg += " 1. SEO 제목 3개 모두에 키워드 '" + keyword1 + "'를 반드시 넣으세요.";
        retryMsg += " 2. 도입부(맨 처음)에 숫자 1.을 붙이지 마세요. 줄글로 시작하세요.";
        retryMsg += " 3. 결론에 전화번호(" + tel + ")를 넣으세요.";
        retryMsg += " 4. 센터명에 따옴표(')나 괄호()를 절대 붙이지 마세요.";
      }

      const result = await model.generateContent(finalPrompt + retryMsg);

      raw = stripMarkdown(result.response.text() || "");
      raw = raw.replace(/\b(AI|자동\s?생성|챗봇)\b/gi, "").trim();
      
      // ✅ [강력 필터] 센터명 정규화 (따옴표, 괄호 제거)
      raw = raw.replace(/\[\s*센터\s*정보\s*\]/g, `${centerName}`);
      
      // 1. 따옴표 제거
      const quotedCenter = new RegExp(`'${centerName}'`, "g");
      raw = raw.replace(quotedCenter, centerName);

      // 2. 괄호 제거: (케어링 부산점) -> 케어링 부산점
      const parenCenter = new RegExp(`\\(${centerName}\\)`, "g");
      raw = raw.replace(parenCenter, centerName);

      // 3. 기계적 텍스트 (본문) 같은거 제거
      raw = raw.replace(/\(본문\)/g, "").replace(/\(내용\)/g, "");

      bestResult = raw;

      const titles = extractSeoTitles(raw);
      const bodyText = extractBody(raw);

      const okTok = raw.includes("<<SEO_TITLES>>") && raw.includes("<<BODY>>");
      const okTitles = titles.length === 3 && titles.every((t) => t.includes(keyword1));
      
      const bodyCnt = countOccurrences(bodyText, keyword1);
      const okBody = bodyCnt >= 2 && bodyCnt <= 4; 
      
      const hasCenterName = raw.includes(centerName);
      const hasTel = raw.includes(tel);
      
      const badIntro = raw.slice(0, 100).includes("오늘") && raw.slice(0, 100).includes("준비");
      const numberedIntro = raw.includes("<<BODY>>") && extractBody(raw).trim().startsWith("1.");

      if (okTok && okTitles && okBody && hasCenterName && hasTel && !badIntro && !numberedIntro) {
        break; 
      }
    }

    // 최종 보정
    raw = ensureKeywordCount(bestResult, keyword1, tel, isRecruitment, 2, 3);

    /* 5) Log */
    const len = raw.length;
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Log!A:O",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          new Date().toISOString(), 
          centerId, 
          centerName, 
          "", 
          isRecruitment ? "채용(구인)" : "정보성(홍보)", 
          "", 
          keyword1, 
          "", 
          sourceTitle, 
          0, 
          len, 
          "", 
          "", 
          sourcePcUrl, 
          sourceTitle
        ]],
      },
    });

    return NextResponse.json({
      ok: true,
      meta: { centerId, centerName, keyword1, tel, addr },
      text: raw,
    });

  } catch (err: any) {
    console.error("🔥 Error:", err?.message);
    return NextResponse.json({ ok: false, error: err?.message }, { status: 500 });
  }
}