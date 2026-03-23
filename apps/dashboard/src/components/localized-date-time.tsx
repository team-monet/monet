"use client";

import { useEffect, useState } from "react";

interface LocalizedDateTimeProps {
  date: string | Date;
  dateOnly?: boolean;
}

export function LocalizedDateTime({ date, dateOnly = false }: LocalizedDateTimeProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const dateObj = new Date(date);

  if (!mounted) {
    return <span className="opacity-0" suppressHydrationWarning>{dateObj.toISOString()}</span>;
  }

  return <span>{dateOnly ? dateObj.toLocaleDateString() : dateObj.toLocaleString()}</span>;
}
