import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { WhiteSheetPageClient } from "@/components/white-sheet/WhiteSheetPageClient";
import { loadServerDigitalWhiteSheetPageModel } from "@/lib/white-sheet/server";

interface PageProps {
  searchParams: Promise<{
    sourceId?: string;
    market?: string;
    date?: string;
  }>;
}

/**
 * Local UAT boundary for the Digital White Sheet Core MVP. Scoped by
 * source + normalized market + business date, same identity the
 * persistence layer uses (see src/lib/white-sheet/persist.ts). Real data
 * only — no fixtures on this route.
 */
export default async function WhiteSheetPage({ searchParams }: PageProps) {
  const { sourceId, market, date } = await searchParams;

  const initial =
    sourceId && market && date
      ? {
          sourceId,
          market,
          date,
          pageModel: await loadServerDigitalWhiteSheetPageModel({
            sourceId,
            marketKey: market,
            marketLabel: market,
            businessDate: date,
          }),
        }
      : undefined;

  return (
    <>
      <DashboardTopBar title="ใบขาวดิจิทัล" />

      <div className="p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle>ใบขาวดิจิทัล</CardTitle>
            <p className="text-sm text-slate-500 mt-0.5">
              กรอกค่าใช้จ่ายและเงินสดส่งจริง เพื่อดูผลต่างและสถานะของวันนั้น
            </p>
          </CardHeader>
          <CardContent>
            <WhiteSheetPageClient initial={initial} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
