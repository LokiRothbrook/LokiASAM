"use client";

/**
 * ServerCreationWizard — 7-step wizard for creating and installing a new ASA server.
 *
 * Steps:
 *   0 - Basic Info       (name, map, max players, passwords)
 *   1 - Preset           (choose a server preset)
 *   2 - Network & Ports  (game/query/rcon ports)
 *   3 - Cluster          (optional cluster join)
 *   4 - Automation       (auto-update, restart, backup crons)
 *   5 - Mods             (initial mod IDs)
 *   6 - Install          (summary + SteamCMD install)
 */

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  Server, Map, Network, GitBranch, Clock, Package,
  Download, ArrowRight, ArrowLeft, Loader2, AlertCircle,
  CheckCircle2, Plus, X, ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { CommandOutputPanel } from "@/components/shared/CommandOutputPanel";
import {
  getReleasedMaps,
  SERVER_PRESETS,
  type ArkMap,
  type ServerPreset,
} from "@/data/game-data";
import {
  getAppSetting,
  createServer,
  saveServerConfig,
  createSchedule,
  getClusters,
  isServerNameTaken,
  type ClusterRow,
} from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Wizard state
// ---------------------------------------------------------------------------

interface WizardData {
  // Step 0 — Basic Info
  name: string;
  mapId: string;
  maxPlayers: number;
  serverPassword: string;
  adminPassword: string;
  // Step 1 — Preset
  presetId: string;
  // Step 2 — Network
  port: number;
  queryPort: number;
  rconPort: number;
  rconPassword: string;
  // Step 3 — Cluster
  clusterId: string;
  // Step 4 — Automation
  autoUpdate: boolean;
  autoUpdateCron: string;
  autoRestart: boolean;
  autoRestartCron: string;
  autoBackup: boolean;
  autoBackupCron: string;
  backupRetention: number;
  // Step 5 — Mods
  modIds: string[];
}

const DEFAULT_DATA: WizardData = {
  name: "",
  mapId: "theisland",
  maxPlayers: 70,
  serverPassword: "",
  adminPassword: "",
  presetId: "vanilla",
  port: 7777,
  queryPort: 27015,
  rconPort: 27020,
  rconPassword: "",
  clusterId: "",
  autoUpdate: true,
  autoUpdateCron: "0 3 * * *",
  autoRestart: true,
  autoRestartCron: "0 6 * * *",
  autoBackup: true,
  autoBackupCron: "0 */6 * * *",
  backupRetention: 10,
  modIds: [],
};

const STEPS = [
  { label: "Basic Info",  icon: Server },
  { label: "Preset",      icon: Map },
  { label: "Network",     icon: Network },
  { label: "Cluster",     icon: GitBranch },
  { label: "Automation",  icon: Clock },
  { label: "Mods",        icon: Package },
  { label: "Install",     icon: Download },
];

