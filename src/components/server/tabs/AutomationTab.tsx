"use client";

/**
 * AutomationTab — manage per-server cron schedules (backup, update, restart, broadcast).
 *
 * Schedule data lives entirely in SQLite (frontend). The Rust scheduler commands
 * are thin UUID generators; actual firing is handled by SchedulerManager in the root layout.
 * Schedules only fire while the LokiASAM app is running.
 */

import { useState, useCallback, useEffect } from "react";
import {
  CalendarClock, HardDrive, RefreshCw, RotateCcw, Megaphone,
  Info, CheckCircle2, Loader2, Plus, Trash2, ToggleLeft, ToggleRight,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CronBuilder, getNextCronDate, CRON_PRESETS } from "@/components/shared/CronBuilder";
import {
  getServerSchedules, createSchedule, deleteScheduleRecord,
  updateScheduleEnabled, updateScheduleConfig,
  type ScheduleRow, type CreateScheduleInput,
} from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import type { ServerRow } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ScheduleType = "backup" | "update" | "restart" | "broadcast";

interface BackupConfig {
  // no extra options
}

interface RestartConfig {
  broadcastWarning: boolean;
  warningMinutes: number;
  message: string;
}

interface UpdateConfig {
  broadcastWarning: boolean;
  warningMinutes: number;
  message: string;
}

