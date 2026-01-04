// app/page.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";

/* =====================
   Types
===================== */
type CenterOption = {
  centerId: string;
  name: string;
};

type SourcePostOption = {
  title: string;
  pcUrl: string;
  service?: string; // ✅ 추가 (API가 내려주면 보관용)
};

type ParsedOutput = {
  titles: string;
  body: string;
  raw: string;
};

/* =====================
   Services (J열 분기)
===================== */
const SERVICES = ["주간보호", "방문요양", "가족요양", "장기요양등급", "요양보호사"] as const;
type ServiceType = (typeof SERVICES)[number];

/* =====================
   Utils
===================== */
function parseGeneratedText(raw: string): ParsedOutput {
  const s = (raw ?? "").replace(/\r\n/g, "\n").trim();

  const getBetween = (start: string, end: string) => {
    const i = s.indexOf(start);
    if (i < 0) return "";
    const j = s.indexOf(end, i + start.length);
    if (j < 0) return "";
    return s.slice(i + start.length, j).trim();
  };

  const titles = getBetween("<<SEO_TITLES>>", "<<BODY>>");
  const body = getBetween("<<BODY>>", "<<END>>");

  return {
    titles: titles.trim(),
    body: formatBodyForReadability(body.trim()),
    raw: s,
  };
}

/**
 * 화면 가독성용 줄바꿈 보정:
 * - 한 줄로 뭉친 경우 1.~4. 앞을 강제로 나눔
 * - 과도한 줄바꿈은 2줄까지만 유지
 */
function formatBodyForReadability(body: string) {
  if (!body) return "";
  let t = body.replace(/\r\n/g, "\n");

  // 공백/탭 정리 (줄바꿈은 보존)
  t = t.replace(/[ \t]+/g, " ").trim();

  // 한 줄로 온 경우: 소제목(1.~4.) 앞을 강제로 나눔
  if (!t.includes("\n")) {
    t = t.replace(/\s([1-4]\.)\s/g, "\n\n$1 ");
  }

  // 소제목 앞은 항상 2줄 띄움
  t = t.replace(/\n(\d\.)\s*/g, "\n\n$1 ");

  // 과도한 줄바꿈 정리
  t = t.replace(/\n{4,}/g, "\n\n").trim();

  return t;
}

/* =====================
   Field UI
===================== */
function Field(props: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-4">
      <div>
        <div className="text-xl font-semibold text-slate-900">{props.label}</div>
        {props.desc ? <div className="mt-1 text-lg leading-8 text-slate-600">{props.desc}</div> : null}
      </div>
      {props.children}
    </div>
  );
}

const inputClass =
  "w-full rounded-xl border border-rose-200 bg-white px-4 py-4 text-lg text-slate-900 " +
  "outline-none focus:ring-4 focus:ring-rose-100 focus:border-rose-300";