const stepVariants = {
  enter:  (dir: number) => ({ x: dir > 0 ? 40 : -40, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit:   (dir: number) => ({ x: dir > 0 ? -40 : 40, opacity: 0 }),
};

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function humanCron(cron: string): string {
  const map: Record<string, string> = {
    "0 3 * * *":   "Daily at 3:00 AM",
    "0 6 * * *":   "Daily at 6:00 AM",
    "0 */6 * * *": "Every 6 hours",
    "0 */12 * * *":"Every 12 hours",
    "0 0 * * *":   "Daily at midnight",
  };
  return map[cron] ?? cron;
}

// ---------------------------------------------------------------------------
// Step 0 — Basic Info
// ---------------------------------------------------------------------------

function BasicInfoStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const maps = getReleasedMaps();
  const [nameError, setNameError] = useState("");
  const [checkingName, setCheckingName] = useState(false);

  const checkName = useCallback(async (name: string) => {
    if (!name.trim()) { setNameError("Server name is required."); return; }
    setCheckingName(true);
    try {
      const taken = await isServerNameTaken(name.trim());
      setNameError(taken ? "A server with this name already exists." : "");
    } catch {
      setNameError("");
    } finally {
      setCheckingName(false);
    }
  }, []);

  return (
    <div className="space-y-5">
      {/* Name */}
      <div className="space-y-1.5">
        <Label style={{ color: "var(--text-primary)" }}>Server Name <span style={{ color: "var(--neon-red)" }}>*</span></Label>
        <Input
          value={data.name}
          onChange={(e) => onChange({ name: e.target.value })}
          onBlur={(e) => checkName(e.target.value)}
          placeholder="My ASA Server"
          style={{
            background: "rgba(10,10,30,0.8)",
            borderColor: nameError ? "var(--neon-red)" : "rgba(191,0,255,0.3)",
            color: "var(--text-primary)",
          }}
        />
        {nameError && (
          <p className="text-xs flex items-center gap-1" style={{ color: "var(--neon-red)" }}>
            <AlertCircle className="w-3 h-3" /> {nameError}
            {checkingName && <Loader2 className="w-3 h-3 animate-spin ml-1" />}
          </p>
        )}
      </div>

      {/* Map */}
      <div className="space-y-1.5">
        <Label style={{ color: "var(--text-primary)" }}>Map</Label>
        <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
          {maps.map((m: ArkMap) => (
            <button
              key={m.id}
              onClick={() => onChange({ mapId: m.id })}
              className="rounded-lg p-3 text-left transition-all"
              style={{
                background: data.mapId === m.id ? "rgba(191,0,255,0.12)" : "rgba(10,10,30,0.5)",
                border: `1px solid ${data.mapId === m.id ? "rgba(191,0,255,0.5)" : "rgba(191,0,255,0.15)"}`,
              }}
            >
              <p className="text-xs font-semibold" style={{ color: data.mapId === m.id ? "var(--neon-purple)" : "var(--text-primary)" }}>
                {m.displayName}
              </p>
              {m.dlcRequired && (
                <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>DLC: {m.dlcName}</p>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Max Players */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label style={{ color: "var(--text-primary)" }}>Max Players</Label>
          <span className="text-sm font-mono font-bold" style={{ color: "var(--neon-purple)" }}>
            {data.maxPlayers}
          </span>
        </div>
        <Slider
          min={1} max={200} step={1}
          value={[data.maxPlayers]}
          onValueChange={([v]) => onChange({ maxPlayers: v })}
        />
      </div>

      {/* Passwords */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label style={{ color: "var(--text-primary)" }}>Server Password <span style={{ color: "var(--text-muted)" }}>(optional)</span></Label>
          <Input
            type="password"
            value={data.serverPassword}
            onChange={(e) => onChange({ serverPassword: e.target.value })}
            placeholder="Leave blank for public"
            style={{ background: "rgba(10,10,30,0.8)", borderColor: "rgba(191,0,255,0.3)", color: "var(--text-primary)" }}
          />
        </div>
        <div className="space-y-1.5">
          <Label style={{ color: "var(--text-primary)" }}>Admin Password <span style={{ color: "var(--neon-red)" }}>*</span></Label>
          <Input
            type="password"
            value={data.adminPassword}
            onChange={(e) => onChange({ adminPassword: e.target.value })}
            placeholder="Required"
            style={{
              background: "rgba(10,10,30,0.8)",
              borderColor: !data.adminPassword ? "var(--neon-red)" : "rgba(191,0,255,0.3)",
              color: "var(--text-primary)",
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Preset
// ---------------------------------------------------------------------------

function PresetStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const selectedPreset = SERVER_PRESETS.find((p) => p.id === data.presetId);

  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Choose a starting configuration. Settings can be fine-tuned in the Config editor after creation.
      </p>
      <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
        {SERVER_PRESETS.map((preset: ServerPreset) => {
          const active = data.presetId === preset.id;
          return (
            <button
              key={preset.id}
              onClick={() => onChange({ presetId: preset.id })}
              className="w-full rounded-lg p-4 text-left transition-all"
              style={{
                background: active ? "rgba(191,0,255,0.1)" : "rgba(10,10,30,0.5)",
                border: `1px solid ${active ? "rgba(191,0,255,0.5)" : "rgba(191,0,255,0.12)"}`,
                boxShadow: active ? "0 0 16px rgba(191,0,255,0.1)" : "none",
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold" style={{ color: active ? "var(--neon-purple)" : "var(--text-primary)" }}>
                    {preset.displayName}
                  </p>
                  <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{preset.description}</p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {preset.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          background: active ? "rgba(191,0,255,0.15)" : "rgba(191,0,255,0.07)",
                          color: active ? "var(--neon-purple)" : "var(--text-muted)",
                          border: "1px solid rgba(191,0,255,0.2)",
                        }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
                {active && <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "var(--neon-purple)" }} />}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Network & Ports
// ---------------------------------------------------------------------------

function NetworkStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const [portStatus, setPortStatus] = useState<Record<string, boolean | null>>({});
  const [checking, setChecking] = useState(false);

  const checkPort = async (portKey: keyof WizardData, port: number) => {
    setChecking(true);
    try {
      const available = await tauriCmd.checkPortAvailable(port);
      setPortStatus((prev) => ({ ...prev, [portKey]: available }));
    } catch {
      setPortStatus((prev) => ({ ...prev, [portKey]: null }));
    } finally {
      setChecking(false);
    }
  };

  const PortField = ({
    label,
    fieldKey,
    description,
  }: {
    label: string;
    fieldKey: "port" | "queryPort" | "rconPort";
    description: string;
  }) => {
    const val = data[fieldKey] as number;
    const status = portStatus[fieldKey];
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label style={{ color: "var(--text-primary)" }}>{label}</Label>
          {status === true && <span className="text-[10px]" style={{ color: "var(--neon-green)" }}>Available</span>}
          {status === false && <span className="text-[10px]" style={{ color: "var(--neon-red)" }}>In use!</span>}
        </div>
        <Input
          type="number"
          min={1024} max={65535}
          value={val}
          onChange={(e) => onChange({ [fieldKey]: Number(e.target.value) })}
          onBlur={() => checkPort(fieldKey, val)}
          className="font-mono"
          style={{
            background: "rgba(10,10,30,0.8)",
            borderColor: status === false ? "var(--neon-red)" : status === true ? "rgba(0,255,136,0.4)" : "rgba(191,0,255,0.3)",
            color: "var(--text-primary)",
          }}
        />
        <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>{description}</p>
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Configure the ports this server will listen on. Ports are validated against currently running
        services. Each server needs its own unique set of three ports.
      </p>

      <PortField label="Game Port" fieldKey="port" description="Clients connect here (UDP). Default: 7777" />
      <PortField label="Query Port" fieldKey="queryPort" description="Steam server browser (UDP). Default: 27015" />
      <PortField label="RCON Port" fieldKey="rconPort" description="Remote console (TCP). Default: 27020" />

      <div className="space-y-1.5">
        <Label style={{ color: "var(--text-primary)" }}>RCON Password <span style={{ color: "var(--neon-red)" }}>*</span></Label>
        <Input
          type="password"
          value={data.rconPassword}
          onChange={(e) => onChange({ rconPassword: e.target.value })}
          placeholder="RCON password for remote console"
          style={{
            background: "rgba(10,10,30,0.8)",
            borderColor: !data.rconPassword ? "var(--neon-red)" : "rgba(191,0,255,0.3)",
            color: "var(--text-primary)",
          }}
        />
      </div>

      {checking && (
        <p className="text-xs flex items-center gap-1" style={{ color: "var(--text-muted)" }}>
          <Loader2 className="w-3 h-3 animate-spin" /> Checking port availability…
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Cluster
// ---------------------------------------------------------------------------

function ClusterStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const [clusters, setClusters] = useState<ClusterRow[]>([]);
  const [joinCluster, setJoinCluster] = useState(!!data.clusterId);

  useEffect(() => {
    getClusters().then(setClusters).catch(() => {});
  }, []);

  return (
    <div className="space-y-5">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Clusters allow players to transfer characters and dinos between servers. Optional — you can
        always add this server to a cluster later.
      </p>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Join a Cluster</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Enable cross-server travel</p>
        </div>
        <Switch
          checked={joinCluster}
          onCheckedChange={(v) => {
            setJoinCluster(v);
            if (!v) onChange({ clusterId: "" });
          }}
        />
      </div>

      {joinCluster && (
        <div className="space-y-2">
          {clusters.length === 0 ? (
            <div
              className="rounded-lg p-4 text-center"
              style={{ background: "rgba(191,0,255,0.05)", border: "1px solid rgba(191,0,255,0.15)" }}
            >
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                No clusters yet. Create one from the Clusters page after setup.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {clusters.map((cluster) => (
                <button
                  key={cluster.id}
                  onClick={() => onChange({ clusterId: cluster.id })}
                  className="w-full rounded-lg p-3 text-left transition-all"
                  style={{
                    background: data.clusterId === cluster.id ? "rgba(191,0,255,0.1)" : "rgba(10,10,30,0.5)",
                    border: `1px solid ${data.clusterId === cluster.id ? "rgba(191,0,255,0.5)" : "rgba(191,0,255,0.15)"}`,
                  }}
                >
                  <p className="text-sm font-medium" style={{ color: data.clusterId === cluster.id ? "var(--neon-purple)" : "var(--text-primary)" }}>
                    {cluster.name}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Automation
// ---------------------------------------------------------------------------

const CRON_OPTIONS = [
  { value: "0 3 * * *",   label: "Daily at 3:00 AM" },
  { value: "0 6 * * *",   label: "Daily at 6:00 AM" },
  { value: "0 0 * * *",   label: "Daily at midnight" },
  { value: "0 */6 * * *", label: "Every 6 hours" },
  { value: "0 */12 * * *",label: "Every 12 hours" },
];

function CronPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select
      value={CRON_OPTIONS.find((o) => o.value === value) ? value : "custom"}
      onChange={(e) => onChange(e.target.value === "custom" ? value : e.target.value)}
      className="w-full text-xs rounded px-2 py-1.5 font-mono"
      style={{
        background: "rgba(10,10,30,0.8)",
        border: "1px solid rgba(191,0,255,0.3)",
        color: "var(--text-primary)",
        outline: "none",
      }}
    >
      {CRON_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
      <option value="custom">Custom…</option>
    </select>
  );
}

function AutomationStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const schedules = [
    {
      key: "autoUpdate" as const,
      cronKey: "autoUpdateCron" as const,
      label: "Auto-Update",
      desc: "Download and apply ASA server updates automatically",
    },
    {
      key: "autoRestart" as const,
      cronKey: "autoRestartCron" as const,
      label: "Auto-Restart",
      desc: "Restart the server on a schedule with an in-game broadcast warning",
    },
    {
      key: "autoBackup" as const,
      cronKey: "autoBackupCron" as const,
      label: "Auto-Backup",
      desc: "Create scheduled save-game ZIP backups",
    },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Configure automation schedules. All times are in your local timezone. You can adjust these later.
      </p>

      {schedules.map(({ key, cronKey, label, desc }) => (
        <div
          key={key}
          className="rounded-lg p-4 space-y-3"
          style={{
            background: "rgba(10,10,30,0.5)",
            border: `1px solid ${data[key] ? "rgba(191,0,255,0.3)" : "rgba(191,0,255,0.12)"}`,
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{label}</p>
              <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{desc}</p>
            </div>
            <Switch
              checked={data[key] as boolean}
              onCheckedChange={(v) => onChange({ [key]: v })}
            />
          </div>
          {data[key] && (
            <CronPicker
              value={data[cronKey] as string}
              onChange={(v) => onChange({ [cronKey]: v })}
            />
          )}
        </div>
      ))}

      {data.autoBackup && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label style={{ color: "var(--text-primary)" }}>Keep last N backups</Label>
            <span className="font-mono text-sm" style={{ color: "var(--neon-purple)" }}>
              {data.backupRetention}
            </span>
          </div>
          <Slider
            min={1} max={50} step={1}
            value={[data.backupRetention]}
            onValueChange={([v]) => onChange({ backupRetention: v })}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 5 — Mods
// ---------------------------------------------------------------------------

function ModsStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const [input, setInput] = useState("");

  const addMod = () => {
    const id = input.trim();
    if (!id || data.modIds.includes(id)) { setInput(""); return; }
    onChange({ modIds: [...data.modIds, id] });
    setInput("");
  };

  const removeMod = (id: string) =>
    onChange({ modIds: data.modIds.filter((m) => m !== id) });

  return (
    <div className="space-y-5">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Add initial mods by CurseForge mod ID. The full mod browser is available on the server&apos;s Mods tab
        after creation. Leave empty to start with no mods.
      </p>

      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addMod()}
          placeholder="CurseForge mod ID (e.g. 928793)"
          className="font-mono text-sm"
          style={{
            background: "rgba(10,10,30,0.8)",
            borderColor: "rgba(191,0,255,0.3)",
            color: "var(--text-primary)",
          }}
        />
        <Button
          onClick={addMod}
          variant="outline"
          size="sm"
          className="gap-1 shrink-0"
          style={{ borderColor: "rgba(191,0,255,0.4)", color: "var(--neon-purple)", background: "rgba(191,0,255,0.05)" }}
        >
          <Plus className="w-4 h-4" /> Add
        </Button>
      </div>

      {data.modIds.length === 0 ? (
        <div
          className="rounded-lg p-4 text-center"
          style={{ background: "rgba(191,0,255,0.04)", border: "1px dashed rgba(191,0,255,0.2)" }}
        >
          <Package className="w-8 h-8 mx-auto mb-2" style={{ color: "var(--text-subtle)" }} />
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>No mods added. You can add mods later.</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {data.modIds.map((id, i) => (
            <div
              key={id}
              className="flex items-center justify-between px-3 py-2 rounded-lg"
              style={{ background: "rgba(10,10,30,0.6)", border: "1px solid rgba(191,0,255,0.15)" }}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs" style={{ color: "var(--text-subtle)" }}>#{i + 1}</span>
                <span className="text-sm font-mono" style={{ color: "var(--text-primary)" }}>{id}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeMod(id)}
                className="h-6 w-6 p-0"
                style={{ color: "var(--text-muted)" }}
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 6 — Install
// ---------------------------------------------------------------------------

function InstallStep({
  data,
  serverId,
  onInstallComplete,
}: {
  data: WizardData;
  serverId: string;
  onInstallComplete: () => void;
}) {
  const [status, setStatus] = useState<"idle" | "installing" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const selectedPreset = SERVER_PRESETS.find((p) => p.id === data.presetId);
  const maps = getReleasedMaps();
  const selectedMap = maps.find((m: ArkMap) => m.id === data.mapId);

  const summaryItems = [
    { label: "Server Name",  value: data.name },
    { label: "Map",          value: selectedMap?.displayName ?? data.mapId },
    { label: "Preset",       value: selectedPreset?.displayName ?? data.presetId },
    { label: "Max Players",  value: String(data.maxPlayers) },
    { label: "Ports",        value: `${data.port} / ${data.queryPort} / ${data.rconPort}` },
    { label: "Auto-Update",  value: data.autoUpdate ? humanCron(data.autoUpdateCron) : "Disabled" },
    { label: "Auto-Restart", value: data.autoRestart ? humanCron(data.autoRestartCron) : "Disabled" },
    { label: "Auto-Backup",  value: data.autoBackup ? `${humanCron(data.autoBackupCron)}, keep ${data.backupRetention}` : "Disabled" },
    { label: "Mods",         value: data.modIds.length > 0 ? `${data.modIds.length} mod(s)` : "None" },
  ];

  const startInstall = async () => {
    setStatus("installing");
    setError("");

    try {
      // Fetch stored settings from SQLite
      const [baseDir, steamcmdPath] = await Promise.all([
        getAppSetting("base_dir"),
        getAppSetting("steamcmd_path"),
      ]);

      if (!baseDir) throw new Error("Base directory not configured. Please run Setup first.");
      if (!steamcmdPath) throw new Error("SteamCMD path not configured. Please run Setup first.");

      const sep = baseDir.includes("\\") ? "\\" : "/";
      const installPath = `${baseDir}${sep}servers${sep}${data.name}`;

      // Persist server record to SQLite
      await createServer({
        id: serverId,
        name: data.name,
        mapId: data.mapId,
        installPath,
        port: data.port,
        queryPort: data.queryPort,
        rconPort: data.rconPort,
        rconPassword: data.rconPassword,
        maxPlayers: data.maxPlayers,
        serverPassword: data.serverPassword || undefined,
        adminPassword: data.adminPassword,
        clusterId: data.clusterId || undefined,
        presetId: data.presetId,
      });

      // Persist empty config record (will be written to disk after install)
      await saveServerConfig(serverId, "{}", "{}", "{}");

      // Create schedule records
      const scheduleEntries = [
        { enabled: data.autoUpdate,  cron: data.autoUpdateCron,  type: "update" },
        { enabled: data.autoRestart, cron: data.autoRestartCron, type: "restart" },
        { enabled: data.autoBackup,  cron: data.autoBackupCron,  type: "backup" },
      ];
      for (const s of scheduleEntries) {
        if (s.enabled) {
          await createSchedule({
            id: generateUUID(),
            serverId,
            scheduleType: s.type,
            cronExpression: s.cron,
            enabled: true,
            configJson: s.type === "backup"
              ? JSON.stringify({ retention: data.backupRetention })
              : "{}",
          });
        }
      }

      // Run SteamCMD install (streams live output)
      await tauriCmd.installServer(serverId, installPath, steamcmdPath);

      // Write INI files from preset defaults
      const preset = SERVER_PRESETS.find((p) => p.id === data.presetId);
      const gusJson: Record<string, Record<string, string>> = {
        SessionSettings: {
          SessionName: data.name,
          ServerPassword: data.serverPassword,
          QueryPort: String(data.queryPort),
          Port: String(data.port),
          MaxPlayers: String(data.maxPlayers),
        },
        ServerSettings: {
          RCONEnabled: "True",
          RCONPort: String(data.rconPort),
          ServerAdminPassword: data.adminPassword,
          AllowPvP: String(preset?.gameUserSettings?.AllowPvP ?? false),
          XPMultiplier: String(preset?.gameUserSettings?.XPMultiplier ?? 1.0),
          TamingSpeedMultiplier: String(preset?.gameUserSettings?.TamingSpeedMultiplier ?? 1.0),
          HarvestAmountMultiplier: String(preset?.gameUserSettings?.HarvestAmountMultiplier ?? 1.0),
        },
      };

      await tauriCmd.writeServerConfig(installPath, {
        gameUserSettings: gusJson,
        gameIni: {},
        launchArgs: {},
      });

      // Update server_config with the written values
      await saveServerConfig(serverId, JSON.stringify(gusJson), "{}", "{}");

      setStatus("done");
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--text-primary)" }}>
          Configuration Summary
        </h3>
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {summaryItems.map(({ label, value }) => (
            <div
              key={label}
              className="flex items-center justify-between px-3 py-1.5 rounded"
              style={{ background: "rgba(10,10,30,0.5)", border: "1px solid rgba(191,0,255,0.1)" }}
            >
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</span>
              <span className="text-xs font-mono" style={{ color: "var(--text-primary)" }}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      {status === "idle" && (
        <Button
          onClick={startInstall}
          className="w-full gap-2"
          size="lg"
          style={{
            background: "rgba(191,0,255,0.15)",
            border: "1px solid rgba(191,0,255,0.5)",
            color: "var(--neon-purple)",
            boxShadow: "0 0 20px rgba(191,0,255,0.15)",
          }}
        >
          <Download className="w-4 h-4" />
          Install Server
        </Button>
      )}

      {(status === "installing" || status === "done" || status === "error") && (
        <CommandOutputPanel
          eventChannel={`steamcmd://output/${serverId}`}
          label="SteamCMD — Installing ASA Server"
        />
      )}

      {status === "installing" && (
        <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-purple)" }}>
          <Loader2 className="w-3 h-3 animate-spin" />
          Installation in progress. This may take 15–30 minutes…
        </p>
      )}

      {status === "done" && (
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-2" style={{ color: "var(--neon-green)" }}>
            <CheckCircle2 className="w-5 h-5" />
            <span className="text-sm font-semibold">Server installed successfully!</span>
          </div>
          <Button
            onClick={onInstallComplete}
            className="gap-2"
            style={{
              background: "rgba(0,255,136,0.1)",
              border: "1px solid rgba(0,255,136,0.4)",
              color: "var(--neon-green)",
            }}
          >
            Go to Dashboard <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      )}

      {status === "error" && (
        <div className="space-y-2">
          <p className="text-xs flex items-start gap-1.5" style={{ color: "var(--neon-red)" }}>
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            {error}
          </p>
          <Button
            onClick={startInstall}
            variant="outline"
            size="sm"
            className="gap-1"
            style={{ borderColor: "rgba(255,0,85,0.4)", color: "var(--neon-red)" }}
          >
            Retry Install
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main ServerCreationWizard
// ---------------------------------------------------------------------------

export function ServerCreationWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [data, setData] = useState<WizardData>(DEFAULT_DATA);
  const [serverId] = useState(() => generateUUID());

  const onChange = useCallback((patch: Partial<WizardData>) => {
    setData((prev) => ({ ...prev, ...patch }));
  }, []);

  const canAdvance = (): boolean => {
    switch (step) {
      case 0: return !!data.name.trim() && !!data.adminPassword.trim();
      case 1: return !!data.presetId;
      case 2: return !!data.rconPassword.trim();
      case 3: return true;
      case 4: return true;
      case 5: return true;
      default: return false;
    }
  };

  const next = () => { setDirection(1); setStep((s) => Math.min(s + 1, STEPS.length - 1)); };
  const prev = () => { setDirection(-1); setStep((s) => Math.max(s - 1, 0)); };

  const handleInstallComplete = () => {
    router.push("/");
  };

  const stepComponents: React.ReactNode[] = [
    <BasicInfoStep  key="basic"      data={data} onChange={onChange} />,
    <PresetStep     key="preset"     data={data} onChange={onChange} />,
    <NetworkStep    key="network"    data={data} onChange={onChange} />,
    <ClusterStep    key="cluster"    data={data} onChange={onChange} />,
    <AutomationStep key="automation" data={data} onChange={onChange} />,
    <ModsStep       key="mods"       data={data} onChange={onChange} />,
    <InstallStep    key="install"    data={data} serverId={serverId} onInstallComplete={handleInstallComplete} />,
  ];

  return (
    <div className="flex h-full gap-6">
      {/* Left sidebar — step list */}
      <div
        className="w-52 shrink-0 rounded-xl p-4 flex flex-col gap-1 self-start sticky top-0"
        style={{
          background: "rgba(10,10,30,0.7)",
          border: "1px solid rgba(191,0,255,0.15)",
          backdropFilter: "blur(12px)",
        }}
      >
        <p className="text-xs font-semibold mb-3 px-1" style={{ color: "var(--text-muted)" }}>
          NEW SERVER
        </p>
        {STEPS.map((s, i) => {
          const done = i < step;
          const active = i === step;
          return (
            <div
              key={s.label}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg transition-all",
                active && "bg-[rgba(191,0,255,0.1)]",
                done && "opacity-70"
              )}
              style={{
                border: active ? "1px solid rgba(191,0,255,0.4)" : "1px solid transparent",
              }}
            >
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                style={{
                  background: done
                    ? "rgba(0,255,136,0.15)"
                    : active
                    ? "rgba(191,0,255,0.2)"
                    : "rgba(191,0,255,0.05)",
                  border: `1px solid ${done ? "rgba(0,255,136,0.4)" : active ? "rgba(191,0,255,0.5)" : "rgba(191,0,255,0.15)"}`,
                  color: done ? "var(--neon-green)" : active ? "var(--neon-purple)" : "var(--text-subtle)",
                }}
              >
                {done ? "✓" : i + 1}
              </div>
              <span
                className="text-xs truncate"
                style={{ color: active ? "var(--neon-purple)" : done ? "var(--text-primary)" : "var(--text-muted)" }}
              >
                {s.label}
              </span>
              {active && <ChevronRight className="w-3 h-3 ml-auto shrink-0" style={{ color: "var(--neon-purple)" }} />}
            </div>
          );
        })}
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
            {STEPS[step].label}
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
            Step {step + 1} of {STEPS.length}
          </p>
        </div>

        {/* Step content */}
        <div
          className="flex-1 rounded-xl p-6 overflow-y-auto"
          style={{
            background: "rgba(10,10,30,0.6)",
            border: "1px solid rgba(191,0,255,0.15)",
            backdropFilter: "blur(12px)",
          }}
        >
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              variants={stepVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.2, ease: "easeInOut" }}
            >
              {stepComponents[step]}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Navigation — hidden on install step */}
        {step < STEPS.length - 1 && (
          <div className="flex items-center justify-between mt-4">
            <Button
              variant="ghost"
              onClick={prev}
              disabled={step === 0}
              className="gap-2"
              style={{ color: "var(--text-muted)" }}
            >
              <ArrowLeft className="w-4 h-4" /> Back
            </Button>

            <Button
              onClick={next}
              disabled={!canAdvance()}
              className="gap-2"
              style={{
                background: canAdvance() ? "rgba(191,0,255,0.15)" : "rgba(191,0,255,0.05)",
                border: "1px solid rgba(191,0,255,0.4)",
                color: canAdvance() ? "var(--neon-purple)" : "var(--text-muted)",
              }}
            >
              {step === STEPS.length - 2 ? "Review & Install" : "Next"}
              <ArrowRight className="w-4 h-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
