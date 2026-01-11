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
  service?: string; 
};

type ParsedOutput = {
  titles: string;
  body: string;
  raw: string;
};

/* =====================
   Services
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
 * [기능 업데이트] 화면 가독성용 줄바꿈 보정
 * - 문장 끝(다/요/죠/까 + 마침표/물음표/느낌표) 뒤에 줄바꿈 2개 강제
 */
function formatBodyForReadability(body: string) {
  if (!body) return "";
  let t = body.replace(/\r\n/g, "\n");

  // 공백/탭 정리
  t = t.replace(/[ \t]+/g, " ").trim();

  // 문장 끝나는 지점 뒤에 줄바꿈 2개 강제 삽입
  t = t.replace(/([다요죠까])([.?!])\s*/g, "$1$2\n\n");

  // 소제목 앞은 항상 2줄 띄움
  t = t.replace(/\n*(\d\.)\s*/g, "\n\n$1 ");

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

  const [centerId, setCenterId] = useState(""); 
  const [keyword1, setKeyword1] = useState("");
  const [service, setService] = useState<ServiceType | "">(""); 
  const [sourcePcUrl, setSourcePcUrl] = useState(""); 

  const [centersErr, setCentersErr] = useState("");
  const [sourcesErr, setSourcesErr] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [parsed, setParsed] = useState<ParsedOutput>({ titles: "", body: "", raw: "" });

  const [copiedTitleIndex, setCopiedTitleIndex] = useState<number | null>(null);
  const [copiedBody, setCopiedBody] = useState(false);

  const canSubmit = useMemo(() => {
    return Boolean(centerId && keyword1.trim() && service && sourcePcUrl);
  }, [centerId, keyword1, service, sourcePcUrl]);

  // [기능 업데이트] 제목 앞 번호(1. 2. 1)) 제거 로직 적용
  const titleList = useMemo(() => {
    return parsed.titles
      .split("\n")
      .map((t) => t.trim().replace(/^\d+[\.\)]\s*/, "")) 
      .filter(Boolean)
      .slice(0, 3);
  }, [parsed.titles]);

  const selectedSourceTitle = useMemo(() => {
    const s = sources.find((x) => x.pcUrl === sourcePcUrl);
    return s?.title ?? "";
  }, [sources, sourcePcUrl]);

  /* =====================
      Fetch centers
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

        const list = (json?.items ?? json?.data ?? json?.centers ?? []) as any[];
        
        const cleaned: CenterOption[] = list
          .map((c) => ({
            centerId: c.centerId || c["센터ID"],
            name: c.name || c.centerName,
          }))
          .filter((c) => c.centerId && c.name);

        if (!cancelled) setCenters(cleaned);
      } catch (e: any) {
        if (!cancelled) setCentersErr(e?.message ?? "centers fetch error");
      }
    })();

    return () => { cancelled = true; };
  }, []);

  /* =====================
      Fetch source posts
  ===================== */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setSources([]);
        setSourcePcUrl("");
        setSourcesErr("");

        if (!service) return;

        const res = await fetch(`/api/source-posts?limit=400&service=${encodeURIComponent(service)}`, {
          cache: "no-store",
        });
        const json = await res.json();

        if (!res.ok) {
          if (!cancelled) setSourcesErr(`HTTP ${res.status} - /api/source-posts`);
          return;
        }
        if (json?.ok === false) {
          if (!cancelled) setSourcesErr(json?.error ?? "source-posts: ok=false");
          return;
        }

        const items = (json?.items ?? []) as any[];
        const cleaned: SourcePostOption[] = items
          .map((p: any) => ({
            title: (p?.title ?? "").toString().trim(),
            pcUrl: (p?.pcUrl ?? "").toString().trim(),
            service: (p?.service ?? "").toString().trim(),
          }))
          .filter((p) => p.title && p.pcUrl);

        if (!cancelled) setSources(cleaned);
      } catch (e: any) {
        if (!cancelled) setSourcesErr(e?.message ?? "source-posts fetch error");
      }
    })();

    return () => { cancelled = true; };
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
        // [기능 업데이트] service 정보 추가 전송
        body: JSON.stringify({ centerId, keyword1, sourcePcUrl, service }),
      });

      const json = await res.json();

      if (!res.ok || json?.ok === false) {
        setError(json?.error ?? `생성 실패 (HTTP ${res.status})`);
        return;
      }

      setParsed(parseGeneratedText(json?.text ?? ""));
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
        {/* 헤더 (기존 UI 유지) */}
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/70 px-3 py-1 text-base font-medium text-rose-700 ring-1 ring-rose-200">
            케어링 블로그
          </div>
          <h1 className="mt-3 text-4xl font-extrabold tracking-tight text-slate-900">
            블링이 (블로그 작성해주는 아링이)✨
          </h1>
          <p className="mt-2 max-w-3xl text-lg leading-8 text-slate-600">
            기존 원고를 선택하면, 우리 센터 정보로 자연스럽게 편집·재작성된 정보성 원고가 생성돼요.
          </p>
        </div>

        {/* 입력 카드 */}
        <section className="rounded-2xl bg-white/80 p-6 shadow-sm ring-1 ring-rose-200 backdrop-blur">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <Field label="센터 선택" desc="센터 정보를 기준으로 문구가 자동 반영돼요.">
              <select className={inputClass} value={centerId} onChange={(e) => setCenterId(e.target.value)}>
                <option value="">{centers.length ? "센터를 선택해주세요" : "센터 불러오는 중..."}</option>
                {centers.map((c) => (
                  <option key={c.centerId} value={c.centerId}>
                    {c.name}
                  </option>
                ))}
              </select>
              {centersErr && <div className="mt-3 text-rose-700">{centersErr}</div>}
            </Field>

            <Field label="목표 키워드 (1개)" desc="본문에 2~3회 자연스럽게 포함돼요.">
              <input
                className={inputClass}
                value={keyword1}
                onChange={(e) => setKeyword1(e.target.value)}
                placeholder="예: 강동구 방문요양"
              />
            </Field>

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
                {sourcesErr && <div className="mt-3 text-rose-700">{sourcesErr}</div>}
                {selectedSourceTitle && (
                  <p className="mt-2 text-base text-slate-600">
                    선택됨: <span className="font-semibold text-slate-800">{selectedSourceTitle}</span>
                  </p>
                )}
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
              {/* [요청하신 문구로 변경 완료] */}
              {loading ? "블링이가 원고를 열심히 작성하고 있어요...✨ (약 30-40초)" : "원고 생성하기"}
            </button>

            {error && (
              <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-base text-rose-700">
                {error}
              </div>
            )}
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