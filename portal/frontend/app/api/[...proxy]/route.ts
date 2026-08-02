import { NextResponse } from "next/server";

// Catch-all for /api/* requests that don't match NextAuth routes.
// When deployed without the backend (e.g. Vercel demo), return
// structured JSON instead of an HTML 404 page.
export async function GET() {
  return NextResponse.json(
    { error: "Backend not connected", demo: true },
    { status: 503 }
  );
}

export async function POST() {
  return NextResponse.json(
    { error: "Backend not connected", demo: true },
    { status: 503 }
  );
}
