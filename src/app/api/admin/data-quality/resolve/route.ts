import { NextRequest } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { handleResolveRequest } from "./handler";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  return handleResolveRequest(req, supabase, createServiceClient());
}
