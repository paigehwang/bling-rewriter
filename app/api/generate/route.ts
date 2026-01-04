import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { sheetsGetValues } from "@/lib/sheets";

/* =====================
   Sheet Ranges
===================== */
const TOPIC_RANGE = "주제!A:E";
const POSTS_RANGE = "posts_full!A:F"; // B=title, F=contentText

const SSOT_TABS_BY_SERVICE: Record<string, string[]> = {
  주간보호: ["월한도액", "주간보호수가", "주간보호본부금", "급여"],
  방문요양: ["월한도액", "방문요양수가", "방문요양본부금", "급여"],
  가족요양: ["월한도액", "급여"],
  장기요양등급: ["월한도액", "급여"],
};

/* =====================
   Utils
===================== */
function scorePost(title: string, body: string, keywords: string[]) {
  const t = (title ?? "").toLowerCase();
  const b = (body ?? "").toLowerCase();
  let score = 0;

  for (const kw of keywords) {
    const k = kw.toLowerCase().trim();
    if (!k) continue;
    if (t.includes(k)) score += 3;
    if (b.includes(k)) score += 1;
  }

  if ((body?.length ?? 0) < 1200) score -= 5;
  return score;
}

function trimForModel(text: string, maxChars = 2200) {
  const s = (text ?? "").replace(/\s+\n/g, "\n").trim();
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

function countIncludes(text: string, keyword: string) {
  if (!text || !keyword) return 0;
  return text.split(keyword).length - 1;
}

function toSsotFactsBlock(ssotData: { tab: string; rows: string[][] }[]) {
  return ssotData
    .map(({ tab, rows }) => {
      const limited = rows.slice(0, 30).map((r) => r.join("\t")).join("\n");
      return `${tab}\n${limited}`;
    })
    .join("\n\n");
}

function pickTopicByTag(rows: string[][], topic_tag: string) {
  const [header, ...data] = rows;
  const idx = (name: string) => header.indexOf(name);

  return (
    data
      .map((r) => ({
        topic_id: r[idx("topic_id")] ?? "",
        service: r[idx("service")] ?? "",
        topic_tag: r[idx("topic_tag")] ?? "",
        display_name: r[idx("display_name")] ?? "",
        keywords: (r[idx("keywords")] ?? "")
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean),
      }))
      .find((t) => t.topic_tag === topic_tag) ?? null
  );
}

