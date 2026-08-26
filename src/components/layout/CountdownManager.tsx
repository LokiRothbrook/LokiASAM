"use client";

import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useAppStore } from "@/store/useAppStore";

interface CountdownPayload {
  serverId: string;
  action: "restart" | "update" | null;
  remainingSecs: number;
  totalSecs: number;
}

export default function CountdownManager() {
  const setCountdown = useAppStore((s) => s.setCountdown);

  useTauriEvent<CountdownPayload>("server://countdown", ({ serverId, action, remainingSecs, totalSecs }) => {
    if (!action) {
      setCountdown(serverId, null);
    } else {
      setCountdown(serverId, { action, remainingSecs, totalSecs });
    }
  });

  return null;
}
