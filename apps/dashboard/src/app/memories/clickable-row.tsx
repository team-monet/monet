"use client";

import { useRouter } from "next/navigation";
import { TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface ClickableRowProps extends React.ComponentProps<typeof TableRow> {
  href: string;
}

export function ClickableRow({ href, className, children, ...props }: ClickableRowProps) {
  const router = useRouter();

  const handleClick = (e: React.MouseEvent) => {
    // Don't navigate if clicking on a button, link, or other interactive element
    // inside the row, to let their own handlers work.
    const target = e.target as HTMLElement;
    if (target.closest('button, a, [role="button"]')) {
      return;
    }
    
    router.push(href);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      router.push(href);
    }
  };

  return (
    <TableRow
      className={cn("cursor-pointer hover:bg-muted/50 transition-colors", className)}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="link"
      aria-label="View memory details"
      {...props}
    >
      {children}
    </TableRow>
  );
}
