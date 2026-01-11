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
 * [기능 업데이트] 화면 가독성용 줄바꿈 보정 (따옴표 버그 수정됨)
 * - 문장 끝(다/요/죠/까 + 마침표/물음표/느낌표) 뒤에 줄바꿈 2개 강제
 * - 단, 뒤에 따옴표(', ", ’)가 있으면 줄바꿈 하지 않음 (Negative Lookahead)
 */
function formatBodyForReadability(body: string) {
  if (!body) return "";
  let t = body.replace(/\r\n/g, "\n");

  // 공백/탭 정리
  t = t.replace(/[ \t]+/g, " ").trim();

  // ✅ [수정됨] 따옴표 안에서 줄바꿈 방지 로직 적용
  t = t.replace(/([다요죠까])([.?!])(?![’”"'])\s*/g, "$1$2\n\n");

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

  // 제목 앞 번호 제거 로직 유지
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