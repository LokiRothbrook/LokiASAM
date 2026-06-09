"use client";

import { useState, useCallback, useEffect } from "react";
import {
  CalendarClock, HardDrive, RefreshCw, RotateCcw, Megaphone,
  Info, CheckCircle2, Loader2, Plus, Trash2, ToggleLeft, ToggleRight,
  AlertTriangle, ChevronDown, ChevronUp,
  ArrowUp, Clock, Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getNextCronDate } from "@/components/shared/CronBuilder";
import {
  getServerSchedules, createSchedule, deleteScheduleRecord,
  updateScheduleEnabled, updateScheduleConfig,
  setServerUpdateAutomation,
  type ScheduleRow, type CreateScheduleInput,
  type UpdateAutomation,
} from "@/lib/db";
import { getAppSetting } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { syncSchedulesToRust } from "@/lib/scheduler-sync";
import type { ServerRow } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ScheduleType = "restart" | "broadcast";
type AddMode = "minutes" | "hours" | "daily";

interface RestartConfig {
  broadcastWarning: boolean;
  warningMinutes: number;
  message: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCfg(json: string | null | undefined): Record<string, unknown> {
  try { return JSON.parse(json ?? "{}"); } catch { return {}; }
}

function buildCronFromMode(mode: AddMode, val: number | string): string {
  if (mode === "minutes") return `*/${Math.max(1, Math.min(59, val as number))} * * * *`;
  if (mode === "hours")   return `0 */${Math.max(1, Math.min(23, val as number))} * * *`;
  const [h, m] = String(val).split(":").map(Number);
  return `${isNaN(m) ? 0 : m} ${isNaN(h) ? 6 : h} * * *`;
}

function describeSchedule(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;
  const minMatch = min.match(/^\*\/(\d+)$/);
  if (minMatch && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const n = minMatch[1];
    return `Every ${n} minute${n === "1" ? "" : "s"}`;
  }
  const hourMatch = hour.match(/^\*\/(\d+)$/);
  if (hourMatch && min === "0" && dom === "*" && mon === "*" && dow === "*") {
    const n = hourMatch[1];
    return `Every ${n} hour${n === "1" ? "" : "s"}`;
  }
  const minNum = parseInt(min), hourNum = parseInt(hour);
  if (!isNaN(minNum) && !isNaN(hourNum) && dom === "*" && mon === "*" && dow === "*") {
    const d = new Date(); d.setHours(hourNum, minNum, 0);
    return `Daily at ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  return cron;
}

function cronToMode(cron: string): { mode: AddMode; num: number; time: string } {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { mode: "daily", num: 6, time: "06:00" };
  const [min, hour] = parts;
  const minMatch = min.match(/^\*\/(\d+)$/);
  if (minMatch && hour === "*") return { mode: "minutes", num: parseInt(minMatch[1]) || 30, time: "06:00" };
  const hourMatch = hour.match(/^\*\/(\d+)$/);
  if (hourMatch && min === "0") return { mode: "hours", num: parseInt(hourMatch[1]) || 6, time: "06:00" };
  const h = parseInt(hour ?? "6"), m = parseInt(min ?? "0");
  return {
    mode: "daily", num: 6,
    time: `${String(isNaN(h) ? 6 : h).padStart(2, "0")}:${String(isNaN(m) ? 0 : m).padStart(2, "0")}`,
  };
}

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

// ---------------------------------------------------------------------------
// AddScheduleRow — shared picker for add and inline edit
// ---------------------------------------------------------------------------

interface AddScheduleRowProps {
  mode: AddMode; setMode: (m: AddMode) => void;
  num: number;   setNum:  (n: number) => void;
  time: string;  setTime: (t: string) => void;
  showMessage: boolean; message: string; setMessage: (m: string) => void;
  onConfirm: () => void;
  onCancel?: () => void;
  confirmLabel?: string;
  busy: boolean;
}

function AddScheduleRow({
  mode, setMode, num, setNum, time, setTime,
  showMessage, message, setMessage,
  onConfirm, onCancel, confirmLabel = "Add", busy,
}: AddScheduleRowProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as AddMode)}
          className="h-8 text-xs px-2 rounded shrink-0"
          style={{
            background: "rgba(0,0,0,0.4)", border: "1px solid rgba(var(--neon-purple-rgb),0.25)",
            color: "var(--text-primary)", outline: "none",
          }}
        >
          <option value="minutes">Every X minutes</option>
          <option value="hours">Every X hours</option>
          <option value="daily">Daily at time</option>
        </select>

        {(mode === "minutes" || mode === "hours") && (
          <Input
            type="number" min={1} max={mode === "minutes" ? 59 : 23} value={num}
            onChange={(e) => setNum(Math.max(1, parseInt(e.target.value) || 1))}
            className="w-20 h-8 text-xs text-center"
            style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
          />
        )}
        {mode === "daily" && (
          <input
            type="time" value={time} onChange={(e) => setTime(e.target.value)}
            className="h-8 rounded px-2 text-xs font-mono"
            style={{ background: "rgba(0,0,0,0.35)", border: "1px solid rgba(var(--neon-purple-rgb),0.25)", color: "var(--text-primary)", outline: "none" }}
          />
        )}

        <div className="flex items-center gap-2 ml-auto">
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}
              className="h-8 cursor-pointer text-xs" style={{ color: "var(--text-muted)" }}>
              Cancel
            </Button>
          )}
          <Button
            size="sm" onClick={onConfirm}
            disabled={busy || (showMessage && !message.trim())}
            className="h-8 gap-1.5 cursor-pointer"
            style={{ background: "rgba(var(--neon-purple-rgb),0.15)", border: "1px solid rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)" }}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            {confirmLabel}
          </Button>
        </div>
      </div>

      {showMessage && (
        <Input
          value={message} onChange={(e) => setMessage(e.target.value)}
          placeholder="Message to send in global chat"
          className="h-8 text-sm"
          style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScheduleListRow — one schedule entry with inline edit
// ---------------------------------------------------------------------------

function ScheduleListRow({ row, type, onDelete, onToggle, onSave }: {
  row: ScheduleRow;
  type: ScheduleType;
  onDelete: () => Promise<void>;
  onToggle: () => Promise<void>;
  onSave: (cron: string, configJson: string) => Promise<void>;
}) {
  const parsed = cronToMode(row.cron_expression);
  const [editing,  setEditing]  = useState(false);
  const [mode,     setMode]     = useState<AddMode>(parsed.mode);
  const [num,      setNum]      = useState(parsed.num);
  const [time,     setTime]     = useState(parsed.time);
  const [msg,      setMsg]      = useState<string>((parseCfg(row.config_json).message as string) ?? "");
  const [saving,   setSaving]   = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const cron = buildCronFromMode(mode, mode === "daily" ? time : num);
      const cfg  = parseCfg(row.config_json);
      const configJson = type === "broadcast"
        ? JSON.stringify({ ...cfg, message: msg })
        : row.config_json ?? "{}";
      await onSave(cron, configJson);
      setEditing(false);
    } catch (e) {
      toast.error(`Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try { await onDelete(); }
    finally { setDeleting(false); }
  }

  if (editing) {
    return (
      <div className="rounded-lg p-2.5" style={{ background: "rgba(var(--neon-purple-rgb),0.05)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
        <AddScheduleRow
          mode={mode} setMode={setMode} num={num} setNum={setNum}
          time={time} setTime={setTime}
          showMessage={type === "broadcast"} message={msg} setMessage={setMsg}
          onConfirm={handleSave} onCancel={() => setEditing(false)}
          confirmLabel="Save" busy={saving}
        />
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-2 rounded-lg px-3 py-2"
      style={{
        background: row.enabled === 1 ? "rgba(var(--neon-purple-rgb),0.05)" : "rgba(255,255,255,0.02)",
        border: `1px solid ${row.enabled === 1 ? "rgba(var(--neon-purple-rgb),0.2)" : "rgba(255,255,255,0.05)"}`,
      }}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm" style={{ color: "var(--text-primary)" }}>
          {describeSchedule(row.cron_expression)}
        </p>
        {type === "broadcast" && msg && (
          <p className="text-xs truncate" style={{ color: "var(--text-muted)" }}>{msg}</p>
        )}
        {row.next_run && (
          <p className="text-[10px]" style={{ color: "var(--neon-cyan)" }}>
            Next: {formatNextRun(row.next_run)}
          </p>
        )}
      </div>
      <Button size="sm" variant="ghost" onClick={() => setEditing(true)}
        className="h-7 px-2 cursor-pointer text-xs shrink-0" style={{ color: "var(--text-muted)" }}>
        Edit
      </Button>
      <Button size="sm" variant="ghost" disabled={deleting} onClick={handleDelete}
        className="h-7 w-7 p-0 cursor-pointer shrink-0" style={{ color: "var(--neon-red)" }}>
        {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
      </Button>
      <button onClick={onToggle} className="cursor-pointer shrink-0">
        {row.enabled === 1
          ? <ToggleRight className="w-6 h-6" style={{ color: "var(--neon-purple)" }} />
          : <ToggleLeft  className="w-6 h-6" style={{ color: "var(--text-muted)" }}  />
        }
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScheduleCard — list-based restart / broadcast schedule manager
// ---------------------------------------------------------------------------

interface CardProps {
  serverId: string;
  type: ScheduleType;
  icon: React.ElementType;
  title: string;
  description: string;
  existing: ScheduleRow[];
  onRefresh: () => void;
}

const DEFAULT_RESTART_CFG: RestartConfig = {
  broadcastWarning: true,
  warningMinutes: 15,
  message: "Server restarting in {minutes} minutes. Progress will be saved.",
};

function ScheduleCard({ serverId, type, icon: Icon, title, description, existing, onRefresh }: CardProps) {
  const [config, setConfig] = useState<RestartConfig>(() => ({
    ...DEFAULT_RESTART_CFG,
    ...(parseCfg(existing[0]?.config_json) as Partial<RestartConfig>),
  }));
  const [savingConfig, setSavingConfig] = useState(false);
  const [savedConfig,  setSavedConfig]  = useState(false);

  const [addMode, setAddMode] = useState<AddMode>("daily");
  const [addNum,  setAddNum]  = useState(6);
  const [addTime, setAddTime] = useState("06:00");
  const [addMsg,  setAddMsg]  = useState("");
  const [adding,  setAdding]  = useState(false);

  const hasSchedules = existing.length > 0;

  function patchConfig(patch: Partial<RestartConfig>) {
    setConfig((c) => ({ ...c, ...patch }));
  }

  async function handleSaveConfig() {
    setSavingConfig(true);
    try {
      for (const row of existing) {
        const merged = { ...parseCfg(row.config_json), ...config };
        const nextIso = getNextCronDate(row.cron_expression)?.toISOString() ?? new Date().toISOString();
        await updateScheduleConfig(row.id, row.cron_expression, JSON.stringify(merged), nextIso);
      }
      setSavedConfig(true);
      setTimeout(() => setSavedConfig(false), 2000);
      onRefresh();
      syncSchedulesToRust();
    } catch (e) {
      toast.error(`Failed to save config: ${e}`);
    } finally {
      setSavingConfig(false);
    }
  }

  async function handleAdd() {
    setAdding(true);
    try {
      const cron = buildCronFromMode(addMode, addMode === "daily" ? addTime : addNum);
      const configJson = type === "broadcast"
        ? JSON.stringify({ message: addMsg })
        : JSON.stringify(config);
      const nextIso = getNextCronDate(cron)?.toISOString() ?? new Date().toISOString();
      const newId = await tauriCmd.createSchedule({ serverId, scheduleType: type, cronExpression: cron, configJson });
      const input: CreateScheduleInput = { id: newId, serverId, scheduleType: type, cronExpression: cron, enabled: true, configJson };
      await createSchedule(input);
      await updateScheduleConfig(newId, cron, configJson, nextIso);
      if (type === "broadcast") setAddMsg("");
      toast.success("Schedule added.");
      onRefresh();
      syncSchedulesToRust();
    } catch (e) {
      toast.error(`Failed to add schedule: ${e}`);
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    await tauriCmd.deleteSchedule(id);
    await deleteScheduleRecord(id);
    onRefresh();
    syncSchedulesToRust();
  }

  async function handleToggle(row: ScheduleRow) {
    const newVal = !(row.enabled === 1);
    await tauriCmd.toggleSchedule(row.id, newVal);
    await updateScheduleEnabled(row.id, newVal);
    onRefresh();
    syncSchedulesToRust();
  }

  async function handleSaveRow(row: ScheduleRow, cron: string, configJson: string) {
    const nextIso = getNextCronDate(cron)?.toISOString() ?? new Date().toISOString();
    await updateScheduleConfig(row.id, cron, configJson, nextIso);
    onRefresh();
    syncSchedulesToRust();
  }

  const c = config;

  return (
    <div
      className="glass-card rounded-xl p-4 space-y-4"
      style={{ border: hasSchedules ? "1px solid rgba(var(--neon-purple-rgb),0.25)" : "1px solid rgba(var(--neon-purple-rgb),0.1)" }}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{
            background: hasSchedules ? "rgba(var(--neon-purple-rgb),0.1)" : "rgba(255,255,255,0.04)",
            border: "1px solid rgba(var(--neon-purple-rgb),0.2)",
          }}
        >
          <Icon className="w-4 h-4" style={{ color: hasSchedules ? "var(--neon-purple)" : "var(--text-muted)" }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{title}</h3>
            {hasSchedules && (
              <span className="px-1.5 py-0.5 rounded text-xs"
                style={{ background: "rgba(0,255,136,0.08)", color: "var(--neon-green)", border: "1px solid rgba(0,255,136,0.2)" }}>
                {existing.length} schedule{existing.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{description}</p>
        </div>
      </div>

      {/* Restart shared config */}
      {type === "restart" && (
        <div className="rounded-lg p-3 space-y-2"
          style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)" }}>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={c.broadcastWarning ?? true}
              onChange={(e) => patchConfig({ broadcastWarning: e.target.checked })}
              className="w-3.5 h-3.5 accent-purple-500" />
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              Send in-game warning before restart
            </span>
          </label>
          {c.broadcastWarning && (
            <div className="flex gap-3 items-end pl-5">
              <div className="space-y-1">
                <label className="text-xs" style={{ color: "var(--text-muted)" }}>Warning minutes</label>
                <Input type="number" min={1} max={60} value={c.warningMinutes ?? 15}
                  onChange={(e) => patchConfig({ warningMinutes: parseInt(e.target.value, 10) || 15 })}
                  className="h-7 w-20 text-xs"
                  style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }} />
              </div>
              <div className="flex-1 space-y-1">
                <label className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Message <span style={{ color: "var(--text-subtle)" }}>({"{minutes}"} = countdown)</span>
                </label>
                <Input value={c.message ?? ""}
                  onChange={(e) => patchConfig({ message: e.target.value })}
                  placeholder="Server restarting in {minutes} minutes."
                  className="h-7 text-xs"
                  style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }} />
              </div>
            </div>
          )}
          <Button size="sm" onClick={handleSaveConfig} disabled={savingConfig}
            className="gap-1.5 cursor-pointer"
            style={{
              background: savedConfig ? "rgba(0,255,136,0.15)" : "rgba(var(--neon-purple-rgb),0.15)",
              border:     savedConfig ? "1px solid rgba(0,255,136,0.4)" : "1px solid rgba(var(--neon-purple-rgb),0.4)",
              color:      savedConfig ? "var(--neon-green)" : "var(--neon-purple)",
            }}>
            {savingConfig ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
            : savedConfig  ? <><CheckCircle2 className="w-3.5 h-3.5" /> Saved</>
            : "Save Config"}
          </Button>
        </div>
      )}

      {/* Existing schedule list */}
      {hasSchedules && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Active Schedules</p>
          {existing.map((row) => (
            <ScheduleListRow
              key={row.id} row={row} type={type}
              onDelete={() => handleDelete(row.id)}
              onToggle={() => handleToggle(row)}
              onSave={(cron, configJson) => handleSaveRow(row, cron, configJson)}
            />
          ))}
        </div>
      )}

      {/* Add new schedule */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Add Schedule</p>
        <AddScheduleRow
          mode={addMode} setMode={setAddMode}
          num={addNum} setNum={setAddNum}
          time={addTime} setTime={setAddTime}
          showMessage={type === "broadcast"} message={addMsg} setMessage={setAddMsg}
          onConfirm={handleAdd} busy={adding}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backup schedule section — TimeShift tiers per backup type
// ---------------------------------------------------------------------------

type BackupTier = "H" | "D" | "W" | "M";
type BackupScheduleType = "backup_server" | "backup_player" | "backup_full";

const TIER_FIXED_CRON: Record<BackupTier, string> = {
  M: "0 4 1 * *",
  W: "0 3 * * 0",
  D: "0 2 * * *",
  H: "0 */6 * * *",
};

const TIER_DEFAULT_KEEP: Record<BackupTier, number> = { M: 3, W: 4, D: 7, H: 24 };
const TIER_LABEL: Record<BackupTier, string> = { M: "monthly", W: "weekly", D: "daily", H: "hourly" };
const TIER_ORDER: BackupTier[] = ["M", "W", "D", "H"];
type TierState = { keep: number; enabled: boolean };

function findTierSchedule(schedules: ScheduleRow[], type: BackupScheduleType, tier: BackupTier): ScheduleRow | null {
  return schedules.find((s) => {
    if (s.schedule_type !== type) return false;
    try { return (JSON.parse(s.config_json ?? "{}").tier ?? "H") === tier; }
    catch { return false; }
  }) ?? null;
}

function findFullSchedule(schedules: ScheduleRow[]): ScheduleRow | null {
  return schedules.find((s) => s.schedule_type === "backup_full") ?? null;
}

// ---------------------------------------------------------------------------
// BackupTypeSection — keep-count + toggle rows per tier (hex accent required)
// ---------------------------------------------------------------------------

function BackupTypeSection({
  title, scheduleType, serverId, schedules, onRefresh, accentHex,
}: {
  title: string;
  scheduleType: BackupScheduleType;
  serverId: string;
  schedules: ScheduleRow[];
  onRefresh: () => void;
  accentHex: string;
}) {
  const buildState = (): Record<BackupTier, TierState> => {
    const s = {} as Record<BackupTier, TierState>;
    for (const tier of TIER_ORDER) {
      const row = findTierSchedule(schedules, scheduleType, tier);
      const cfg = row?.config_json ? parseCfg(row.config_json) : {};
      s[tier] = { keep: (cfg.keep as number) ?? TIER_DEFAULT_KEEP[tier], enabled: row ? row.enabled === 1 : false };
    }
    return s;
  };

  const [tiers, setTiers] = useState<Record<BackupTier, TierState>>(buildState);
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);

  useEffect(() => { setTiers(buildState()); }, [schedules.length, serverId, scheduleType]);

  const patch = (tier: BackupTier, delta: Partial<TierState>) =>
    setTiers((s) => ({ ...s, [tier]: { ...s[tier], ...delta } }));

  async function handleSave() {
    setSaving(true);
    try {
      for (const tier of TIER_ORDER) {
        const { keep, enabled } = tiers[tier];
        const existing  = findTierSchedule(schedules, scheduleType, tier);
        const configJson = JSON.stringify({ tier, keep });
        const cron       = TIER_FIXED_CRON[tier];
        const nextIso    = getNextCronDate(cron)?.toISOString() ?? new Date().toISOString();
        if (existing) {
          await updateScheduleConfig(existing.id, cron, configJson, nextIso);
          if (enabled !== (existing.enabled === 1)) await updateScheduleEnabled(existing.id, enabled);
        } else if (enabled) {
          const newId = await tauriCmd.createSchedule({ serverId, scheduleType, cronExpression: cron, configJson });
          await createSchedule({ id: newId, serverId, scheduleType, cronExpression: cron, enabled: true, configJson });
          await updateScheduleConfig(newId, cron, configJson, nextIso);
        }
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onRefresh();
      syncSchedulesToRust();
    } catch (e) {
      toast.error(`Failed to save ${title}: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold pb-0.5" style={{ color: "var(--text-primary)" }}>{title}</p>
      {TIER_ORDER.map((tier) => (
        <div
          key={tier}
          className="flex items-center gap-3 px-3 py-2 rounded-lg"
          style={{
            background: "rgba(255,255,255,0.02)",
            border: `1px solid ${tiers[tier].enabled ? "rgba(var(--neon-purple-rgb),0.3)" : "rgba(255,255,255,0.05)"}`,
          }}
        >
          <Input
            type="number" min={1} max={999}
            value={tiers[tier].keep}
            onChange={(e) => patch(tier, { keep: Math.max(1, parseInt(e.target.value, 10) || 1) })}
            className="w-16 h-8 text-sm text-center shrink-0"
            style={{
              background: "rgba(0,0,0,0.4)",
              border: `1px solid ${tiers[tier].enabled ? "rgba(var(--neon-purple-rgb),0.35)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
              color: "var(--text-primary)",
            }}
          />
          <span className="flex-1 text-sm" style={{ color: "var(--text-muted)" }}>
            {TIER_LABEL[tier]} backups to keep
          </span>
          <button onClick={() => patch(tier, { enabled: !tiers[tier].enabled })}
            className="cursor-pointer shrink-0" title={tiers[tier].enabled ? "Disable" : "Enable"}>
            {tiers[tier].enabled
              ? <ToggleRight className="w-6 h-6" style={{ color: "var(--neon-purple)" }} />
              : <ToggleLeft  className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
            }
          </button>
        </div>
      ))}
      <Button size="sm" onClick={handleSave} disabled={saving}
        className="gap-1.5 cursor-pointer"
        style={{
          background: saved ? "rgba(0,255,136,0.15)" : "rgba(var(--neon-purple-rgb),0.15)",
          border:     saved ? "1px solid rgba(0,255,136,0.4)" : "1px solid rgba(var(--neon-purple-rgb),0.4)",
          color:      saved ? "var(--neon-green)" : "var(--neon-purple)",
        }}>
        {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
        : saved  ? <><CheckCircle2 className="w-3.5 h-3.5" /> Saved</>
        : "Save Changes"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FullBackupScheduleSection
// ---------------------------------------------------------------------------

function FullBackupScheduleSection({ serverId, schedules, onRefresh }: {
  serverId: string; schedules: ScheduleRow[]; onRefresh: () => void;
}) {
  const existing = findFullSchedule(schedules);
  const cfg = parseCfg(existing?.config_json);

  const [keep,    setKeep]    = useState<number>((cfg.keep as number) ?? 3);
  const [enabled, setEnabled] = useState(existing ? existing.enabled === 1 : false);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);

  useEffect(() => {
    const row = findFullSchedule(schedules);
    const c = parseCfg(row?.config_json);
    setKeep((c.keep as number) ?? 3);
    setEnabled(row ? row.enabled === 1 : false);
  }, [schedules.length, serverId]);

  async function handleSave() {
    setSaving(true);
    try {
      const configJson = JSON.stringify({ keep });
      const cron = "0 3 1 * *";
      const nextIso = getNextCronDate(cron)?.toISOString() ?? new Date().toISOString();
      if (existing) {
        await updateScheduleConfig(existing.id, cron, configJson, nextIso);
        if (enabled !== (existing.enabled === 1)) await updateScheduleEnabled(existing.id, enabled);
      } else if (enabled) {
        const newId = await tauriCmd.createSchedule({ serverId, scheduleType: "backup_full", cronExpression: cron, configJson });
        await createSchedule({ id: newId, serverId, scheduleType: "backup_full", cronExpression: cron, enabled: true, configJson });
        await updateScheduleConfig(newId, cron, configJson, nextIso);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onRefresh();
      syncSchedulesToRust();
    } catch (e) {
      toast.error(`Failed to save full backup schedule: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold pb-0.5" style={{ color: "var(--text-primary)" }}>Full Backups</p>
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg"
        style={{
          background: "rgba(255,255,255,0.02)",
          border: `1px solid ${enabled ? "rgba(var(--neon-purple-rgb),0.3)" : "rgba(255,255,255,0.05)"}`,
        }}>
        <Input type="number" min={1} max={20} value={keep}
          onChange={(e) => setKeep(Math.max(1, parseInt(e.target.value, 10) || 1))}
          className="w-16 h-8 text-sm text-center shrink-0"
          style={{
            background: "rgba(0,0,0,0.4)",
            border: `1px solid ${enabled ? "rgba(var(--neon-purple-rgb),0.35)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
            color: "var(--text-primary)",
          }} />
        <span className="flex-1 text-sm" style={{ color: "var(--text-muted)" }}>full backups to keep</span>
        <button onClick={() => setEnabled((v) => !v)} className="cursor-pointer shrink-0">
          {enabled
            ? <ToggleRight className="w-6 h-6" style={{ color: "var(--neon-purple)" }} />
            : <ToggleLeft  className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
          }
        </button>
      </div>
      <p className="text-xs px-1" style={{ color: "var(--text-muted)" }}>
        Zips the entire install folder — runs monthly on the 1st at 3am.
      </p>
      <Button size="sm" onClick={handleSave} disabled={saving}
        className="gap-1.5 cursor-pointer"
        style={{
          background: saved ? "rgba(0,255,136,0.15)" : "rgba(var(--neon-purple-rgb),0.15)",
          border:     saved ? "1px solid rgba(0,255,136,0.4)" : "1px solid rgba(var(--neon-purple-rgb),0.4)",
          color:      saved ? "var(--neon-green)" : "var(--neon-purple)",
        }}>
        {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
        : saved  ? <><CheckCircle2 className="w-3.5 h-3.5" /> Saved</>
        : "Save Changes"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BackupScheduleSection
// ---------------------------------------------------------------------------

function BackupScheduleSection({ serverId, schedules, onRefresh }: {
  serverId: string; schedules: ScheduleRow[]; onRefresh: () => void;
}) {
  return (
    <div id="backup-schedules-section"
      className="glass-card rounded-xl p-4 space-y-5"
      style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}>
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: "rgba(var(--neon-purple-rgb),0.08)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
          <HardDrive className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
        </div>
        <div>
          <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Backup Schedules</p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            TimeShift — each tier keeps its own independent set of backups
          </p>
        </div>
      </div>

      <div className="space-y-5 border-t pt-4" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.08)" }}>
        <BackupTypeSection title="Server Backups" scheduleType="backup_server"
          serverId={serverId} schedules={schedules} onRefresh={onRefresh}
          accentHex="#bf00ff" />
        <div className="border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }} />
        <BackupTypeSection title="Player Backups" scheduleType="backup_player"
          serverId={serverId} schedules={schedules} onRefresh={onRefresh}
          accentHex="#00ffff" />
        <div className="border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }} />
        <FullBackupScheduleSection serverId={serverId} schedules={schedules} onRefresh={onRefresh} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UpdateAutomationCard
// ---------------------------------------------------------------------------

const DEFAULT_UPDATE_AUTOMATION: UpdateAutomation = {
  mode: "off",
  update_time: "03:00",
  restart_after_update: true,
  only_if_running: true,
};

function UpdateAutomationCard({ server }: { server: ServerRow }) {
  const [automation, setAutomation] = useState<UpdateAutomation>(DEFAULT_UPDATE_AUTOMATION);
  const [autoCheckEnabled, setAutoCheckEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      const hours = await getAppSetting("asa_auto_check_hours");
      setAutoCheckEnabled((hours ?? "0") !== "0");
      try {
        const raw = server.update_automation_json;
        if (raw && raw !== "{}") {
          setAutomation({ ...DEFAULT_UPDATE_AUTOMATION, ...JSON.parse(raw) });
        }
      } catch { /* malformed JSON */ }
    })();
  }, [server.id, server.update_automation_json]);

  const handleSave = async (patch: Partial<UpdateAutomation>) => {
    const next = { ...automation, ...patch };
    setAutomation(next);
    setSaving(true);
    try {
      await setServerUpdateAutomation(server.id, next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      toast.error(`Failed to save update automation: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const isActive = automation.mode !== "off";

  return (
    <div className="glass-card rounded-xl p-4 space-y-4"
      style={{
        border: isActive ? "1px solid rgba(var(--neon-purple-rgb),0.3)" : "1px solid rgba(var(--neon-purple-rgb),0.1)",
        opacity: isActive ? 1 : 0.75,
      }}>
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: isActive ? "rgba(var(--neon-purple-rgb),0.1)" : "rgba(255,255,255,0.04)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
          <ArrowUp className="w-4 h-4" style={{ color: isActive ? "var(--neon-purple)" : "var(--text-muted)" }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Auto-Update</h3>
            {isActive && (
              <span className="px-1.5 py-0.5 rounded text-xs"
                style={{ background: "rgba(255,165,0,0.08)", color: "#ffa500", border: "1px solid rgba(255,165,0,0.2)" }}>
                Active
              </span>
            )}
            {saving && <Loader2 className="w-3 h-3 animate-spin" style={{ color: "var(--text-muted)" }} />}
            {saved  && <CheckCircle2 className="w-3 h-3" style={{ color: "var(--neon-green)" }} />}
          </div>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Automatically apply cached server updates when available.
          </p>
        </div>
      </div>

      {!autoCheckEnabled && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
          style={{ background: "rgba(255,165,0,0.06)", border: "1px solid rgba(255,165,0,0.2)", color: "rgba(255,165,0,0.8)" }}>
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>Auto update checks are disabled in Settings. Enable a check interval there for automation to work.</span>
        </div>
      )}

      <div className="space-y-2">
        <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Update Trigger</label>
        <div className="flex gap-2 flex-wrap">
          {([
            { value: "off",         label: "Disabled",      icon: null },
            { value: "immediately", label: "When Found",    icon: Zap },
            { value: "at_time",     label: "Daily at Time", icon: Clock },
          ] as const).map(({ value, label, icon: BtnIcon }) => (
            <button key={value} type="button" onClick={() => handleSave({ mode: value })}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all"
              style={{
                background: automation.mode === value ? "rgba(var(--neon-purple-rgb),0.12)" : "transparent",
                border: `1px solid ${automation.mode === value ? "rgba(var(--neon-purple-rgb),0.4)" : "rgba(var(--neon-purple-rgb),0.2)"}`,
                color: automation.mode === value ? "var(--neon-purple)" : "var(--text-muted)",
              }}>
              {BtnIcon && <BtnIcon className="w-3 h-3" />}
              {label}
            </button>
          ))}
        </div>

        {automation.mode === "at_time" && (
          <div className="flex items-center gap-3 pl-1">
            <label className="text-xs" style={{ color: "var(--text-muted)" }}>Update time (daily):</label>
            <input type="time" value={automation.update_time}
              onChange={(e) => handleSave({ update_time: e.target.value })}
              className="h-7 rounded px-2 text-xs font-mono"
              style={{ background: "rgba(0,0,0,0.35)", border: "1px solid rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-primary)", outline: "none" }} />
          </div>
        )}

        {automation.mode !== "off" && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
            style={{ background: "rgba(var(--neon-purple-rgb),0.04)", border: "1px solid rgba(var(--neon-purple-rgb),0.12)", color: "var(--text-muted)" }}>
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--neon-cyan)" }} />
            <span>
              Automated triggers are coming in a future update once proper RCON shutdown is implemented.
              Settings are saved now so configuration is ready when the feature ships. Use the{" "}
              <strong style={{ color: "var(--text-primary)" }}>Update</strong> button on server cards for manual updates.
            </span>
          </div>
        )}
      </div>

      {automation.mode !== "off" && (
        <div className="space-y-2 border-t pt-3" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.1)" }}>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={automation.restart_after_update}
              onChange={(e) => handleSave({ restart_after_update: e.target.checked })}
              className="w-3.5 h-3.5"
              style={{ accentColor: "var(--neon-purple)" }} />
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>Restart server after update</span>
          </label>
          {automation.restart_after_update && (
            <label className="flex items-center gap-2 cursor-pointer select-none pl-5">
              <input type="checkbox" checked={automation.only_if_running}
                onChange={(e) => handleSave({ only_if_running: e.target.checked })}
                className="w-3.5 h-3.5"
                style={{ accentColor: "var(--neon-purple)" }} />
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>Only restart if server was already running</span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CARD_DEFS
// ---------------------------------------------------------------------------

const CARD_DEFS: { type: ScheduleType; icon: React.ElementType; title: string; description: string }[] = [
  { type: "restart",   icon: RotateCcw, title: "Auto-Restart",           description: "Gracefully restart the server on a schedule with optional in-game warnings." },
  { type: "broadcast", icon: Megaphone, title: "Scheduled Chat Message", description: "Send a recurring global chat message to all online players via RCON." },
];

// ---------------------------------------------------------------------------
// AutomationTab
// ---------------------------------------------------------------------------

interface Props { server: ServerRow }

export function AutomationTab({ server }: Props) {
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSchedules = useCallback(async () => {
    setLoading(true);
    try { setSchedules(await getServerSchedules(server.id)); }
    catch (e) { toast.error(`Failed to load schedules: ${e}`); }
    finally { setLoading(false); }
  }, [server.id]);

  useEffect(() => { loadSchedules(); }, [loadSchedules]);

  function schedulesFor(type: ScheduleType): ScheduleRow[] {
    return schedules.filter((s) => s.schedule_type === type);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg text-xs"
        style={{ background: "rgba(var(--neon-purple-rgb),0.04)", border: "1px solid rgba(var(--neon-purple-rgb),0.15)", color: "var(--text-muted)" }}>
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--neon-cyan)" }} />
        <span>
          Schedules only fire while <strong style={{ color: "var(--text-primary)" }}>LokiASAM is running</strong>.
          {" "}Keep the app open for automated tasks to execute on time.
        </span>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarClock className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Automation</h2>
        </div>
        <Button size="sm" variant="outline" onClick={loadSchedules} disabled={loading}
          className="h-8 gap-1.5 cursor-pointer"
          style={{ border: "1px solid rgba(255,255,255,0.1)", color: "var(--text-muted)" }}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="glass-card rounded-xl h-28 animate-pulse"
              style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }} />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          <UpdateAutomationCard server={server} />
          <BackupScheduleSection serverId={server.id} schedules={schedules} onRefresh={loadSchedules} />
          {CARD_DEFS.map((def) => (
            <ScheduleCard
              key={def.type}
              serverId={server.id}
              type={def.type}
              icon={def.icon}
              title={def.title}
              description={def.description}
              existing={schedulesFor(def.type)}
              onRefresh={loadSchedules}
            />
          ))}
        </div>
      )}

    </div>
  );
}

