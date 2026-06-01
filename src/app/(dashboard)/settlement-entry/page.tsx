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

  let initial: { moneyTransfer: number; moneyCash: number; expenses: number; labor: number; notes: string } | undefined;

  if (date && market && seller) {
    const supabase = await createServiceClient();
    const { data } = await supabase
      .from("settlement_entries")
      .select("money_transfer, money_cash, expenses, labor, notes")
      .eq("settlement_date", date)
      .eq("settlement_time", "")
      .eq("staff_name", seller)
      .eq("market_name", market)
      .maybeSingle();

    if (data) {
      initial = {
        moneyTransfer: (data as { money_transfer: number }).money_transfer,
        moneyCash:     (data as { money_cash: number }).money_cash,
        expenses:      (data as { expenses: number }).expenses ?? 0,
        labor:         (data as { labor: number }).labor ?? 0,
        notes:         (data as { notes: string }).notes ?? "",
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
              }}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
