"use client";

import type { LucideIcon } from "lucide-react";

interface Props {
  label: string;
  value: string | number;
  icon: LucideIcon;
  /** Neon color CSS variable string, e.g. "var(--neon-cyan)". */
  color?: string;
  /** Small supplemental text rendered below the value. */
  sub?: string;
}

/** A compact glass-morphism stat tile used in the dashboard top bar and detail pages. */
export function StatCard({ label, value, icon: Icon, color = "var(--neon-cyan)", sub }: Props) {
  return (
    <div
      className="glass-card flex items-center gap-3 px-4 py-3 rounded-xl min-w-[130px]"
      style={{ borderColor: `color-mix(in srgb, ${color} 25%, transparent)` }}
    >
      <div
        className="flex items-center justify-center w-9 h-9 rounded-lg shrink-0"
        style={{
          background: `color-mix(in srgb, ${color} 10%, transparent)`,
          border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
        }}
      >
        <Icon className="w-4 h-4" style={{ color }} />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium truncate" style={{ color: "var(--text-muted)" }}>
          {label}
        </p>
        <p className="text-lg font-bold leading-tight" style={{ color: "var(--text-primary)" }}>
          {value}
        </p>
        {sub && (
          <p className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
            {sub}
          </p>
        )}
      </div>
    </div>
  );
}
