"use client";

/**
 * CronBuilder — human-friendly 5-field cron expression editor.
 *
 * Shows common interval presets. Selecting "Custom" exposes a raw cron
 * input alongside a human-readable description of the expression.
 */

import { useState } from "react";
import { Info } from "lucide-react";
import { Input } from "@/components/ui/input";
import { CronExpressionParser } from "cron-parser";

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export interface CronPreset {
  label: string;
  cron: string;
}

export const CRON_PRESETS: CronPreset[] = [
  { label: "Every hour",     cron: "0 * * * *"     },
  { label: "Every 2 hours",  cron: "0 */2 * * *"   },
  { label: "Every 4 hours",  cron: "0 */4 * * *"   },
  { label: "Every 6 hours",  cron: "0 */6 * * *"   },
  { label: "Every 12 hours", cron: "0 */12 * * *"  },
  { label: "Daily at 3 AM",  cron: "0 3 * * *"     },
  { label: "Daily at 6 AM",  cron: "0 6 * * *"     },
  { label: "Weekly (Sun 3 AM)", cron: "0 3 * * 0"  },
  { label: "Custom…",        cron: ""              },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the next fire Date for a cron expression, or null on parse error. */
export function getNextCronDate(expr: string): Date | null {
  try {
    const interval = CronExpressionParser.parse(expr);
    return interval.next().toDate();
  } catch {
    return null;
  }
}

/** Format a Date as a short relative string. */
export function formatNextRun(date: Date | null): string {
  if (!date) return "Invalid cron";
  const diffMs = date.getTime() - Date.now();
  if (diffMs < 0) return "overdue";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1)  return "< 1 min";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  return `in ${Math.floor(hours / 24)}d`;
}

/** Simple human-readable description for known patterns, raw expr otherwise. */
export function cronToHuman(expr: string): string {
  const preset = CRON_PRESETS.find((p) => p.cron === expr);
  if (preset && preset.cron) return preset.label;

  // Basic minute/hour decomposition for display
  const parts = expr.trim().split(/\s+/);
  if (parts.length === 5) {
    const [min, hour] = parts;
    if (min === "0" && hour.startsWith("*/")) {
      const n = parseInt(hour.slice(2), 10);
      if (!isNaN(n)) return `Every ${n} hour${n > 1 ? "s" : ""}`;
    }
    if (min === "0" && /^\d+$/.test(hour)) {
      return `Daily at ${hour.padStart(2, "0")}:00`;
    }
  }
  return expr; // fall back to raw
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  value: string;
  onChange: (cron: string) => void;
  /** Optional label suffix shown next to the picker. */
  label?: string;
}

export function CronBuilder({ value, onChange, label }: Props) {
  const matchedPreset =
    CRON_PRESETS.find((p) => p.cron === value && p.cron !== "") ??
    (value ? CRON_PRESETS[CRON_PRESETS.length - 1] : CRON_PRESETS[3]); // default: Every 6h

  const [selected, setSelected] = useState<CronPreset>(matchedPreset);
  const [customCron, setCustomCron] = useState(value);
  const [customError, setCustomError] = useState(false);

  const isCustom = selected.cron === "";

  // Sync selection when `value` changes externally — compared during render
  // rather than via an effect, since it's a synchronous derivation from the
  // `value` prop with no async work of its own.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    const preset = CRON_PRESETS.find((p) => p.cron === value && p.cron !== "");
    if (preset) {
      setSelected(preset);
    } else if (value) {
      setSelected(CRON_PRESETS[CRON_PRESETS.length - 1]);
      setCustomCron(value);
    }
  }

  function handlePresetChange(preset: CronPreset) {
    setSelected(preset);
    if (preset.cron !== "") {
      onChange(preset.cron);
    }
  }

  function handleCustomChange(raw: string) {
    setCustomCron(raw);
    try {
      CronExpressionParser.parse(raw);
      setCustomError(false);
      onChange(raw);
    } catch {
      setCustomError(true);
    }
  }

  const activeCron = isCustom ? customCron : selected.cron;
  const next = activeCron ? getNextCronDate(activeCron) : null;

  return (
    <div className="space-y-2">
      {label && (
        <p className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
          {label}
        </p>
      )}

      {/* Preset grid */}
      <div className="flex flex-wrap gap-1.5">
        {CRON_PRESETS.map((preset) => {
          const active = preset.cron === "" ? isCustom : selected.cron === preset.cron;
          return (
            <button
              key={preset.label}
              type="button"
              onClick={() => handlePresetChange(preset)}
              className="px-2.5 py-1 rounded-md text-xs transition-all cursor-pointer"
              style={{
                background: active ? "rgba(var(--neon-purple-rgb),0.15)" : "rgba(255,255,255,0.04)",
                border: active
                  ? "1px solid rgba(var(--neon-purple-rgb),0.5)"
                  : "1px solid rgba(255,255,255,0.08)",
                color: active ? "var(--neon-purple)" : "var(--text-muted)",
                fontWeight: active ? 600 : 400,
                textShadow: active ? "var(--glow-purple)" : "none",
              }}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      {/* Custom cron input */}
      {isCustom && (
        <div className="space-y-1">
          <Input
            value={customCron}
            onChange={(e) => handleCustomChange(e.target.value)}
            placeholder="e.g. 30 */3 * * *"
            className="font-mono text-sm h-8"
            style={{
              background: "rgba(0,0,0,0.4)",
              border: customError
                ? "1px solid rgba(255,0,85,0.5)"
                : "1px solid rgba(var(--neon-purple-rgb),0.2)",
              color: "var(--text-primary)",
            }}
          />
          {customError && (
            <p className="text-xs" style={{ color: "var(--neon-red)" }}>
              Invalid cron expression
            </p>
          )}
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Format: minute hour day month weekday (e.g. <code>0 */6 * * *</code> = every 6h)
          </p>
        </div>
      )}

      {/* Next run preview */}
      {activeCron && !customError && (
        <div
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md"
          style={{
            background: "rgba(var(--neon-purple-rgb),0.04)",
            border: "1px solid rgba(var(--neon-purple-rgb),0.12)",
            color: "var(--text-muted)",
          }}
        >
          <Info className="w-3 h-3 shrink-0" style={{ color: "var(--neon-cyan)" }} />
          <span>
            {isCustom
              ? cronToHuman(customCron)
              : selected.label}
            {" — "}next run:{" "}
            <span style={{ color: "var(--text-primary)" }}>
              {formatNextRun(next)}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
