import { Card, CardContent } from "@/components/ui/card";

interface StatCardProps {
  title: string;
  value: string | number | null;
  subtitle?: string;
  suffix?: string;
}

export function StatCard({ title, value, subtitle, suffix }: StatCardProps) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{title}</p>
        <p className="text-2xl font-bold mt-1">
          {value ?? "—"}
          {suffix && value != null && (
            <span className="text-sm font-normal text-muted-foreground ml-1">{suffix}</span>
          )}
        </p>
        {subtitle && (
          <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
        )}
      </CardContent>
    </Card>
  );
}
