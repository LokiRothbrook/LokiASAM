"use client";

import { Archive, Hammer } from "lucide-react";

export default function BackupsPage() {
  return (
    <div className="flex flex-col gap-6">
      {/* ── Page header ── */}
      <div className="flex items-center gap-3">
        <Archive
          className="w-6 h-6 shrink-0"
          style={{ color: "var(--neon-purple)" }}
        />
        <h1
          className="text-2xl font-bold"
          style={{ color: "var(--neon-purple)", textShadow: "0 0 12px rgba(191,0,255,0.4)" }}
        >
          Backups
        </h1>
      </div>

      {/* ── Coming soon ── */}
      <div
        className="glass-card rounded-2xl p-16 flex flex-col items-center gap-6"
        style={{ borderColor: "rgba(191,0,255,0.2)" }}
      >
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center"
          style={{ background: "rgba(191,0,255,0.1)", border: "1px solid rgba(191,0,255,0.3)" }}
        >
          <Hammer className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
        </div>

        <div className="text-center flex flex-col gap-2">
          <h2 className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>
            Coming Soon
          </h2>
          <p className="text-sm max-w-sm" style={{ color: "var(--text-muted)" }}>
            Scheduled and on-demand backups for your ARK server save data are in active
            development. This will include per-server backup schedules, restore points,
            and retention policies.
          </p>
        </div>

        <div
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm"
          style={{
            background: "rgba(191,0,255,0.06)",
            border: "1px solid rgba(191,0,255,0.2)",
            color: "var(--text-muted)",
          }}
        >
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: "var(--neon-purple)", boxShadow: "0 0 6px var(--neon-purple)" }}
          />
          Next up after the logging system
        </div>
      </div>
    </div>
  );
}
