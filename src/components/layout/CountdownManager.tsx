"use client";

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/useAppStore";

interface CountdownPayload {
  serverId: string;
  action: "restart" | "update" | null;
  remainingSecs: number;
  totalSecs: number;
}

export default function CountdownManager() {
  const setCountdown = useAppStore((s) => s.setCountdown);

  useEffect(() => {
    const unlisten = listen<CountdownPayload>("server://countdown", (ev) => {
      const { serverId, action, remainingSecs, totalSecs } = ev.payload;
      if (!action) {
        setCountdown(serverId, null);
      } else {
        setCountdown(serverId, { action, remainingSecs, totalSecs });
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [setCountdown]);

  return null;
}
