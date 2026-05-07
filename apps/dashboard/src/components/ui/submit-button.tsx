"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

type ButtonProps = React.ComponentProps<typeof Button>;

export interface SubmitButtonProps extends ButtonProps {
  label?: string;
  pendingLabel?: string;
  /** Override pending state — pass this when using useActionState's pending */
  pending?: boolean;
}

export function SubmitButtonCore({
  label,
  pendingLabel,
  disabled,
  className,
  children,
  pending: pendingOverride,
  ...props
}: SubmitButtonProps) {
  const { pending: formPending } = useFormStatus();
  const pending = pendingOverride ?? formPending;

  return (
    <Button
      type="submit"
      disabled={disabled || pending}
      className={className}
      {...props}
    >
      {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {pending
        ? pendingLabel || label || "Submitting..."
        : label || children}
    </Button>
  );
}

// Named export alias for backward compatibility
export { SubmitButtonCore as SubmitButton };

export default SubmitButtonCore;
