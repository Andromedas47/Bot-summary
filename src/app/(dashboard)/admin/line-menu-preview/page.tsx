import { DashboardTopBar } from "@/components/dashboard/DashboardTopBar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { LineMenuPreviewClient } from "./LineMenuPreviewClient";

export default function LineMenuPreviewPage() {
  return (
    <>
      <DashboardTopBar title="LINE Menu Preview" />

      <div className="p-4 sm:p-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Guided Produce Menu — UX Preview</CardTitle>
            <p className="text-sm text-slate-500">
              Backoffice-only · local React state · ไม่ผูก webhook / ไม่เขียน DB / ไม่ส่ง LINE API
            </p>
          </CardHeader>
          <CardContent className="pt-4">
            <LineMenuPreviewClient />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
