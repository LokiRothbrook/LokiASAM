"use client";

import { NotificationBell } from "@/components/layout/NotificationBell";
import { Server, Activity, Users, RefreshCw, Cpu, MemoryStick } from "lucide-react";
import { useServers } from "@/hooks/useServers";
import { useAppStore } from "@/store/useAppStore";

export function TopBar() {
  const { data: servers = [] } = useServers();
  const asaCacheOpLabel = useAppStore((s) => s.asaCacheOpLabel);
  const protonOpLabel   = useAppStore((s) => s.protonOpLabel);
  const statsLiveBuffers = useAppStore((s) => s.statsLiveBuffers);

  const total   = servers.length;
  const running = servers.filter((s) => s.status === "running").length;

  // Aggregate CPU, RAM, and players from the live buffer across all active servers.
  let totalPlayers: number | null = null;
  let totalCpu: number | null = null;
  let totalRamMb: number | null = null;

  const activeStatuses = new Set(["running", "starting"]);
  for (const server of servers) {
    if (!activeStatuses.has(server.status)) continue;
    const buf = statsLiveBuffers[server.id];
    if (!buf || buf.length === 0) continue;
    const latest = buf[buf.length - 1];
    if (latest.players !== null) totalPlayers = (totalPlayers ?? 0) + latest.players;
    if (latest.cpu    !== null) totalCpu     = (totalCpu    ?? 0) + latest.cpu;
    if (latest.mem    !== null) totalRamMb   = (totalRamMb  ?? 0) + latest.mem;
  }

  const cpuDisplay = totalCpu !== null ? `${totalCpu.toFixed(1)}%` : "—";
  const ramDisplay = totalRamMb !== null
    ? totalRamMb >= 1024
      ? `${(totalRamMb / 1024).toFixed(1)} GB`
      : `${Math.round(totalRamMb)} MB`
    : "—";

  const stats = [
    { icon: Server,       label: "Servers", value: total,                                     color: "var(--text-muted)" },
    { icon: Activity,     label: "Running", value: running,                                    color: running > 0 ? "var(--neon-green)" : "var(--text-muted)" },
    { icon: Users,        label: "Players", value: totalPlayers !== null ? totalPlayers : "—", color: totalPlayers !== null && totalPlayers > 0 ? "var(--neon-cyan)" : "var(--text-muted)" },
    { icon: Cpu,          label: "CPU",     value: cpuDisplay,                                 color: totalCpu !== null ? "var(--neon-purple)" : "var(--text-muted)" },
    { icon: MemoryStick,  label: "RAM",     value: ramDisplay,                                 color: totalRamMb !== null ? "var(--neon-purple)" : "var(--text-muted)" },
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

        {asaCacheOpLabel && (
          <div className="flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" style={{ color: "var(--neon-purple)" }} />
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {asaCacheOpLabel}
            </span>
          </div>
        )}
        {protonOpLabel && (
          <div className="flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" style={{ color: "var(--neon-cyan)" }} />
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {protonOpLabel}
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
