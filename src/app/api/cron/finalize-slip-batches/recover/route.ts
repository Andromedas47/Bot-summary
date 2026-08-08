import type { NextRequest } from "next/server";
import { handleRecoverRequest } from "./recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handleRecoverRequest(req);
}
