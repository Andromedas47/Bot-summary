import { createClient } from "@/lib/supabase/server";
import { TopBar } from "./TopBar";

interface DashboardTopBarProps {
  title: string;
}

export async function DashboardTopBar({ title }: DashboardTopBarProps) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  return <TopBar title={title} userEmail={user?.email} />;
}
