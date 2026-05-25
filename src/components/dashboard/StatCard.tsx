import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/Card";

interface StatCardProps {
  title: string;
  value: string | number;
  description?: string;
  icon: ReactNode;
  trend?: {
    value: number;
    label: string;
  };
  accentColor?: string;
}

export function StatCard({
  title,
  value,
  description,
  icon,
  trend,
  accentColor = "bg-slate-100 text-slate-600",
}: StatCardProps) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-500 truncate">{title}</p>
            <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
              {value}
            </p>
            {description && (
              <p className="mt-1 text-xs text-slate-400">{description}</p>
            )}
            {trend && (
              <p
                className={`mt-2 text-xs font-medium ${
                  trend.value >= 0 ? "text-emerald-600" : "text-red-600"
                }`}
              >
                {trend.value >= 0 ? "+" : ""}
                {trend.value}% {trend.label}
              </p>
            )}
          </div>
          <div className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${accentColor}`}>
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
