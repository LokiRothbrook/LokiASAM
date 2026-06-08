"use client";

import { useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ScrollText, ChevronDown } from "lucide-react";
import { useServers } from "@/hooks/useServers";
import { LogsTab } from "@/components/server/tabs/LogsTab";
import { ServerStatusBadge } from "@/components/server/ServerStatusBadge";
import type { ServerRow } from "@/lib/db";

export default function LogsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data: servers = [], isLoading } = useServers();

  const [selectedId, setSelectedId] = useState<string>(
    searchParams.get("server") ?? ""
  );

  // Default to first server once loaded if none selected
  useEffect(() => {
    if (!selectedId && servers.length > 0) {
      setSelectedId(servers[0].id);
    }
  }, [servers, selectedId]);

  const selectedServer: ServerRow | undefined = servers.find(
    (s) => s.id === selectedId
  );

  const handleSelect = (id: string) => {
    setSelectedId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("server", id);
    router.replace(url.pathname + url.search);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* ── Page header ── */}
      <div className="flex items-center gap-3">
        <ScrollText
          className="w-6 h-6 shrink-0"
          style={{ color: "var(--neon-cyan)" }}
        />
        <h1
          className="text-2xl font-bold"
          style={{ color: "var(--neon-cyan)", textShadow: "0 0 12px rgba(0,255,255,0.4)" }}
        >
          Logs
        </h1>
      </div>

      {/* ── Server selector (sticky) ── */}
      <div
        className="glass-card rounded-xl p-3 flex items-center gap-3 flex-wrap sticky top-0 z-10"
        style={{ borderColor: "rgba(0,255,255,0.2)" }}
      >
        <span className="text-sm font-medium shrink-0" style={{ color: "var(--text-muted)" }}>
          Server:
        </span>

        {isLoading ? (
          <div className="h-8 w-48 rounded bg-[rgba(255,255,255,0.05)] animate-pulse" />
        ) : servers.length === 0 ? (
          <span className="text-sm" style={{ color: "var(--text-muted)" }}>
            No servers configured
          </span>
        ) : (
          <div className="relative flex-1 max-w-xs">
            <select
              value={selectedId}
              onChange={(e) => handleSelect(e.target.value)}
              className="w-full h-9 pl-3 pr-8 text-sm rounded-lg appearance-none cursor-pointer"
              style={{
                background: "rgba(0,0,0,0.4)",
                border: "1px solid rgba(0,255,255,0.25)",
                color: "var(--text-primary)",
              }}
            >
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <ChevronDown
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
              style={{ color: "var(--text-muted)" }}
            />
          </div>
        )}

        {selectedServer && (
          <div className="flex items-center gap-2 ml-auto">
            <ServerStatusBadge status={selectedServer.status} />
            <span className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
              Port {selectedServer.port}
            </span>
          </div>
        )}
      </div>

      {/* ── Log viewer ── */}
      {selectedServer ? (
        <LogsTab server={selectedServer} />
      ) : !isLoading && servers.length === 0 ? (
        <div
          className="glass-card rounded-2xl p-16 flex flex-col items-center gap-4"
          style={{ borderColor: "rgba(191,0,255,0.15)" }}
        >
          <ScrollText className="w-10 h-10" style={{ color: "var(--text-muted)" }} />
          <p className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            No servers yet
          </p>
          <p className="text-sm text-center" style={{ color: "var(--text-muted)" }}>
            Add a server from the Dashboard to start viewing logs.
          </p>
        </div>
      ) : null}
    </div>
  );
}