/* =====================
   API
===================== */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));

    // legacy support
    const prompt: string | undefined = body?.prompt;

    // new mode inputs
    const centerName = (body?.centerName ?? "").trim();
    const service = (body?.service ?? "").trim();
    const topic_tag = (body?.topic_tag ?? "").trim();
    const targetKeyword1 = (body?.targetKeyword1 ?? "").trim();
    const targetKeyword2 = (body?.targetKeyword2 ?? "").trim();

    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({ ok: false, error: "Missing GEMINI_API_KEY" }, { status: 500 });
    }

    const isNewMode = !!(centerName && service && topic_tag && targetKeyword1);

    if (!isNewMode && (!prompt || typeof prompt !== "string")) {
      return NextResponse.json(
        { ok: false, error: "Missing prompt or required fields" },
        { status: 400 }
      );
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    /* =====================
       Legacy Mode
    ===================== */
    if (!isNewMode) {
      const legacyPrompt = `
한국어로 작성.
500자 이내.
과장/의료판단 금지.
마지막 문단에 1522-6585 포함.

요청: ${prompt}
      `.trim();

      const res = await model.generateContent(legacyPrompt);
      return NextResponse.json({
        ok: true,
        text: res.response.text().trim(),
        mode: "legacy",
      });
    }

    /* =====================
       New Mode (Blingi)
    ===================== */

    // 1. topic
    const topicRows = await sheetsGetValues({ range: TOPIC_RANGE });
    const topic = pickTopicByTag(topicRows, topic_tag);
    if (!topic) {
      return NextResponse.json({ ok: false, error: "Invalid topic_tag" }, { status: 400 });
    }

    const topicName = topic.display_name;
    const keywords = topic.keywords ?? [];

    // 2. posts_full 최신 50개
    const postRows = await sheetsGetValues({ range: POSTS_RANGE });
    const posts = postRows.slice(1);
    const last50 = posts.slice(-50);

    // 3. 레퍼런스 엄격 필터
    const filteredRefs = last50.filter((r) => {
      const title = r[1] ?? "";
      const body = r[5] ?? "";

      if (!title.includes(service)) return false;
      if (countIncludes(body, service) < 3) return false;
      if (countIncludes(body, topicName) < 2) return false;

      return true;
    });

    const topRefs = filteredRefs
      .map((r) => ({
        title: r[1] ?? "",
        contentText: r[5] ?? "",
        score: scorePost(r[1] ?? "", r[5] ?? "", keywords),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    // 4. extract outline + facts
    const extractPrompt = `
너는 표절 방지 편집자다.

규칙:
- 문장/서술 방식 차용 금지
- 숫자/금액/비율 절대 추출 금지
- 정보/개념/절차/주의사항만 추출

출력 형식:

[OUTLINE]
- 소제목은 정확히 4개만 제안한다.
- 각 소제목은 글의 큰 흐름을 대표한다.
- 소제목 아래에는 포함해야 할 핵심 포인트를 불릿으로 정리한다.
- 번호형(1~4) 기준으로 생각한다.

[REFERENCE_FACTS]
- 숫자를 제외한 정보성 팩트만 불릿으로 정리

입력:
서비스: ${service}
주제: ${topicName}
타깃 키워드1: ${targetKeyword1}
타깃 키워드2: ${targetKeyword2 || "(없음)"}

[REFERENCES]
${topRefs
  .map((p, i) => `#${i + 1} ${p.title}\n${trimForModel(p.contentText)}`)
  .join("\n\n")}
    `.trim();

    const extractRes = await model.generateContent(extractPrompt);
    const extracted = extractRes.response.text().trim();

    const outline =
      extracted.match(/\[OUTLINE\]([\s\S]*?)\[REFERENCE_FACTS\]/)?.[1]?.trim() ?? "";
    const referenceFacts =
      extracted.match(/\[REFERENCE_FACTS\]([\s\S]*)$/)?.[1]?.trim() ?? "";

    // 5. SSOT
    const ssotTabs = SSOT_TABS_BY_SERVICE[service] ?? ["월한도액", "급여"];
    const ssotData = await Promise.all(
      ssotTabs.map(async (tab) => ({
        tab,
        rows: await sheetsGetValues({ range: `${tab}!A:Z` }),
      }))
    );
    const ssotFacts = toSsotFactsBlock(ssotData);

    // 6. final generation (최종 품질 제어)
    const finalPrompt = `
[중요 제약]
- 이 글은 "${service}" 서비스에 대한 정보성 글이다.
- 제목/본문/소제목에는
  1) "${service}"
  2) 타깃 키워드1 또는 타깃 키워드2에 포함된 서비스명
  만 등장할 수 있다.
- 사용자가 입력하지 않은 다른 서비스는 절대 언급하지 않는다.
- "[SSOT_DATA]"라는 문자열이나 이를 연상시키는 표현을 절대 사용하지 않는다.
- SSOT를 직접 언급하거나 회피하는 문장은 사용하지 않는다.

[센터 규칙]
- 센터 정보는 제공된 정보만 사용한다.
- 주소/전화번호/기관 규모를 추정하거나 생성하지 않는다.

[서식 규칙]
- 마크다운 강조(**) 사용 금지
- ####, ### 사용 금지
- 소제목은 번호형 4개만 사용한다.

[구조 규칙]
- 본문은 반드시 인트로 문단으로 시작한다.
- 인트로는 소제목보다 앞에 위치하며 3~4문장으로 작성한다.
- 인트로에서는 "${topicName}"의 중요성과 "${service}" 서비스가 필요한 상황을 설명한다.
- 인트로에는 번호형 소제목을 사용하지 않는다.

- 인트로 이후에만 아래 소제목 구조를 사용한다:
  1. 소제목
  2. 소제목
  3. 소제목
  4. 소제목

- 각 소제목 아래에는 2~3문단으로 충분히 설명한다.

- 본문 마지막에는 반드시 마무리 문단을 작성한다.
- 마무리 문단에는 다음 요소를 모두 포함한다:
  * 타깃 키워드1 (${targetKeyword1})
  * 타깃 키워드2 (${targetKeyword2 || "없음"})
  * 주제 (${topicName})
  * 서비스명 (${service})
- 과장되거나 기관 규모를 암시하는 표현은 사용하지 않는다.

[숫자 규칙]
- 숫자/금액/비율은 반드시 [SSOT_DATA]에서만 사용한다.
- SSOT에 없는 숫자는 아예 서술하지 않는다.

입력:
센터명: ${centerName}

[OUTLINE]
${outline}

[REFERENCE_FACTS]
${referenceFacts}

[SSOT_DATA]
${ssotFacts}

출력:
1) SEO 제목 3개
2) 인트로 + 본문 (번호형 소제목 4개)
3) 마무리 문단
4) 마지막 CTA에 "1522-6585" 포함
    `.trim();

    const result = await model.generateContent(finalPrompt);

    return NextResponse.json({
      ok: true,
      text: result.response.text().trim(),
      mode: "blingi",
      debug: {
        usedReferences: topRefs.map((r) => r.title),
        ssotTabs,
        topicName,
      },
    });
  } catch (err: any) {
    console.error("🔥 generate error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