interface BroadcastConfig {
  message: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CRON: Record<ScheduleType, string> = {
  backup:    CRON_PRESETS[3].cron,  // Every 6h
  update:    "0 3 * * *",           // Daily at 3 AM
  restart:   "0 6 * * *",           // Daily at 6 AM
  broadcast: CRON_PRESETS[0].cron,  // Every hour
};

const DEFAULT_CONFIG: Record<ScheduleType, object> = {
  backup:    {} as BackupConfig,
  update:    { broadcastWarning: true, warningMinutes: 15, message: "Server updating in {minutes} minutes. Progress will be saved." } as UpdateConfig,
  restart:   { broadcastWarning: true, warningMinutes: 15, message: "Server restarting in {minutes} minutes. Progress will be saved." } as RestartConfig,
  broadcast: { message: "Welcome to the server! Type /help for commands." } as BroadcastConfig,
};

function formatNextRun(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const diff = d.getTime() - Date.now();
  if (diff < 0) return "overdue";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "< 1 min";
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `in ${h}h ${mins % 60}m`;
  return `in ${Math.floor(h / 24)}d`;
}

function formatLastRun(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// ScheduleCard — one card per schedule type
// ---------------------------------------------------------------------------

interface CardProps {
  serverId: string;
  type: ScheduleType;
  icon: React.ElementType;
  title: string;
  description: string;
  existing: ScheduleRow | null;
  onRefresh: () => void;
}

function ScheduleCard({ serverId, type, icon: Icon, title, description, existing, onRefresh }: CardProps) {
  const [cron, setCron]         = useState(existing?.cron_expression ?? DEFAULT_CRON[type]);
  const [enabled, setEnabled]   = useState(existing ? existing.enabled === 1 : false);
  const [config, setConfig]     = useState<object>(
    existing?.config_json ? JSON.parse(existing.config_json) : DEFAULT_CONFIG[type]
  );
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [deleting, setDeleting] = useState(false);

  const nextDate = getNextCronDate(cron);
  const nextRun  = existing?.next_run ?? (nextDate ? nextDate.toISOString() : null);

  function patchConfig(patch: Partial<RestartConfig & UpdateConfig & BroadcastConfig>) {
    setConfig((c) => ({ ...c, ...patch }));
  }

  async function handleSave() {
    if (!cron) return;
    setSaving(true);
    try {
      const configJson = JSON.stringify(config);
      const nextDate   = getNextCronDate(cron);
      const nextIso    = nextDate?.toISOString() ?? new Date().toISOString();

      if (existing) {
        // Update existing schedule
        await updateScheduleConfig(existing.id, cron, configJson, nextIso);
        if (enabled !== (existing.enabled === 1)) {
          await updateScheduleEnabled(existing.id, enabled);
        }
      } else {
        // Create new schedule — get UUID from Rust, then persist to SQLite
        const newId = await tauriCmd.createSchedule({
          serverId,
          scheduleType: type,
          cronExpression: cron,
          configJson,
        });
        const input: CreateScheduleInput = {
          id: newId,
          serverId,
          scheduleType: type,
          cronExpression: cron,
          enabled,
          configJson,
        };
        await createSchedule(input);
        // Update next_run after insert
        await updateScheduleConfig(newId, cron, configJson, nextIso);
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onRefresh();
    } catch (e) {
      toast.error(`Failed to save schedule: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!existing) return;
    setDeleting(true);
    try {
      await tauriCmd.deleteSchedule(existing.id);
      await deleteScheduleRecord(existing.id);
      onRefresh();
      toast.success(`${title} schedule removed.`);
    } catch (e) {
      toast.error(`Failed to delete: ${e}`);
    } finally {
      setDeleting(false);
    }
  }

  async function handleToggle() {
    const newVal = !enabled;
    setEnabled(newVal);
    if (existing) {
      try {
        await tauriCmd.toggleSchedule(existing.id, newVal);
        await updateScheduleEnabled(existing.id, newVal);
        onRefresh();
      } catch (e) {
        toast.error(`Toggle failed: ${e}`);
        setEnabled(!newVal);
      }
    }
  }

  const c = config as RestartConfig & UpdateConfig & BroadcastConfig;

  return (
    <div
      className="glass-card rounded-xl p-4 space-y-4"
      style={{
        border: enabled
          ? "1px solid rgba(191,0,255,0.25)"
          : "1px solid rgba(191,0,255,0.1)",
        opacity: enabled ? 1 : 0.75,
      }}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{
            background: enabled ? "rgba(191,0,255,0.1)" : "rgba(255,255,255,0.04)",
            border: "1px solid rgba(191,0,255,0.2)",
          }}
        >
          <Icon className="w-4 h-4" style={{ color: enabled ? "var(--neon-purple)" : "var(--text-muted)" }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{title}</h3>
            {existing && (
              <span
                className="px-1.5 py-0.5 rounded text-xs"
                style={{
                  background: enabled ? "rgba(0,255,136,0.08)" : "rgba(255,255,255,0.04)",
                  color: enabled ? "var(--neon-green)" : "var(--text-muted)",
                  border: `1px solid ${enabled ? "rgba(0,255,136,0.2)" : "rgba(255,255,255,0.08)"}`,
                }}
              >
                {enabled ? "Active" : "Paused"}
              </span>
            )}
          </div>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{description}</p>
        </div>
        <button
          type="button"
          onClick={handleToggle}
          title={enabled ? "Disable schedule" : "Enable schedule"}
          className="shrink-0 cursor-pointer"
        >
          {enabled
            ? <ToggleRight className="w-6 h-6" style={{ color: "var(--neon-purple)" }} />
            : <ToggleLeft  className="w-6 h-6" style={{ color: "var(--text-muted)" }}  />
          }
        </button>
      </div>

      {/* Last / next run */}
      {existing && (
        <div className="flex gap-4 text-xs" style={{ color: "var(--text-muted)" }}>
          <span>Last run: <strong style={{ color: "var(--text-primary)" }}>{formatLastRun(existing.last_run)}</strong></span>
          <span>Next run: <strong style={{ color: "var(--neon-cyan)" }}>{formatNextRun(existing.next_run)}</strong></span>
        </div>
      )}

      {/* Cron picker */}
      <CronBuilder value={cron} onChange={setCron} label="Schedule" />

      {/* Type-specific options */}
      {(type === "restart" || type === "update") && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={c.broadcastWarning ?? true}
              onChange={(e) => patchConfig({ broadcastWarning: e.target.checked })}
              className="w-3.5 h-3.5 accent-purple-500"
            />
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              Broadcast warning in-game before {type}
            </span>
          </label>
          {c.broadcastWarning && (
            <div className="flex gap-3 items-end pl-5">
              <div className="space-y-1">
                <label className="text-xs" style={{ color: "var(--text-muted)" }}>Warning (minutes)</label>
                <Input
                  type="number" min={1} max={60}
                  value={c.warningMinutes ?? 15}
                  onChange={(e) => patchConfig({ warningMinutes: parseInt(e.target.value, 10) || 15 })}
                  className="h-7 w-20 text-xs"
                  style={{
                    background: "rgba(0,0,0,0.4)",
                    border: "1px solid rgba(191,0,255,0.2)",
                    color: "var(--text-primary)",
                  }}
                />
              </div>
              <div className="flex-1 space-y-1">
                <label className="text-xs" style={{ color: "var(--text-muted)" }}>Broadcast message ({"{minutes}"} = countdown)</label>
                <Input
                  value={c.message ?? ""}
                  onChange={(e) => patchConfig({ message: e.target.value })}
                  placeholder="Server restarting in {minutes} minutes."
                  className="h-7 text-xs"
                  style={{
                    background: "rgba(0,0,0,0.4)",
                    border: "1px solid rgba(191,0,255,0.2)",
                    color: "var(--text-primary)",
                  }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {type === "broadcast" && (
        <div className="space-y-1">
          <label className="text-xs" style={{ color: "var(--text-muted)" }}>Message to broadcast</label>
          <Input
            value={c.message ?? ""}
            onChange={(e) => patchConfig({ message: e.target.value })}
            placeholder="Welcome to the server!"
            className="h-8 text-sm"
            style={{
              background: "rgba(0,0,0,0.4)",
              border: "1px solid rgba(191,0,255,0.2)",
              color: "var(--text-primary)",
            }}
          />
        </div>
      )}

      {/* Save / delete row */}
      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving}
          className="gap-1.5 cursor-pointer"
          style={{
            background: saved ? "rgba(0,255,136,0.15)" : "rgba(191,0,255,0.15)",
            border:     saved ? "1px solid rgba(0,255,136,0.4)" : "1px solid rgba(191,0,255,0.4)",
            color:      saved ? "var(--neon-green)" : "var(--neon-purple)",
          }}
        >
          {saving ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
          ) : saved ? (
            <><CheckCircle2 className="w-3.5 h-3.5" /> Saved</>
          ) : existing ? (
            "Save Changes"
          ) : (
            <><Plus className="w-3.5 h-3.5" /> Enable Schedule</>
          )}
        </Button>

        {existing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDelete}
            disabled={deleting}
            className="gap-1.5 cursor-pointer"
            style={{ color: "var(--neon-red)" }}
          >
            {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AutomationTab
// ---------------------------------------------------------------------------

interface Props {
  server: ServerRow;
}

const CARD_DEFS: {
  type: ScheduleType;
  icon: React.ElementType;
  title: string;
  description: string;
}[] = [
  {
    type: "backup",
    icon: HardDrive,
    title: "Auto-Backup",
    description: "Automatically zip and archive the server's save directory on a schedule.",
  },
  {
    type: "update",
    icon: RefreshCw,
    title: "Auto-Update",
    description: "Check for and install server updates via SteamCMD on a schedule.",
  },
  {
    type: "restart",
    icon: RotateCcw,
    title: "Auto-Restart",
    description: "Gracefully restart the server on a schedule with optional in-game warnings.",
  },
  {
    type: "broadcast",
    icon: Megaphone,
    title: "Scheduled Broadcast",
    description: "Send a recurring in-game message to all online players via RCON.",
  },
];

export function AutomationTab({ server }: Props) {
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [loading, setLoading]     = useState(true);

  const loadSchedules = useCallback(async () => {
    setLoading(true);
    try {
      setSchedules(await getServerSchedules(server.id));
    } catch (e) {
      toast.error(`Failed to load schedules: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [server.id]);

  useEffect(() => { loadSchedules(); }, [loadSchedules]);

  function scheduleFor(type: ScheduleType): ScheduleRow | null {
    return schedules.find((s) => s.schedule_type === type) ?? null;
  }

  return (
    <div className="space-y-4">
      {/* App-running notice */}
      <div
        className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg text-xs"
        style={{
          background: "rgba(0,255,255,0.04)",
          border: "1px solid rgba(0,255,255,0.15)",
          color: "var(--text-muted)",
        }}
      >
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--neon-cyan)" }} />
        <span>
          Schedules only fire while <strong style={{ color: "var(--text-primary)" }}>LokiASAM is running</strong>.
          {" "}Keep the app open for automated tasks to execute on time.
        </span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarClock className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Automation
          </h2>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={loadSchedules}
          disabled={loading}
          className="h-8 gap-1.5 cursor-pointer"
          style={{ border: "1px solid rgba(255,255,255,0.1)", color: "var(--text-muted)" }}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="glass-card rounded-xl h-28 animate-pulse"
              style={{ border: "1px solid rgba(191,0,255,0.1)" }} />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {CARD_DEFS.map((def) => (
            <ScheduleCard
              key={def.type}
              serverId={server.id}
              type={def.type}
              icon={def.icon}
              title={def.title}
              description={def.description}
              existing={scheduleFor(def.type)}
              onRefresh={loadSchedules}
            />
          ))}
        </div>
      )}
    </div>
  );
}
