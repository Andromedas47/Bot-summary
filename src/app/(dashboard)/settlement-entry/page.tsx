import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { SettlementForm } from "@/components/settlement-entry/SettlementForm";
import { createServiceClient } from "@/lib/supabase/server";

interface PageProps {
  searchParams: Promise<{
    date?:   string;
    market?: string;
    seller?: string;
  }>;
}

export default async function SettlementEntryPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { date, market, seller } = params;

  let initial: {
    moneyTransfer: number;
    moneyCash:     number;
    expenses:      number;
    labor:         number;
    notes:         string;
    sourceId?:     string;
  } | undefined;

  if (date && market && seller) {
    const supabase = await createServiceClient();
    const [{ data }, sourceId] = await Promise.all([
      supabase
        .from("settlement_entries")
        .select("money_transfer, money_cash, expenses, labor, notes")
        .eq("settlement_date", date)
        .eq("settlement_time", "")
        .eq("staff_name", seller)
        .eq("market_name", market)
        .maybeSingle(),
      findSourceIdForContext(supabase, { date, market, seller }),
    ]);

    if (data) {
      initial = {
        moneyTransfer: (data as { money_transfer: number }).money_transfer,
        moneyCash:     (data as { money_cash: number }).money_cash,
        expenses:      (data as { expenses: number }).expenses ?? 0,
        labor:         (data as { labor: number }).labor ?? 0,
        notes:         (data as { notes: string }).notes ?? "",
        sourceId,
      };
    } else {
      initial = {
        moneyTransfer: 0,
        moneyCash:     0,
        expenses:      0,
        labor:         0,
        notes:         "",
        sourceId,
      };
    }
  }

  return (
    <>
      <DashboardTopBar title="รายการส่งเงิน" />

      <div className="p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle>รายการส่งเงิน</CardTitle>
            <p className="text-sm text-slate-500 mt-0.5">
              กรอกยอดโอน เงินสด ค่าใช้จ่าย และค่าแรง แล้วกดบันทึกเพื่อแจ้ง LINE ของกลุ่มนั้น
            </p>
          </CardHeader>
          <CardContent>
            <SettlementForm
              initial={{
                date:          date   ?? "",
                market:        market ?? "",
                seller:        seller ?? "",
                moneyTransfer: initial?.moneyTransfer ?? 0,
                moneyCash:     initial?.moneyCash     ?? 0,
                expenses:      initial?.expenses      ?? 0,
                labor:         initial?.labor         ?? 0,
                notes:         initial?.notes         ?? "",
                sourceId:      initial?.sourceId,
              }}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function validSourceId(sourceId: string | null | undefined): string | null {
  return sourceId && sourceId !== "unknown" ? sourceId : null;
}

async function findSourceIdForContext(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  params: { date: string; market: string; seller: string },
): Promise<string | undefined> {
  const { data: transactions, error } = await supabase
    .from("produce_transactions")
    .select("raw_message_id")
    .eq("transaction_date", params.date)
    .eq("market_name", params.market)
    .eq("staff_name", params.seller);

  if (error) throw new Error(error.message);

  const rawMessageIds = Array.from(new Set(
    (transactions ?? [])
      .map(row => row.raw_message_id as string | null)
      .filter((id): id is string => Boolean(id)),
  ));
  if (rawMessageIds.length === 0) return undefined;

  const { data: rawMessages, error: rawError } = await supabase
    .from("raw_messages")
    .select("source_id")
    .in("id", rawMessageIds);

  if (rawError) throw new Error(rawError.message);

  const sourceIds = new Set<string>();
  for (const row of rawMessages ?? []) {
    const sourceId = validSourceId(row.source_id as string | null);
    if (sourceId) sourceIds.add(sourceId);
  }

  return sourceIds.size === 1 ? [...sourceIds][0] : undefined;
}
