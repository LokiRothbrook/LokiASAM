"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Save, Code, LayoutList, RefreshCw, ChevronDown, ChevronRight,
  Settings2, X, AlertCircle, ToggleLeft, ToggleRight, Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { tauriCmd, type ServerConfigJson } from "@/lib/tauri-commands";
import { INI_FIELD_GROUPS, LAUNCH_PARAMETERS, type IniFieldDef, type LaunchParameter } from "@/data/game-data";
import { getServerConfig, saveServerConfig, type ServerRow } from "@/lib/db";
import { NumberField } from "@/components/shared/NumberField";

interface Props {
  server: ServerRow;
}

// Keys excluded from the "Full INI Editor" — handled on the server overview/setup pages.
const OVERVIEW_KEYS = new Set([
  "SessionName", "ServerPassword", "ServerAdminPassword",
  "Port", "QueryPort", "RCONPort", "RCONEnabled", "MaxPlayers",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getIniValue(
  config: ServerConfigJson,
  section: "gus" | "game",
  iniSection: string,
  key: string
): string {
  const src = section === "gus" ? config.gameUserSettings : config.gameIni;
  return src?.[iniSection]?.[key] ?? "";
}

function setIniValue(
  config: ServerConfigJson,
  section: "gus" | "game",
  iniSection: string,
  key: string,
  value: string,
): ServerConfigJson {
  const src = section === "gus" ? { ...config.gameUserSettings } : { ...config.gameIni };
  src[iniSection] = { ...(src[iniSection] ?? {}), [key]: value };
  if (section === "gus") return { ...config, gameUserSettings: src };
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
// Field row
// ---------------------------------------------------------------------------

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: IniFieldDef;
  value: string;
  onChange: (val: string) => void;
}) {
  if (field.type === "boolean") {
    const checked = value === "True" || value === "true" || value === "1";
    return (
      <div className="flex items-center justify-between py-2">
        <div>
          <Label className="text-sm cursor-pointer" style={{ color: "var(--text-primary)" }} title={`[${field.iniSection}] ${field.key}`}>
            {field.label}
            <span className="ml-2 text-xs font-mono" style={{ color: "var(--text-muted)" }}>{field.key}</span>
          </Label>
          {field.description && (
            <p className="text-xs mt-0.5" style={{ color: "var(--text-subtle)" }}>{field.description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => onChange(checked ? "False" : "True")}
          className="shrink-0 flex items-center"
          aria-label={checked ? "Disable" : "Enable"}
        >
          {checked
            ? <ToggleRight className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
            : <ToggleLeft className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />}
        </button>
      </div>
    );
  }

  if (field.type === "number" && field.min !== undefined && field.max !== undefined) {
    const numVal = parseFloat(value) || 0;
    return (
      <div className="py-2 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-sm" style={{ color: "var(--text-primary)" }} title={`[${field.iniSection}] ${field.key}`}>
            {field.label}
            <span className="ml-2 text-xs font-mono" style={{ color: "var(--text-muted)" }}>{field.key}</span>
          </Label>
        </div>
        {field.description && (
          <p className="text-xs" style={{ color: "var(--text-subtle)" }}>{field.description}</p>
        )}
        <NumberField
          value={numVal}
          onChange={(v) => onChange(String(v))}
          min={field.min}
          max={field.max}
          step={field.step}
          defaultValue={field.defaultValue}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-2 gap-4">
      <div className="shrink-0 w-52">
        <Label className="text-sm" style={{ color: "var(--text-primary)" }} title={`[${field.iniSection}] ${field.key}`}>
          {field.label}
          <span className="ml-2 text-xs font-mono" style={{ color: "var(--text-muted)" }}>{field.key}</span>
        </Label>
        {field.description && (
          <p className="text-xs mt-0.5" style={{ color: "var(--text-subtle)" }}>{field.description}</p>
        )}
      </div>
      <Input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className="h-8 text-sm max-w-xs"
        style={{ background: "rgba(0,0,0,0.3)", borderColor: "rgba(191,0,255,0.2)", color: "var(--text-primary)" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Launch parameter row
// ---------------------------------------------------------------------------

function LaunchParamRow({
  param,
  value,
  onChange,
}: {
  param: LaunchParameter;
  value: string;
  onChange: (val: string) => void;
}) {
  if (param.type === "boolean") {
    const on = value === "true" || value === "1";
    return (
      <div className="flex items-start justify-between py-2 gap-3">
        <div className="flex-1 min-w-0">
          <span className="text-xs font-mono font-medium" style={{ color: "var(--text-primary)" }}>{param.flag}</span>
          {param.description && (
            <p className="text-xs mt-0.5" style={{ color: "var(--text-subtle)" }}>{param.description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => onChange(on ? "false" : "true")}
          className="shrink-0 flex items-center mt-0.5"
          aria-label={on ? "Disable" : "Enable"}
        >
          {on
            ? <ToggleRight className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
            : <ToggleLeft className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />}
        </button>
      </div>
    );
  }

  return (
    <div className="py-2 space-y-1">
      <span className="text-xs font-mono font-medium" style={{ color: "var(--text-primary)" }}>{param.flag}</span>
      {param.description && (
        <p className="text-xs" style={{ color: "var(--text-subtle)" }}>{param.description}</p>
      )}
      <Input
        type="text"
        value={value}
        placeholder={String(param.defaultValue) || "(empty = disabled)"}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-xs font-mono"
        style={{ background: "rgba(0,0,0,0.3)", borderColor: "rgba(191,0,255,0.2)", color: "var(--text-primary)" }}
      />
    </div>
  );
}

function LaunchParamGroup({
  config,
  onChange,
}: {
  config: ServerConfigJson;
  onChange: (key: string, val: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const args = (config.launchArgs ?? {}) as Record<string, string>;

  return (
    <div className="glass-card rounded-xl overflow-hidden" style={{ borderColor: "rgba(191,0,255,0.15)" }}>
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--neon-purple)" }}>
          <Terminal className="w-3.5 h-3.5" />
          Launch Parameters
        </span>
        {open
          ? <ChevronDown className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
          : <ChevronRight className="w-4 h-4" style={{ color: "var(--text-muted)" }} />}
      </button>
      {open && (
        <div className="px-4 pb-3 divide-y" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
          {LAUNCH_PARAMETERS.filter((p) => p.category !== "cluster").map((p) => (
            <LaunchParamRow
              key={p.key}
              param={p}
              value={args[p.key] ?? String(p.defaultValue)}
              onChange={(val) => onChange(p.key, val)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accordion group
// ---------------------------------------------------------------------------

function SectionGroup({
  title,
  fields,
  config,
  onChange,
  defaultOpen = true,
}: {
  title: string;
  fields: IniFieldDef[];
  config: ServerConfigJson;
  onChange: (f: IniFieldDef, val: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="glass-card rounded-xl overflow-hidden" style={{ borderColor: "rgba(191,0,255,0.15)" }}>
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-sm font-semibold" style={{ color: "var(--neon-purple)" }}>{title}</span>
        {open
          ? <ChevronDown className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
          : <ChevronRight className="w-4 h-4" style={{ color: "var(--text-muted)" }} />}
      </button>
      {open && (
        <div className="px-4 pb-3 divide-y" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
          {fields.map((f) => (
            <FieldRow
              key={`${f.iniSection}.${f.key}`}
              field={f}
              value={getIniValue(config, f.section, f.iniSection, f.key)}
              onChange={(val) => onChange(f, val)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full INI Editor Modal
// ---------------------------------------------------------------------------

function FullIniModal({
  config,
  onSave,
  onClose,
}: {
  config: ServerConfigJson;
  onSave: (updated: ServerConfigJson) => void;
  onClose: () => void;
}) {
  const [local, setLocal] = useState<ServerConfigJson>(config);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["rates", "breeding"]));

  const toggleGroup = (id: string) =>
    setExpandedGroups((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const handleChange = (f: IniFieldDef, val: string) => {
    setLocal((prev) => setIniValue(prev, f.section, f.iniSection, f.key, val));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }}
    >
      <div
        className="w-full max-w-3xl mx-4 flex flex-col rounded-2xl overflow-hidden"
        style={{
          background: "rgba(8,8,25,0.98)",
          border: "1px solid rgba(191,0,255,0.25)",
          boxShadow: "0 16px 64px rgba(0,0,0,0.8)",
          maxHeight: "90vh",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0" style={{ borderColor: "rgba(191,0,255,0.15)" }}>
          <div className="flex items-center gap-2">
            <Settings2 className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
            <span className="text-sm font-semibold" style={{ color: "var(--neon-purple)" }}>Full INI Editor</span>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0" style={{ color: "var(--text-muted)" }}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="px-3 py-2 shrink-0" style={{ background: "rgba(191,0,255,0.04)", borderBottom: "1px solid rgba(191,0,255,0.1)" }}>
          <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
            <AlertCircle className="w-3 h-3" style={{ color: "var(--neon-purple)" }} />
            Server name, passwords, and ports are managed on the overview page and are excluded here.
            Changes take effect on the next server restart.
          </p>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {INI_FIELD_GROUPS.map((group) => {
            const visibleFields = group.fields.filter(
              (f) => f.section === "gus" && !OVERVIEW_KEYS.has(f.key)
            );
            if (visibleFields.length === 0) return null;
            const open = expandedGroups.has(group.id);
            return (
              <div key={group.id} className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(191,0,255,0.15)" }}>
                <button
                  onClick={() => toggleGroup(group.id)}
                  className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition-colors"
                  style={{ background: "rgba(10,10,30,0.7)" }}
                >
                  <span className="text-sm font-semibold" style={{ color: "var(--neon-purple)" }}>{group.title}</span>
                  {open
                    ? <ChevronDown className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
                    : <ChevronRight className="w-4 h-4" style={{ color: "var(--text-muted)" }} />}
                </button>
                {open && (
                  <div className="px-4 pb-3 divide-y" style={{ borderColor: "rgba(255,255,255,0.05)", background: "rgba(5,5,20,0.5)" }}>
                    {visibleFields.map((f) => (
                      <FieldRow
                        key={`${f.iniSection}.${f.key}`}
                        field={f}
                        value={getIniValue(local, f.section, f.iniSection, f.key)}
                        onChange={(val) => handleChange(f, val)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t shrink-0" style={{ borderColor: "rgba(191,0,255,0.15)" }}>
          <Button variant="ghost" onClick={onClose} size="sm" style={{ color: "var(--text-muted)" }}>Cancel</Button>
          <Button
            onClick={() => { onSave(local); onClose(); }}
            size="sm"
            style={{ background: "rgba(191,0,255,0.15)", border: "1px solid rgba(191,0,255,0.4)", color: "var(--neon-purple)" }}
          >
            <Save className="w-3.5 h-3.5 mr-1.5" /> Apply Changes
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick-edit groups shown in the structured tab (subset of all groups)
// ---------------------------------------------------------------------------

const QUICK_EDIT_GROUP_IDS = ["session", "admin", "rates", "breeding"];

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
  const [readingIni, setReadingIni] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFullModal, setShowFullModal] = useState(false);

  // Load from DB on mount — reflects what we last saved, not what the server may have overwritten
  const loadFromDb = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const row = await getServerConfig(server.id);
      if (row) {
        const gus = JSON.parse(row.game_user_settings_json || "{}");
        const game = JSON.parse(row.game_ini_json || "{}");
        const launchArgs = JSON.parse(row.launch_args_json || "{}");
        const cfg: ServerConfigJson = { gameUserSettings: gus, gameIni: game, launchArgs };
        setConfig(cfg);
        setRawGus(configToRawText(gus));
        setRawGame(configToRawText(game));
      } else {
        // No saved config yet — show empty
        const empty: ServerConfigJson = { gameUserSettings: {}, gameIni: {}, launchArgs: {} };
        setConfig(empty);
        setRawGus("");
        setRawGame("");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [server.id]);

  useEffect(() => { loadFromDb(); }, [loadFromDb]);

  // Explicitly read from the INI files on disk — overwrites UI state with what the server has on disk
  const readFromIni = useCallback(async () => {
    setReadingIni(true);
    setError(null);
    try {
      const cfg = await tauriCmd.readServerConfig(server.install_path);
      setConfig(cfg);
      setRawGus(configToRawText(cfg.gameUserSettings as Record<string, Record<string, string>>));
      setRawGame(configToRawText(cfg.gameIni as Record<string, Record<string, string>>));
    } catch (e) {
      setError(String(e));
    } finally {
      setReadingIni(false);
    }
  }, [server.install_path]);

  const handleFieldChange = (field: IniFieldDef, value: string) => {
    if (!config) return;
    setConfig(setIniValue(config, field.section, field.iniSection, field.key, value));
  };

  const handleLaunchArgChange = (key: string, val: string) => {
    if (!config) return;
    setConfig({ ...config, launchArgs: { ...(config.launchArgs as Record<string, string> ?? {}), [key]: val } });
  };

  // Save to disk AND update DB so our settings survive server restarts
  const handleSave = async (cfg?: ServerConfigJson) => {
    const toWrite = cfg ?? config;
    if (!toWrite) return;
    setSaving(true);
    setError(null);
    try {
      let toSave = toWrite;
      if (rawMode && !cfg) {
        toSave = {
          ...toWrite,
          gameUserSettings: rawTextToSections(rawGus),
          gameIni: rawTextToSections(rawGame),
        };
        setConfig(toSave);
      } else if (cfg) {
        setConfig(cfg);
      }
      // Write to disk
      await tauriCmd.writeServerConfig(server.install_path, toSave);
      // Persist to DB so Config tab loads our version next time, not the server's overwrite
      await saveServerConfig(
        server.id,
        JSON.stringify(toSave.gameUserSettings),
        JSON.stringify(toSave.gameIni),
        JSON.stringify(toSave.launchArgs ?? {}),
      );
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
        <span className="ml-3 text-sm" style={{ color: "var(--text-muted)" }}>Loading saved config…</span>
      </div>
    );
  }

  // Quick-edit: only show a curated subset of groups
  const quickGroups = INI_FIELD_GROUPS.filter((g) => QUICK_EDIT_GROUP_IDS.includes(g.id));

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Button size="sm" variant={rawMode ? "ghost" : "outline"} className={rawMode ? "" : "btn-neon-purple"} onClick={switchToStructured}>
            <LayoutList className="w-3.5 h-3.5 mr-1.5" /> Structured
          </Button>
          <Button size="sm" variant={rawMode ? "outline" : "ghost"} className={rawMode ? "btn-neon-cyan" : ""} onClick={switchToRaw}>
            <Code className="w-3.5 h-3.5 mr-1.5" /> Raw INI
          </Button>
          {!rawMode && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowFullModal(true)}
              disabled={!config}
              style={{ color: "var(--neon-purple)", borderColor: "rgba(191,0,255,0.3)" }}
            >
              <Settings2 className="w-3.5 h-3.5 mr-1.5" /> Full INI Editor
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={readFromIni}
            disabled={readingIni}
            title="Overwrite UI with the current GameUserSettings.ini on disk"
            style={{ color: "var(--text-muted)" }}
          >
            {readingIni
              ? <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
            Read from INI
          </Button>
          <Button
            size="sm"
            className={savedFlash ? "btn-neon-green" : "btn-neon-purple"}
            onClick={() => handleSave()}
            disabled={saving || !config}
          >
            <Save className="w-3.5 h-3.5 mr-1.5" />
            {saving ? "Saving…" : savedFlash ? "Saved!" : "Save"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="text-sm px-4 py-3 rounded-lg" style={{ background: "rgba(255,0,85,0.08)", border: "1px solid rgba(255,0,85,0.3)", color: "#ff6688" }}>
          {error}
        </div>
      )}

      {/* Structured editor — quick groups */}
      {!rawMode && config && (
        <div className="flex flex-col gap-4">
          {quickGroups.map((g, idx) => (
            <SectionGroup
              key={g.id}
              title={g.title}
              fields={g.fields}
              config={config}
              onChange={handleFieldChange}
              defaultOpen={idx < 3}
            />
          ))}
          <LaunchParamGroup config={config} onChange={handleLaunchArgChange} />
          <p className="text-xs text-center" style={{ color: "var(--text-subtle)" }}>
            Click <strong style={{ color: "var(--neon-purple)" }}>Full INI Editor</strong> in the toolbar to access all server settings.
          </p>
        </div>
      )}

      {/* Raw INI editor */}
      {rawMode && (
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs font-semibold mb-2" style={{ color: "var(--neon-cyan)" }}>GameUserSettings.ini</p>
            <textarea
              className="w-full font-mono text-xs rounded-lg p-3 resize-y"
              rows={20}
              style={{ background: "#000008", border: "1px solid rgba(0,255,255,0.2)", color: "#e0e0ff", outline: "none" }}
              value={rawGus}
              onChange={(e) => setRawGus(e.target.value)}
              spellCheck={false}
            />
          </div>
          <div>
            <p className="text-xs font-semibold mb-2" style={{ color: "var(--neon-cyan)" }}>Game.ini</p>
            <textarea
              className="w-full font-mono text-xs rounded-lg p-3 resize-y"
              rows={10}
              style={{ background: "#000008", border: "1px solid rgba(0,255,255,0.2)", color: "#e0e0ff", outline: "none" }}
              value={rawGame}
              onChange={(e) => setRawGame(e.target.value)}
              spellCheck={false}
            />
          </div>
        </div>
      )}

      {/* Full INI Editor modal */}
      {showFullModal && config && (
        <FullIniModal
          config={config}
          onSave={(updated) => handleSave(updated)}
          onClose={() => setShowFullModal(false)}
        />
      )}
    </div>
  );
}
