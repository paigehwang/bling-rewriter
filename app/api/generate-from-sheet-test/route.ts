import { NextResponse } from "next/server";

export async function GET() {
  const res = await fetch("http://localhost:3000/api/generate-from-sheet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      centerId: "center_1",
      contentType: "후기성",
      service: "가족요양",
      keyword1: "가족요양",
      keyword2: "치매",
      variation: 0,
    }),
  });

  const data = await res.json();
  return NextResponse.json(data);
}
