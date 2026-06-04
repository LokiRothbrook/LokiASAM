"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RconConsole } from "@/components/server/rcon/RconConsole";
import { getServer } from "@/lib/db";
import type { ServerRow } from "@/lib/db";

export default function RconPopoutPage() {
  const params = useSearchParams();
  const serverId = params.get("serverId");
  const [server, setServer] = useState<ServerRow | null>(null);

  useEffect(() => {
    if (!serverId) return;
    getServer(serverId).then(setServer).catch(console.error);
  }, [serverId]);

  if (!serverId) {
    return (
      <div className="flex items-center justify-center h-screen text-sm" style={{ color: "var(--text-muted)" }}>
        No server ID provided.
      </div>
    );
  }

  if (!server) {
    return (
      <div className="flex items-center justify-center h-screen text-sm" style={{ color: "var(--text-muted)" }}>
        Loading…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen p-4" style={{ background: "var(--background)" }}>
      <RconConsole server={server} isPopout />
    </div>
  );
}
