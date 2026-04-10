"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";

interface SubmitButtonProps extends React.ComponentProps<typeof Button> {
  label?: string;
  pendingLabel?: string;
}

export function SubmitButton({
  label,
  pendingLabel,
  disabled,
  className,
  children,
  ...props
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeKey = React.useMemo(() => {
    const query = searchParams?.toString();
    return query ? `${pathname}?${query}` : pathname;
  }, [pathname, searchParams]);

  const submitRouteRef = React.useRef<string | null>(null);
  const [ignoreStuckPending, setIgnoreStuckPending] = React.useState(false);

  React.useEffect(() => {
    if (!pending) {
      submitRouteRef.current = null;
      if (ignoreStuckPending) {
        setIgnoreStuckPending(false);
      }
      return;
    }

    if (!submitRouteRef.current) {
      submitRouteRef.current = routeKey;
      return;
    }

    if (submitRouteRef.current !== routeKey && !ignoreStuckPending) {
      // Some App Router redirects can leave useFormStatus().pending stuck true
      // even after navigation succeeds. If the route changed, treat this submit
      // as settled so the button does not spin forever.
      setIgnoreStuckPending(true);
    }
  }, [ignoreStuckPending, pending, routeKey]);

  const effectivePending = pending && !ignoreStuckPending;

  return (
    <Button
      type="submit"
      disabled={disabled || effectivePending}
      className={className}
      {...props}
    >
      {effectivePending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {effectivePending ? (pendingLabel || label || children) : (label || children)}
    </Button>
  );
}