/* =====================
   Page
===================== */
export default function Page() {
  const [centers, setCenters] = useState<CenterOption[]>([]);
  const [sources, setSources] = useState<SourcePostOption[]>([]);

  const [centerId, setCenterId] = useState(""); // 빈 값이면 "선택해주세요" 상태
  const [keyword1, setKeyword1] = useState("");
  const [service, setService] = useState<ServiceType | "">(""); // ✅ 추가
  const [sourcePcUrl, setSourcePcUrl] = useState(""); // 빈 값이면 "선택해주세요" 상태

  const [centersErr, setCentersErr] = useState("");
  const [sourcesErr, setSourcesErr] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [parsed, setParsed] = useState<ParsedOutput>({ titles: "", body: "", raw: "" });

  const [copiedTitleIndex, setCopiedTitleIndex] = useState<number | null>(null);
  const [copiedBody, setCopiedBody] = useState(false);

  const canSubmit = useMemo(() => {
    // ✅ 서비스도 선택되어야 submit 가능
    return Boolean(centerId && keyword1.trim() && service && sourcePcUrl);
  }, [centerId, keyword1, service, sourcePcUrl]);

  const titleList = useMemo(() => {
    return parsed.titles
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 3);
  }, [parsed.titles]);

  const selectedSourceTitle = useMemo(() => {
    const s = sources.find((x) => x.pcUrl === sourcePcUrl);
    return s?.title ?? "";
  }, [sources, sourcePcUrl]);

  /* =====================
     Fetch centers (robust)
  ===================== */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setCentersErr("");

        const res = await fetch("/api/centers", { cache: "no-store" });
        const json = await res.json();

        if (!res.ok) {
          if (!cancelled) setCentersErr(`HTTP ${res.status} - /api/centers`);
          return;
        }
        if (json?.ok === false) {
          if (!cancelled) setCentersErr(json?.error ?? "centers: ok=false");
          return;
        }

        // ✅ 어떤 형태든 배열만 안전하게 꺼내기
        const list =
          (json?.items ??
            json?.data ??
            json?.centers ??
            json?.rows ??
            (Array.isArray(json) ? json : [])) as any[];

        if (!Array.isArray(list) || list.length === 0) {
          const keys = json && typeof json === "object" ? Object.keys(json).join(", ") : String(typeof json);
          if (!cancelled) setCentersErr(`센터 목록을 찾지 못했어요. 응답 key: ${keys}`);
          if (!cancelled) setCenters([]);
          return;
        }

        const pick = (obj: any, keys: string[]) => {
          for (const k of keys) {
            const v = obj?.[k];
            if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
          }
          return "";
        };

        const cleaned: CenterOption[] = list
          .map((c) => ({
            centerId: pick(c, ["centerId", "id", "센터ID", "센터 Id", "센터 아이디"]),
            name: pick(c, ["name", "centerName", "센터명", "기관명", "운영상 기관명 (해당 셀 메모 필독)", "운영상 기관명"]),
          }))
          .filter((c) => c.centerId && c.name);

        if (!cancelled) setCenters(cleaned);

        if (!cleaned.length) {
          const sampleKeys = list[0] ? Object.keys(list[0]).join(", ") : "(first item 없음)";
          if (!cancelled) setCentersErr(`센터 파싱 결과 0개예요. 첫 아이템 키: ${sampleKeys}`);
          return;
        }

        // ✅ 기본 선택값 자동 지정하지 않음 (placeholder를 기본으로 유지)
      } catch (e: any) {
        if (!cancelled) setCentersErr(e?.message ?? "centers fetch error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /* =====================
     Fetch source posts (서비스 선택 후)
  ===================== */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // 서비스 바뀌면 원고/선택 초기화
        setSources([]);
        setSourcePcUrl("");
        setSourcesErr("");

        if (!service) return; // ✅ 서비스 선택 전이면 아무것도 안 불러옴

        const res = await fetch(`/api/source-posts?limit=400&service=${encodeURIComponent(service)}`, {
          cache: "no-store",
        });
        const json = await res.json();

        if (!res.ok) {
          if (!cancelled) setSourcesErr(`HTTP ${res.status} - /api/source-posts`);
          if (!cancelled) setSources([]);
          return;
        }
        if (json?.ok === false) {
          if (!cancelled) setSourcesErr(json?.error ?? "source-posts: ok=false");
          if (!cancelled) setSources([]);
          return;
        }

        const items = (json?.items ??
          json?.data ??
          json?.posts ??
          (Array.isArray(json) ? json : [])) as any[];

        const cleaned: SourcePostOption[] = (items || [])
          .map((p: any) => ({
            title: (p?.title ?? "").toString().trim(),
            pcUrl: (p?.pcUrl ?? p?.url ?? p?.link ?? "").toString().trim(),
            service: (p?.service ?? "").toString().trim(),
          }))
          .filter((p) => p.title && p.pcUrl); // ✅ service는 서버에서 이미 빈값 제외 처리

        if (!cancelled) setSources(cleaned);

        if (!cleaned.length) {
          if (!cancelled) setSourcesErr("해당 카테고리에 원본 원고가 0개예요. (posts_full J열 값 확인 필요)");
          return;
        }

        // ✅ 기본 선택값 자동 지정하지 않음 (placeholder 유지)
      } catch (e: any) {
        if (!cancelled) setSourcesErr(e?.message ?? "source-posts fetch error");
        if (!cancelled) setSources([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [service]);

  /* =====================
     Generate
  ===================== */
  async function onGenerate() {
    setError("");
    setParsed({ titles: "", body: "", raw: "" });

    if (!canSubmit) {
      setError("센터/키워드/카테고리/참고 포스팅을 모두 선택해 주세요.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/generate-from-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ centerId, keyword1, sourcePcUrl }),
      });

      const json = await res.json();

      if (!res.ok || json?.ok === false) {
        setError(json?.error ?? `생성 실패 (HTTP ${res.status})`);
        return;
      }

      const rawText = String(json?.text ?? "");
      setParsed(parseGeneratedText(rawText));
    } catch (e: any) {
      setError(e?.message ?? "요청 중 오류가 발생했어요.");
    } finally {
      setLoading(false);
    }
  }

  async function copyBody() {
    if (!parsed.body) return;
    await navigator.clipboard.writeText(parsed.body);
    setCopiedBody(true);
    setTimeout(() => setCopiedBody(false), 2000);
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-rose-50 via-pink-50 to-white">
      <div className="mx-auto max-w-5xl px-6 py-10">
        {/* 헤더 */}
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/70 px-3 py-1 text-base font-medium text-rose-700 ring-1 ring-rose-200">
            케어링 블로그
          </div>
          <h1 className="mt-3 text-4xl font-extrabold tracking-tight text-slate-900">
            블링이 (블로그 작성해주는 아링이)
          </h1>
          <p className="mt-2 max-w-3xl text-lg leading-8 text-slate-600">
            기존 원고를 선택하면, 우리 센터 정보로 자연스럽게 편집·재작성된 정보성 원고가 생성돼요.
          </p>
        </div>

        {/* 입력 카드 */}
        <section className="rounded-2xl bg-white/80 p-6 shadow-sm ring-1 ring-rose-200 backdrop-blur">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {/* 센터 */}
            <Field label="센터 선택" desc="센터 정보를 기준으로 문구가 자동 반영돼요.">
              <select className={inputClass} value={centerId} onChange={(e) => setCenterId(e.target.value)}>
                <option value="">{centers.length ? "센터를 선택해주세요" : "센터 불러오는 중..."}</option>
                {centers.map((c) => (
                  <option key={c.centerId} value={c.centerId}>
                    {c.name}
                  </option>
                ))}
              </select>

              {centersErr ? (
                <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-base text-rose-700">
                  센터 불러오기/파싱 오류: {centersErr}
                </div>
              ) : null}
            </Field>

            {/* 키워드 */}
            <Field label="목표 키워드 (1개)" desc="본문에 2~3회 자연스럽게 포함돼요.">
              <input
                className={inputClass}
                value={keyword1}
                onChange={(e) => setKeyword1(e.target.value)}
                placeholder="예: 강동구 방문요양"
              />
            </Field>

            {/* ✅ 카테고리(서비스) 선택 - 추가 (UI 스타일 그대로) */}
            <Field label="카테고리 선택" desc="">
              <select className={inputClass} value={service} onChange={(e) => setService(e.target.value as any)}>
                <option value="">카테고리를 선택해주세요</option>
                {SERVICES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>

            {/* 원본 원고 (가로로 길게) */}
            <div className="md:col-span-2">
              <Field label="변형할 원고 선택" desc="지역명은 우리 센터에 맞게 알아서 변경됩니다!">
                <select
                  className={inputClass}
                  value={sourcePcUrl}
                  onChange={(e) => setSourcePcUrl(e.target.value)}
                  disabled={!service}
                >
                  <option value="">
                    {!service
                      ? "먼저 카테고리를 선택해주세요"
                      : sources.length
                      ? "참고할 포스팅을 선택해주세요"
                      : "포스팅 불러오는 중..."}
                  </option>

                  {sources.map((p) => (
                    <option key={p.pcUrl} value={p.pcUrl}>
                      {p.title}
                    </option>
                  ))}
                </select>

                {sourcesErr ? (
                  <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-base text-rose-700">
                    원고 목록 불러오기/파싱 오류: {sourcesErr}
                  </div>
                ) : null}

                {selectedSourceTitle ? (
                  <p className="mt-2 text-base text-slate-600">
                    선택됨: <span className="font-semibold text-slate-800">{selectedSourceTitle}</span>
                  </p>
                ) : null}
              </Field>
            </div>
          </div>

          <div className="mt-8">
            <button
              onClick={onGenerate}
              disabled={!canSubmit || loading}
              className={[
                "inline-flex w-full items-center justify-center rounded-xl px-7 py-4 text-lg font-semibold text-white",
                "bg-gradient-to-r from-rose-500 to-pink-500 shadow-sm",
                "hover:from-rose-600 hover:to-pink-600",
                "disabled:opacity-40 disabled:cursor-not-allowed",
                "focus:outline-none focus:ring-4 focus:ring-rose-200",
              ].join(" ")}
            >
              {loading ? "생성 중..." : "원고 생성하기"}
            </button>

            {error ? (
              <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-base text-rose-700">
                {error}
              </div>
            ) : null}
          </div>
        </section>

        {/* 결과: 제목 */}
        <section className="mt-8 rounded-2xl bg-white/80 p-6 shadow-sm ring-1 ring-rose-200 backdrop-blur">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-2xl font-bold text-slate-900">블링이 제목 추천 (3개)</h2>
          </div>

          {titleList.length === 0 ? (
            <div className="rounded-xl border border-rose-200 bg-white px-4 py-4 text-lg text-slate-500">
              제목 3개가 여기에 표시됩니다.
            </div>
          ) : (
            <div className="grid gap-3">
              {titleList.map((title, idx) => {
                const isCopied = copiedTitleIndex === idx;

                return (
                  <div
                    key={`${idx}-${title}`}
                    className="flex items-center justify-between gap-4 rounded-xl border border-rose-200 bg-white px-4 py-3"
                  >
                    <div className="text-lg text-slate-900">{title}</div>

                    <button
                      className={[
                        "rounded-lg px-4 py-2 text-base font-semibold transition",
                        isCopied
                          ? "border border-rose-200 bg-white text-rose-700"
                          : "bg-gradient-to-r from-rose-500 to-pink-500 text-white shadow-sm hover:from-rose-600 hover:to-pink-600",
                        "focus:outline-none focus:ring-4 focus:ring-rose-200",
                      ].join(" ")}
                      onClick={async () => {
                        await navigator.clipboard.writeText(title);
                        setCopiedTitleIndex(idx);
                        setTimeout(() => setCopiedTitleIndex(null), 2000);
                      }}
                    >
                      {isCopied ? "복사되었습니다!" : "복사"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* 결과: 본문 */}
        <section className="mt-6 rounded-2xl bg-white/80 p-6 shadow-sm ring-1 ring-rose-200 backdrop-blur">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-2xl font-bold text-slate-900">블링이 생성 원고 (본문)</h2>

            <button
              className={[
                "rounded-lg px-4 py-2 text-base font-semibold transition",
                copiedBody
                  ? "border border-rose-200 bg-white text-rose-700"
                  : "bg-gradient-to-r from-rose-500 to-pink-500 text-white shadow-sm hover:from-rose-600 hover:to-pink-600",
                "disabled:opacity-40 disabled:cursor-not-allowed",
                "focus:outline-none focus:ring-4 focus:ring-rose-200",
              ].join(" ")}
              onClick={async () => {
                await copyBody();
              }}
              disabled={!parsed.body}
            >
              {copiedBody ? "복사되었습니다!" : "복사"}
            </button>
          </div>

          <textarea
            className={[
              "min-h-[600px] w-full rounded-xl border border-rose-200 bg-white p-4",
              "text-lg leading-9 text-slate-900 outline-none",
              "focus:ring-4 focus:ring-rose-100",
            ].join(" ")}
            value={parsed.body}
            onChange={(e) => setParsed((p) => ({ ...p, body: e.target.value }))}
            placeholder="본문이 여기에 표시됩니다."
          />
        </section>
      </div>
    </main>
  );
}
