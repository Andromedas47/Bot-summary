import { NextRequest } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { handleIgnoreRequest } from "./handler";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  return handleIgnoreRequest(req, supabase, createServiceClient());
}
