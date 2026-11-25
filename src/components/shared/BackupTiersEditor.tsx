"use client";

/**
 * BackupTiersEditor — monthly/weekly/daily/hourly backup tiers, each with its
 * own on/off and "keep" count. Used for cluster backups (creation form,
 * cluster page, wizard); matches the server backup tier rows.
 */

import { ToggleLeft, ToggleRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { BackupTierSettings } from "@/lib/db";

const TIER_ORDER = ["monthly", "weekly", "daily", "hourly"] as const;

export function BackupTiersEditor({
  value,
  onChange,
  compact = false,
}: {
  value: BackupTierSettings;
  onChange: (next: BackupTierSettings) => void;
  /** Tighter rows for small forms (wizard inline create). */
  compact?: boolean;
}) {
  const patch = (tier: typeof TIER_ORDER[number], p: { enabled?: boolean; keep?: number }) =>
    onChange({ ...value, [tier]: { ...value[tier], ...p } });

  return (
    <div className={compact ? "space-y-1.5" : "space-y-2"}>
      {TIER_ORDER.map((tier) => {
        const state = value[tier];
        return (
          <div
            key={tier}
            className={`flex items-center gap-3 rounded-lg ${compact ? "px-2 py-1.5" : "px-3 py-2"}`}
            style={{
              background: "rgba(255,255,255,0.02)",
              border: `1px solid ${state.enabled ? "rgba(var(--neon-purple-rgb),0.3)" : "rgba(255,255,255,0.05)"}`,
            }}
          >
            <Input
              type="number" min={1} max={999} value={state.keep}
              onChange={(e) => patch(tier, { keep: Math.max(1, parseInt(e.target.value, 10) || 1) })}
              className={`${compact ? "w-14 h-7" : "w-16 h-8"} text-sm text-center shrink-0`}
              style={{
                background: "var(--surface)",
                border: `1px solid ${state.enabled ? "rgba(var(--neon-purple-rgb),0.35)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
                color: "var(--text-primary)",
              }}
            />
            <span className="flex-1 text-sm" style={{ color: "var(--text-muted)" }}>
              {tier} backups to keep
            </span>
            <button
              type="button"
              onClick={() => patch(tier, { enabled: !state.enabled })}
              className="shrink-0 flex items-center focus:outline-none"
              aria-label={state.enabled ? `Disable ${tier} backups` : `Enable ${tier} backups`}
            >
              {state.enabled
                ? <ToggleRight className="w-6 h-6" style={{ color: "var(--neon-purple)" }} />
                : <ToggleLeft className="w-6 h-6" style={{ color: "var(--text-muted)" }} />}
            </button>
          </div>
        );
      })}
    </div>
  );
}
