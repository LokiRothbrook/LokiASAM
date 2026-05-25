"use client";

import { useState, useEffect, useCallback } from "react";
import { Save, Code, LayoutList, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { tauriCmd, type ServerConfigJson } from "@/lib/tauri-commands";
import type { ServerRow } from "@/lib/db";

interface Props {
  server: ServerRow;
}

// ---------------------------------------------------------------------------
// Field definitions — the structured view of the most important ASA INI keys.
// Section keys must exactly match what the INI parser produces.
// ---------------------------------------------------------------------------

interface FieldDef {
  section: string;
  key: string;
  label: string;
  type: "string" | "number" | "boolean";
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  file: "gus" | "game";
}

const FIELD_GROUPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: "Session",
    fields: [
      { file: "gus", section: "SessionSettings", key: "SessionName", label: "Server Name", type: "string", placeholder: "My ASA Server" },
      { file: "gus", section: "ServerSettings", key: "MaxPlayers", label: "Max Players", type: "number", min: 1, max: 70 },
      { file: "gus", section: "SessionSettings", key: "ServerPassword", label: "Join Password", type: "string", placeholder: "(no password)" },
    ],
  },
  {
    title: "Admin & RCON",
    fields: [
      { file: "gus", section: "ServerSettings", key: "ServerAdminPassword", label: "Admin Password", type: "string", placeholder: "required" },
      { file: "gus", section: "SessionSettings", key: "RCONEnabled", label: "RCON Enabled", type: "boolean" },
      { file: "gus", section: "SessionSettings", key: "RCONPort", label: "RCON Port", type: "number", min: 1024, max: 65535 },
    ],
  },
  {
    title: "Rates",
    fields: [
      { file: "gus", section: "ServerSettings", key: "XPMultiplier", label: "XP Multiplier", type: "number", min: 0.1, max: 100, step: 0.1 },
      { file: "gus", section: "ServerSettings", key: "TamingSpeedMultiplier", label: "Taming Speed", type: "number", min: 0.1, max: 100, step: 0.1 },
      { file: "gus", section: "ServerSettings", key: "HarvestAmountMultiplier", label: "Harvest Amount", type: "number", min: 0.1, max: 100, step: 0.1 },
      { file: "gus", section: "ServerSettings", key: "ResourcesRespawnPeriodMultiplier", label: "Resource Respawn Multiplier", type: "number", min: 0.1, max: 100, step: 0.1 },
      { file: "gus", section: "ServerSettings", key: "PlayerCharacterWaterDrainMultiplier", label: "Water Drain", type: "number", min: 0.0, max: 10, step: 0.1 },
      { file: "gus", section: "ServerSettings", key: "PlayerCharacterFoodDrainMultiplier", label: "Food Drain", type: "number", min: 0.0, max: 10, step: 0.1 },
    ],
  },
  {
    title: "Taming & Breeding",
    fields: [
      { file: "gus", section: "ServerSettings", key: "BabyMatureSpeedMultiplier", label: "Baby Mature Speed", type: "number", min: 0.1, max: 100, step: 0.1 },
      { file: "gus", section: "ServerSettings", key: "EggHatchSpeedMultiplier", label: "Egg Hatch Speed", type: "number", min: 0.1, max: 100, step: 0.1 },
      { file: "gus", section: "ServerSettings", key: "BabyCuddleIntervalMultiplier", label: "Imprint Interval", type: "number", min: 0.1, max: 100, step: 0.1 },
    ],
  },
  {
    title: "PvP / PvE",
    fields: [
      { file: "gus", section: "ServerSettings", key: "DifficultyOffset", label: "Difficulty Offset", type: "number", min: 0, max: 1, step: 0.05 },
      { file: "gus", section: "ServerSettings", key: "AllowThirdPersonPlayer", label: "Allow Third Person", type: "boolean" },
      { file: "gus", section: "ServerSettings", key: "AlwaysNotifyPlayerLeft", label: "Notify Player Left", type: "boolean" },
      { file: "gus", section: "ServerSettings", key: "AlwaysNotifyPlayerJoined", label: "Notify Player Joined", type: "boolean" },
      { file: "gus", section: "ServerSettings", key: "GlobalVoiceChat", label: "Global Voice Chat", type: "boolean" },
      { file: "gus", section: "ServerSettings", key: "ProximityChat", label: "Proximity Chat", type: "boolean" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getIniValue(config: ServerConfigJson, file: "gus" | "game", section: string, key: string): string {
  const src = file === "gus" ? config.gameUserSettings : config.gameIni;
  return src?.[section]?.[key] ?? "";
}

function setIniValue(
  config: ServerConfigJson,
  file: "gus" | "game",
  section: string,
  key: string,
  value: string,
): ServerConfigJson {
  const src = file === "gus" ? { ...config.gameUserSettings } : { ...config.gameIni };
  src[section] = { ...(src[section] ?? {}), [key]: value };
  if (file === "gus") return { ...config, gameUserSettings: src };
  return { ...config, gameIni: src };
}

function configToRawText(obj: Record<string, Record<string, string>>): string {
  return Object.entries(obj)
    .map(([section, kvs]) => {
      const lines = Object.entries(kvs).map(([k, v]) => `${k}=${v}`);
      return `[${section}]\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

function rawTextToSections(text: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      current = line.slice(1, -1);
      result[current] = result[current] ?? {};
    } else if (current && line.includes("=")) {
      const eq = line.indexOf("=");
      result[current][line.slice(0, eq).trim()] = line.slice(eq + 1);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// FieldRow
// ---------------------------------------------------------------------------

function FieldRow({ field, value, onChange }: {
  field: FieldDef;
  value: string;
  onChange: (val: string) => void;
}) {
  if (field.type === "boolean") {
    const checked = value === "True" || value === "true" || value === "1";
    return (
      <div className="flex items-center justify-between py-2">
        <Label
          className="text-sm cursor-pointer"
          style={{ color: "var(--text-primary)" }}
          title={`[${field.section}] ${field.key}`}
        >
          {field.label}
          <span className="ml-2 text-xs font-mono" style={{ color: "var(--text-muted)" }}>
            {field.key}
          </span>
        </Label>
        <Switch
          checked={checked}
          onCheckedChange={(v) => onChange(v ? "True" : "False")}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-2 gap-4">
      <Label
        className="text-sm shrink-0 w-48"
        style={{ color: "var(--text-primary)" }}
        title={`[${field.section}] ${field.key}`}
      >
        {field.label}
        <span className="ml-2 text-xs font-mono" style={{ color: "var(--text-muted)" }}>
          {field.key}
        </span>
      </Label>
      <Input
        type={field.type === "number" ? "number" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        min={field.min}
        max={field.max}
        step={field.step}
        className="h-8 text-sm max-w-xs"
        style={{
          background: "rgba(0,0,0,0.3)",
          borderColor: "rgba(191,0,255,0.2)",
          color: "var(--text-primary)",
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section accordion
// ---------------------------------------------------------------------------

function SectionGroup({ title, fields, config, onChange }: {
  title: string;
  fields: FieldDef[];
  config: ServerConfigJson;
  onChange: (f: FieldDef, val: string) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div
      className="glass-card rounded-xl overflow-hidden"
      style={{ borderColor: "rgba(191,0,255,0.15)" }}
    >
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-sm font-semibold" style={{ color: "var(--neon-purple)" }}>
          {title}
        </span>
        {open
          ? <ChevronDown className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
          : <ChevronRight className="w-4 h-4" style={{ color: "var(--text-muted)" }} />}
      </button>
      {open && (
        <div className="px-4 pb-3 divide-y" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
          {fields.map((f) => (
            <FieldRow
              key={`${f.section}.${f.key}`}
              field={f}
              value={getIniValue(config, f.file, f.section, f.key)}
              onChange={(val) => onChange(f, val)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main ConfigTab
// ---------------------------------------------------------------------------

export function ConfigTab({ server }: Props) {
  const [config, setConfig] = useState<ServerConfigJson | null>(null);
  const [rawGus, setRawGus] = useState("");
  const [rawGame, setRawGame] = useState("");
  const [rawMode, setRawMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cfg = await tauriCmd.readServerConfig(server.install_path);
      setConfig(cfg);
      setRawGus(configToRawText(cfg.gameUserSettings as Record<string, Record<string, string>>));
      setRawGame(configToRawText(cfg.gameIni as Record<string, Record<string, string>>));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [server.install_path]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const handleFieldChange = (field: FieldDef, value: string) => {
    if (!config) return;
    setConfig(setIniValue(config, field.file, field.section, field.key, value));
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      let toSave = config;
      if (rawMode) {
        toSave = {
          ...config,
          gameUserSettings: rawTextToSections(rawGus),
          gameIni: rawTextToSections(rawGame),
        };
        setConfig(toSave);
      }
      await tauriCmd.writeServerConfig(server.install_path, toSave);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const switchToRaw = () => {
    if (config) {
      setRawGus(configToRawText(config.gameUserSettings as Record<string, Record<string, string>>));
      setRawGame(configToRawText(config.gameIni as Record<string, Record<string, string>>));
    }
    setRawMode(true);
  };

  const switchToStructured = () => {
    const gus = rawTextToSections(rawGus);
    const game = rawTextToSections(rawGame);
    if (config) setConfig({ ...config, gameUserSettings: gus, gameIni: game });
    setRawMode(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-6 h-6 animate-spin" style={{ color: "var(--neon-purple)" }} />
        <span className="ml-3 text-sm" style={{ color: "var(--text-muted)" }}>
          Reading INI files…
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── Toolbar ── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={rawMode ? "ghost" : "outline"}
            className={rawMode ? "" : "btn-neon-purple"}
            onClick={switchToStructured}
          >
            <LayoutList className="w-3.5 h-3.5 mr-1.5" />
            Structured
          </Button>
          <Button
            size="sm"
            variant={rawMode ? "outline" : "ghost"}
            className={rawMode ? "btn-neon-cyan" : ""}
            onClick={switchToRaw}
          >
            <Code className="w-3.5 h-3.5 mr-1.5" />
            Raw INI
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={loadConfig} disabled={loading}>
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Reload
          </Button>
          <Button
            size="sm"
            className={savedFlash ? "btn-neon-green" : "btn-neon-purple"}
            onClick={handleSave}
            disabled={saving || !config}
          >
            <Save className="w-3.5 h-3.5 mr-1.5" />
            {saving ? "Saving…" : savedFlash ? "Saved!" : "Save"}
          </Button>
        </div>
      </div>

      {error && (
        <div
          className="text-sm px-4 py-3 rounded-lg"
          style={{ background: "rgba(255,0,85,0.08)", border: "1px solid rgba(255,0,85,0.3)", color: "#ff6688" }}
        >
          {error}
        </div>
      )}

      {/* ── Structured editor ── */}
      {!rawMode && config && (
        <div className="flex flex-col gap-4">
          {FIELD_GROUPS.map((g) => (
            <SectionGroup
              key={g.title}
              title={g.title}
              fields={g.fields}
              config={config}
              onChange={handleFieldChange}
            />
          ))}
        </div>
      )}

      {/* ── Raw INI editor ── */}
      {rawMode && (
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs font-semibold mb-2" style={{ color: "var(--neon-cyan)" }}>
              GameUserSettings.ini
            </p>
            <textarea
              className="w-full font-mono text-xs rounded-lg p-3 resize-y"
              rows={20}
              style={{
                background: "#000008",
                border: "1px solid rgba(0,255,255,0.2)",
                color: "#e0e0ff",
                outline: "none",
              }}
              value={rawGus}
              onChange={(e) => setRawGus(e.target.value)}
              spellCheck={false}
            />
          </div>
          <div>
            <p className="text-xs font-semibold mb-2" style={{ color: "var(--neon-cyan)" }}>
              Game.ini
            </p>
            <textarea
              className="w-full font-mono text-xs rounded-lg p-3 resize-y"
              rows={10}
              style={{
                background: "#000008",
                border: "1px solid rgba(0,255,255,0.2)",
                color: "#e0e0ff",
                outline: "none",
              }}
              value={rawGame}
              onChange={(e) => setRawGame(e.target.value)}
              spellCheck={false}
            />
          </div>
        </div>
      )}
    </div>
  );
}
