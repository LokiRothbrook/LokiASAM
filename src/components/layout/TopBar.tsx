"use client";

import { NotificationBell } from "@/components/layout/NotificationBell";
import { Server, Activity, Users, type LucideIcon } from "lucide-react";

interface GlobalStat {
  icon: LucideIcon;
  label: string;
  value: string | number;
  color?: string;
}

export function TopBar() {
  // Global stats will be populated from TanStack Query in Phase 3.
  const stats: GlobalStat[] = [
    { icon: Server,   label: "Servers",  value: "0",      color: "var(--text-muted)" },
    { icon: Activity, label: "Running",  value: "0",      color: "var(--neon-green)" },
    { icon: Users,    label: "Players",  value: "0/0",    color: "var(--neon-cyan)" },
  ];

  return (
    <header
      className="flex items-center justify-between px-6 h-14 shrink-0 border-b"
      style={{
        background: "rgba(5, 5, 20, 0.95)",
        borderColor: "var(--border)",
      }}
    >
      {/* Global stats strip */}
      <div className="flex items-center gap-6">
        {stats.map((stat) => (
          <div key={stat.label} className="flex items-center gap-2">
            <stat.icon className="w-4 h-4" style={{ color: stat.color ?? "var(--text-muted)" }} />
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {stat.label}:
            </span>
            <span className="text-xs font-semibold tabular-nums" style={{ color: stat.color ?? "var(--text-primary)" }}>
              {stat.value}
            </span>
          </div>
        ))}
      </div>

      {/* Right-side actions */}
      <div className="flex items-center gap-2">
        <NotificationBell />
      </div>
    </header>
  );
}
