"use client";

import { NotificationBell } from "@/components/layout/NotificationBell";
import { Server, Activity, Users, RefreshCw } from "lucide-react";
import { useServers } from "@/hooks/useServers";
import { useAppStore } from "@/store/useAppStore";

export function TopBar() {
  const { data: servers = [] } = useServers();
  const asaCacheUpdateInProgress = useAppStore((s) => s.asaCacheUpdateInProgress);

  const total   = servers.length;
  const running = servers.filter((s) => s.status === "running").length;

  const stats = [
    { icon: Server,   label: "Servers", value: total,   color: "var(--text-muted)" },
    { icon: Activity, label: "Running", value: running, color: running > 0 ? "var(--neon-green)" : "var(--text-muted)" },
    { icon: Users,    label: "Players", value: "—",     color: "var(--text-muted)" },
  ];

  return (
    <header
      className="flex items-center justify-between px-6 h-14 flex-1 border-b"
      style={{
        background: "var(--glass-bg)",
        backdropFilter: "blur(var(--glass-blur))",
        WebkitBackdropFilter: "blur(var(--glass-blur))",
        borderColor: "var(--border)",
      }}
    >
      <div className="flex items-center gap-6">
        {stats.map((stat) => (
          <div key={stat.label} className="flex items-center gap-2">
            <stat.icon className="w-4 h-4" style={{ color: stat.color }} />
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {stat.label}:
            </span>
            <span className="text-xs font-semibold tabular-nums" style={{ color: stat.color }}>
              {stat.value}
            </span>
          </div>
        ))}

        {asaCacheUpdateInProgress && (
          <div className="flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" style={{ color: "var(--neon-purple)" }} />
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              Checking ASA updates…
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <NotificationBell />
      </div>
    </header>
  );
}
