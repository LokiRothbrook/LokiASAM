"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Save, Code, LayoutList, RefreshCw, ChevronDown, ChevronRight,
  Settings2, X, AlertCircle, ToggleLeft, ToggleRight, Terminal,
  HelpCircle, Upload, Search, FileText, Clipboard, Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { tauriCmd, type ServerConfigJson } from "@/lib/tauri-commands";
import {
  INI_FIELD_GROUPS, LAUNCH_PARAMETERS, GAME_MODES, PRESET_STYLES,
  buildPresetConfig,
  type IniFieldDef, type LaunchParameter,
} from "@/data/game-data";
import { getServerConfig, saveServerConfig, updateServerShutdownSettings, updateServerRestartSettings, updateServerUpdateSettings, getAppSetting, type ServerRow } from "@/lib/db";
import { toast } from "sonner";
import { NumberField } from "@/components/shared/NumberField";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";

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

function FieldLabel({ field }: { field: IniFieldDef }) {
  return (
    <span className="flex items-center gap-1 min-w-0">
      <span className="text-sm" style={{ color: "var(--text-primary)" }}>{field.label}</span>
      <span className="text-xs font-mono shrink-0" style={{ color: "var(--text-muted)" }}>{field.key}</span>
      {field.description && (
        <Tooltip>
          <TooltipTrigger asChild>
            <HelpCircle className="w-3 h-3 shrink-0 cursor-help" style={{ color: "var(--text-subtle)" }} />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-xs leading-snug">
            {field.description}
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

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
      <div className="flex items-center justify-between py-2 gap-2">
        <FieldLabel field={field} />
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
        <FieldLabel field={field} />
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
        <FieldLabel field={field} />
      </div>
      <Input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className="h-8 text-sm max-w-xs"
        style={{ background: "rgba(0,0,0,0.3)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
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
        style={{ background: "rgba(0,0,0,0.3)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
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
    <div className="glass-card rounded-xl overflow-hidden" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)" }}>
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
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
    <div className="glass-card rounded-xl overflow-hidden" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)" }}>
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{title}</span>
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
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const q = search.trim().toLowerCase();

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
          border: "1px solid rgba(var(--neon-purple-rgb),0.25)",
          boxShadow: "0 16px 64px rgba(0,0,0,0.8)",
          maxHeight: "90vh",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)" }}>
          <div className="flex items-center gap-2">
            <Settings2 className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
            <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Full INI Editor</span>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0" style={{ color: "var(--text-muted)" }}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="px-3 py-2 shrink-0 space-y-2" style={{ background: "rgba(var(--neon-purple-rgb),0.04)", borderBottom: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}>
          <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
            <AlertCircle className="w-3 h-3" style={{ color: "var(--neon-purple)" }} />
            Server name, passwords, and ports are managed on the overview page and are excluded here.
            Changes take effect on the next server restart.
          </p>
          {/* Search */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "var(--text-subtle)" }} />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search settings…"
              className="h-8 pl-8 text-xs"
              style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
            />
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {INI_FIELD_GROUPS.map((group) => {
            let visibleFields = group.fields.filter((f) => !OVERVIEW_KEYS.has(f.key));
            if (q) {
              visibleFields = visibleFields.filter(
                (f) =>
                  f.label.toLowerCase().includes(q) ||
                  f.key.toLowerCase().includes(q) ||
                  (f.description?.toLowerCase().includes(q) ?? false),
              );
            }
            if (visibleFields.length === 0) return null;
            const open = q ? true : expandedGroups.has(group.id);
            return (
              <div key={group.id} className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}>
                <button
                  onClick={() => { if (!q) toggleGroup(group.id); }}
                  className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition-colors"
                  style={{ background: "rgba(10,10,30,0.7)" }}
                >
                  <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{group.title}</span>
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
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t shrink-0" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)" }}>
          <Button variant="ghost" onClick={onClose} size="sm" style={{ color: "var(--text-muted)" }}>Cancel</Button>
          <Button
            onClick={() => { onSave(local); onClose(); }}
            size="sm"
            style={{ background: "rgba(var(--neon-purple-rgb),0.15)", border: "1px solid rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)" }}
          >
            <Save className="w-3.5 h-3.5 mr-1.5" /> Apply Changes
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paste INI Modal
// ---------------------------------------------------------------------------

function PasteIniModal({
  onApply,
  onClose,
}: {
  onApply: (gus: Record<string, Record<string, string>>, game: Record<string, Record<string, string>>) => void;
  onClose: () => void;
}) {
  const [gusText, setGusText] = useState("");
  const [gameText, setGameText] = useState("");

  const handleApply = () => {
    onApply(rawTextToSections(gusText), rawTextToSections(gameText));
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }}
    >
      <div
        className="w-full max-w-2xl mx-4 flex flex-col rounded-2xl overflow-hidden"
        style={{
          background: "rgba(8,8,25,0.98)",
          border: "1px solid rgba(var(--neon-purple-rgb),0.25)",
          boxShadow: "0 16px 64px rgba(0,0,0,0.8)",
          maxHeight: "90vh",
        }}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)" }}>
          <div className="flex items-center gap-2">
            <Clipboard className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
            <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Paste INI Text</span>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0" style={{ color: "var(--text-muted)" }}>
            <X className="w-4 h-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <div className="space-y-1">
            <Label className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>GameUserSettings.ini</Label>
            <textarea
              className="w-full font-mono text-xs rounded-lg p-3 resize-y"
              rows={10}
              style={{ background: "#000008", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", color: "#e0e0ff", outline: "none" }}
              placeholder="Paste GameUserSettings.ini content here…"
              value={gusText}
              onChange={(e) => setGusText(e.target.value)}
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Game.ini</Label>
            <textarea
              className="w-full font-mono text-xs rounded-lg p-3 resize-y"
              rows={6}
              style={{ background: "#000008", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", color: "#e0e0ff", outline: "none" }}
              placeholder="Paste Game.ini content here… (optional)"
              value={gameText}
              onChange={(e) => setGameText(e.target.value)}
              spellCheck={false}
            />
          </div>
          <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
            Parsed settings will be merged into the current config. Existing values not present in the pasted text will be kept.
            Click <strong>Apply</strong> to preview changes, then save to write to disk.
          </p>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t shrink-0" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)" }}>
          <Button variant="ghost" onClick={onClose} size="sm" style={{ color: "var(--text-muted)" }}>Cancel</Button>
          <Button
            onClick={handleApply}
            size="sm"
            style={{ background: "rgba(var(--neon-purple-rgb),0.15)", border: "1px solid rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)" }}
          >
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Custom mod sections editor
// ---------------------------------------------------------------------------

type CustomSection = {
  sectionName: string;  // The [SectionName] key in Game.ini
  rows: { key: string; value: string }[];
};

function CustomModSections({
  gameIni,
  onChange,
}: {
  gameIni: Record<string, Record<string, string>>;
  onChange: (updated: Record<string, Record<string, string>>) => void;
}) {
  // Only show sections that are NOT standard ARK sections
  const STANDARD_SECTIONS = new Set([
    "/script/shootergame.shootergamemode",
    "ServerSettings",
    "SessionSettings",
    "MessageOfTheDay",
    "Ragnarok",
  ]);

  const customSections: CustomSection[] = Object.entries(gameIni)
    .filter(([name]) => !STANDARD_SECTIONS.has(name.toLowerCase()) && !STANDARD_SECTIONS.has(name))
    .map(([name, kvs]) => ({
      sectionName: name,
      rows: Object.entries(kvs).map(([key, value]) => ({ key, value })),
    }));

  const [newSectionName, setNewSectionName] = useState("");
  const [deletingSection, setDeletingSection] = useState<string | null>(null);

  const commit = (sections: CustomSection[]) => {
    const updated = { ...gameIni };
    // Remove all existing custom sections
    for (const key of Object.keys(updated)) {
      if (!STANDARD_SECTIONS.has(key.toLowerCase()) && !STANDARD_SECTIONS.has(key)) {
        delete updated[key];
      }
    }
    // Re-add from editor state
    for (const sec of sections) {
      if (!sec.sectionName.trim()) continue;
      updated[sec.sectionName] = Object.fromEntries(
        sec.rows.filter((r) => r.key.trim()).map((r) => [r.key, r.value]),
      );
    }
    onChange(updated);
  };

  const addSection = () => {
    const name = newSectionName.trim();
    if (!name) return;
    const updated = [...customSections, { sectionName: name, rows: [{ key: "", value: "" }] }];
    setNewSectionName("");
    commit(updated);
  };

  const deleteSection = (idx: number) => {
    commit(customSections.filter((_, i) => i !== idx));
    setDeletingSection(null);
  };

  const updateRow = (secIdx: number, rowIdx: number, field: "key" | "value", val: string) => {
    const updated = customSections.map((sec, si) =>
      si !== secIdx ? sec : {
        ...sec,
        rows: sec.rows.map((row, ri) => ri !== rowIdx ? row : { ...row, [field]: val }),
      },
    );
    commit(updated);
  };

  const addRow = (secIdx: number) => {
    const updated = customSections.map((sec, si) =>
      si !== secIdx ? sec : { ...sec, rows: [...sec.rows, { key: "", value: "" }] },
    );
    commit(updated);
  };

  const removeRow = (secIdx: number, rowIdx: number) => {
    const updated = customSections.map((sec, si) =>
      si !== secIdx ? sec : { ...sec, rows: sec.rows.filter((_, ri) => ri !== rowIdx) },
    );
    commit(updated);
  };

  return (
    <div className="glass-card rounded-xl overflow-hidden" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)" }}>
      <div className="px-4 py-3 flex items-center justify-between" style={{ background: "rgba(10,10,30,0.7)", borderBottom: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}>
        <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Custom / Mod Settings (Game.ini)</span>
        <span className="text-xs" style={{ color: "var(--text-subtle)" }}>New [SectionName] blocks for mods</span>
      </div>

      <div className="p-4 space-y-4">
        {customSections.length === 0 && (
          <p className="text-xs text-center py-2" style={{ color: "var(--text-subtle)" }}>
            No custom sections yet. Add one below to configure mod-specific INI settings.
          </p>
        )}

        {customSections.map((sec, si) => (
          <div key={sec.sectionName} className="rounded-lg overflow-hidden" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}>
            <div className="flex items-center justify-between px-3 py-2" style={{ background: "rgba(var(--neon-purple-rgb),0.06)" }}>
              <span className="text-xs font-mono font-semibold" style={{ color: "var(--neon-purple)" }}>[{sec.sectionName}]</span>
              {deletingSection === sec.sectionName ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: "rgba(255,0,85,0.9)" }}>Delete this section?</span>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" style={{ color: "rgba(255,0,85,0.9)" }} onClick={() => deleteSection(si)}>Yes</Button>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" style={{ color: "var(--text-muted)" }} onClick={() => setDeletingSection(null)}>No</Button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" className="h-6 w-6 p-0" style={{ color: "var(--text-subtle)" }} onClick={() => setDeletingSection(sec.sectionName)}>
                  <X className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
            <div className="p-3 space-y-1.5">
              {sec.rows.map((row, ri) => (
                <div key={ri} className="flex items-center gap-2">
                  <Input
                    value={row.key}
                    onChange={(e) => updateRow(si, ri, "key", e.target.value)}
                    placeholder="Key"
                    className="h-7 text-xs font-mono flex-1"
                    style={{ background: "rgba(0,0,0,0.35)", borderColor: "rgba(var(--neon-purple-rgb),0.18)", color: "var(--text-primary)" }}
                  />
                  <span className="text-xs" style={{ color: "var(--text-subtle)" }}>=</span>
                  <Input
                    value={row.value}
                    onChange={(e) => updateRow(si, ri, "value", e.target.value)}
                    placeholder="Value"
                    className="h-7 text-xs font-mono flex-1"
                    style={{ background: "rgba(0,0,0,0.35)", borderColor: "rgba(var(--neon-purple-rgb),0.18)", color: "var(--text-primary)" }}
                  />
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" style={{ color: "var(--text-subtle)" }} onClick={() => removeRow(si, ri)}>
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-xs mt-1"
                style={{ color: "var(--text-subtle)" }}
                onClick={() => addRow(si)}
              >
                + Add row
              </Button>
            </div>
          </div>
        ))}

        {/* Add new section */}
        <div className="flex items-center gap-2 pt-1">
          <Input
            value={newSectionName}
            onChange={(e) => setNewSectionName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addSection(); }}
            placeholder="New section name (e.g. MyMod)"
            className="h-7 text-xs font-mono flex-1"
            style={{ background: "rgba(0,0,0,0.3)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={addSection}
            disabled={!newSectionName.trim()}
            style={{ color: "var(--neon-purple)" }}
          >
            Add Section
          </Button>
        </div>
        <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
          Custom sections are written directly to <code>Game.ini</code> alongside standard settings.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick Setup modal — re-apply a preset to current config
// ---------------------------------------------------------------------------

type ApplyMode = "overlay" | "replace";

function QuickSetupModal({
  onApply,
  onClose,
}: {
  onApply: (gus: Record<string, Record<string, string>>, game: Record<string, Record<string, string>>, mode: ApplyMode) => void;
  onClose: () => void;
}) {
  const [selectedMode, setSelectedMode] = useState<"pvp" | "pve">("pve");
  const [selectedStyle, setSelectedStyle] = useState<string>("casual");
  const [applyMode, setApplyMode] = useState<ApplyMode>("overlay");

  const filteredStyles = PRESET_STYLES.filter((s) => !["guided_custom", "full_custom"].includes(s.id));

  const handleApply = () => {
    const presetGus = buildPresetConfig(selectedMode, selectedStyle);
    // Keys that belong to a separate section or are managed elsewhere — never overwrite from a preset
    const skipKeys = new Set([
      "MaxPlayers", "SessionName", "ServerPassword", "ServerAdminPassword",
      "Port", "QueryPort", "RCONPort", "RCONEnabled",
    ]);
    const gusSection: Record<string, string> = {};
    for (const [k, v] of Object.entries(presetGus)) {
      if (skipKeys.has(k) || v === undefined || v === null) continue;
      gusSection[k] = String(v);
    }
    const gameSection: Record<string, string> = {};
    const style = PRESET_STYLES.find((s) => s.id === selectedStyle);
    if (style?.gameIni) {
      for (const [k, v] of Object.entries(style.gameIni)) {
        if (v !== undefined && v !== null) gameSection[k] = String(v);
      }
    }
    // Apply GameMode Game.ini overrides too
    const mode = GAME_MODES.find((m) => m.id === selectedMode);
    if ((mode as unknown as { gameIni?: Record<string, unknown> })?.gameIni) {
      const mi = (mode as unknown as { gameIni: Record<string, unknown> }).gameIni;
      for (const [k, v] of Object.entries(mi)) {
        if (v !== undefined && v !== null) gameSection[k] = String(v);
      }
    }
    onApply(
      { ServerSettings: gusSection },
      { "/script/shootergame.shootergamemode": gameSection },
      applyMode,
    );
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }}
    >
      <div
        className="w-full max-w-xl mx-4 flex flex-col rounded-2xl overflow-hidden"
        style={{
          background: "rgba(8,8,25,0.98)",
          border: "1px solid rgba(var(--neon-purple-rgb),0.25)",
          boxShadow: "0 16px 64px rgba(0,0,0,0.8)",
        }}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)" }}>
          <div className="flex items-center gap-2">
            <Wand2 className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
            <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Quick Setup</span>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0" style={{ color: "var(--text-muted)" }}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Game mode */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>Game Mode</Label>
            <div className="grid grid-cols-2 gap-2">
              {GAME_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelectedMode(m.id)}
                  className="rounded-lg px-4 py-3 text-left transition-all"
                  style={{
                    background: selectedMode === m.id ? "rgba(var(--neon-purple-rgb),0.12)" : "rgba(255,255,255,0.03)",
                    border: `1px solid ${selectedMode === m.id ? "rgba(var(--neon-purple-rgb),0.5)" : "rgba(255,255,255,0.08)"}`,
                    color: selectedMode === m.id ? "var(--neon-purple)" : "var(--text-primary)",
                  }}
                >
                  <div className="text-sm font-semibold">{m.displayName}</div>
                  <div className="text-xs mt-0.5 opacity-70">{m.description.split(".")[0]}.</div>
                </button>
              ))}
            </div>
          </div>

          {/* Style */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>Style</Label>
            <div className="grid grid-cols-3 gap-2">
              {filteredStyles.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelectedStyle(s.id)}
                  className="rounded-lg px-3 py-2.5 text-left transition-all"
                  style={{
                    background: selectedStyle === s.id ? "rgba(var(--neon-purple-rgb),0.12)" : "rgba(255,255,255,0.03)",
                    border: `1px solid ${selectedStyle === s.id ? "rgba(var(--neon-purple-rgb),0.5)" : "rgba(255,255,255,0.08)"}`,
                    color: selectedStyle === s.id ? "var(--neon-purple)" : "var(--text-primary)",
                  }}
                >
                  <div className="text-sm font-semibold">{s.displayName}</div>
                  <div className="text-xs mt-0.5 opacity-60 line-clamp-2">{s.description.split(".")[0]}.</div>
                </button>
              ))}
            </div>
          </div>

          {/* Apply mode */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>How to Apply</Label>
            <div className="grid grid-cols-2 gap-2">
              {([
                { id: "overlay" as ApplyMode, label: "Overlay", desc: "Write preset values on top of current settings. Other settings are kept." },
                { id: "replace" as ApplyMode, label: "Replace", desc: "Clear current settings first, then apply the full preset from scratch." },
              ] as const).map(({ id, label, desc }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setApplyMode(id)}
                  className="rounded-lg px-3 py-2.5 text-left transition-all"
                  style={{
                    background: applyMode === id ? "rgba(var(--neon-purple-rgb),0.12)" : "rgba(255,255,255,0.03)",
                    border: `1px solid ${applyMode === id ? "rgba(var(--neon-purple-rgb),0.5)" : "rgba(255,255,255,0.08)"}`,
                    color: applyMode === id ? "var(--neon-purple)" : "var(--text-primary)",
                  }}
                >
                  <div className="text-sm font-semibold">{label}</div>
                  <div className="text-xs mt-0.5 opacity-60">{desc}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t shrink-0" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)" }}>
          <Button variant="ghost" onClick={onClose} size="sm" style={{ color: "var(--text-muted)" }}>Cancel</Button>
          <Button
            onClick={handleApply}
            size="sm"
            style={{ background: "rgba(var(--neon-purple-rgb),0.15)", border: "1px solid rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)" }}
          >
            <Wand2 className="w-3.5 h-3.5 mr-1.5" /> Apply Preset
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

// ---------------------------------------------------------------------------
// Shutdown Settings Card
// ---------------------------------------------------------------------------

function ShutdownSettingsCard({ server }: { server: ServerRow }) {
  const [warnPlayers, setWarnPlayers] = useState(server.shutdown_warn_players !== 0);
  const [warnMinutes, setWarnMinutes] = useState(server.shutdown_warn_minutes ?? 5);
  const [message, setMessage]         = useState(
    server.shutdown_message || "Server will shut down in {time}."
  );
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateServerShutdownSettings(server.id, warnPlayers, warnMinutes, message);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      toast.error(`Failed to save shutdown settings: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="glass-card rounded-xl p-4 space-y-4"
      style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}
    >
      <div className="flex items-center gap-2">
        <Settings2 className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Graceful Shutdown</h3>
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={warnPlayers}
          onChange={(e) => setWarnPlayers(e.target.checked)}
          className="w-3.5 h-3.5"
          style={{ accentColor: "var(--neon-purple)" }}
        />
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          Warn online players before shutdown
        </span>
      </label>

      <div className={`space-y-3 pl-5 ${!warnPlayers ? "opacity-40 pointer-events-none" : ""}`}>
        <div className="space-y-1">
          <Label className="text-xs" style={{ color: "var(--text-muted)" }}>Warn time (minutes)</Label>
          <Input
            type="number" min={1} max={60}
            value={warnMinutes}
            onChange={(e) => setWarnMinutes(parseInt(e.target.value, 10) || 5)}
            className="h-7 w-24 text-xs"
            style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" style={{ color: "var(--text-muted)" }}>
            Shutdown message <span className="opacity-60">(&#123;time&#125; = countdown)</span>
          </Label>
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Server will shut down in {time}."
            className="h-7 text-xs"
            style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
          />
        </div>
      </div>

      <Button
        size="sm"
        onClick={handleSave}
        disabled={saving}
        style={{
          background: saved ? "rgba(0,255,136,0.15)" : "rgba(var(--neon-purple-rgb),0.15)",
          border: saved ? "1px solid rgba(0,255,136,0.4)" : "1px solid rgba(var(--neon-purple-rgb),0.4)",
          color: saved ? "var(--neon-green)" : "var(--neon-purple)",
        }}
      >
        {saving ? "Saving…" : saved ? "Saved" : "Save"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Restart Warning Settings Card
// ---------------------------------------------------------------------------

function RestartSettingsCard({ server }: { server: ServerRow }) {
  const [warnPlayers, setWarnPlayers]       = useState(server.restart_warn_players !== 0);
  const [warnMinutes, setWarnMinutes]       = useState(server.restart_warn_minutes ?? 5);
  const [message, setMessage]               = useState(server.restart_message || "Server restarting in {time}.");
  const [cancelMessage, setCancelMessage]   = useState(server.restart_cancel_message || "Restart has been canceled.");
  const [saving, setSaving]                 = useState(false);
  const [saved, setSaved]                   = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateServerRestartSettings(server.id, warnPlayers, warnMinutes, message, cancelMessage);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      toast.error(`Failed to save restart settings: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="glass-card rounded-xl p-4 space-y-4"
      style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}
    >
      <div className="flex items-center gap-2">
        <Settings2 className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Restart Warning</h3>
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={warnPlayers}
          onChange={(e) => setWarnPlayers(e.target.checked)}
          className="w-3.5 h-3.5"
          style={{ accentColor: "var(--neon-purple)" }}
        />
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          Warn online players before restart
        </span>
      </label>

      <div className={`space-y-3 pl-5 ${!warnPlayers ? "opacity-40 pointer-events-none" : ""}`}>
        <div className="space-y-1">
          <Label className="text-xs" style={{ color: "var(--text-muted)" }}>Warn time (minutes)</Label>
          <Input
            type="number" min={1} max={60}
            value={warnMinutes}
            onChange={(e) => setWarnMinutes(parseInt(e.target.value, 10) || 5)}
            className="h-7 w-24 text-xs"
            style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" style={{ color: "var(--text-muted)" }}>
            Restart message <span className="opacity-60">(&#123;time&#125; = countdown)</span>
          </Label>
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Server restarting in {time}."
            className="h-7 text-xs"
            style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" style={{ color: "var(--text-muted)" }}>Cancel message</Label>
          <Input
            value={cancelMessage}
            onChange={(e) => setCancelMessage(e.target.value)}
            placeholder="Restart has been canceled."
            className="h-7 text-xs"
            style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
          />
        </div>
      </div>

      <Button
        size="sm"
        onClick={handleSave}
        disabled={saving}
        style={{
          background: saved ? "rgba(0,255,136,0.15)" : "rgba(var(--neon-purple-rgb),0.15)",
          border: saved ? "1px solid rgba(0,255,136,0.4)" : "1px solid rgba(var(--neon-purple-rgb),0.4)",
          color: saved ? "var(--neon-green)" : "var(--neon-purple)",
        }}
      >
        {saving ? "Saving…" : saved ? "Saved" : "Save"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Update Warning Settings Card
// ---------------------------------------------------------------------------

function UpdateSettingsCard({ server }: { server: ServerRow }) {
  const [warnPlayers, setWarnPlayers]       = useState(server.update_warn_players !== 0);
  const [warnMinutes, setWarnMinutes]       = useState(server.update_warn_minutes ?? 5);
  const [message, setMessage]               = useState(server.update_message || "Server going down for update in {time}.");
  const [cancelMessage, setCancelMessage]   = useState(server.update_cancel_message || "Update has been canceled.");
  const [saving, setSaving]                 = useState(false);
  const [saved, setSaved]                   = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateServerUpdateSettings(server.id, warnPlayers, warnMinutes, message, cancelMessage);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      toast.error(`Failed to save update settings: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="glass-card rounded-xl p-4 space-y-4"
      style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}
    >
      <div className="flex items-center gap-2">
        <Settings2 className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Update Warning</h3>
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={warnPlayers}
          onChange={(e) => setWarnPlayers(e.target.checked)}
          className="w-3.5 h-3.5"
          style={{ accentColor: "var(--neon-purple)" }}
        />
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          Warn online players before update
        </span>
      </label>

      <div className={`space-y-3 pl-5 ${!warnPlayers ? "opacity-40 pointer-events-none" : ""}`}>
        <div className="space-y-1">
          <Label className="text-xs" style={{ color: "var(--text-muted)" }}>Warn time (minutes)</Label>
          <Input
            type="number" min={1} max={60}
            value={warnMinutes}
            onChange={(e) => setWarnMinutes(parseInt(e.target.value, 10) || 5)}
            className="h-7 w-24 text-xs"
            style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" style={{ color: "var(--text-muted)" }}>
            Update message <span className="opacity-60">(&#123;time&#125; = countdown)</span>
          </Label>
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Server going down for update in {time}."
            className="h-7 text-xs"
            style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" style={{ color: "var(--text-muted)" }}>Cancel message</Label>
          <Input
            value={cancelMessage}
            onChange={(e) => setCancelMessage(e.target.value)}
            placeholder="Update has been canceled."
            className="h-7 text-xs"
            style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
          />
        </div>
      </div>

      <Button
        size="sm"
        onClick={handleSave}
        disabled={saving}
        style={{
          background: saved ? "rgba(0,255,136,0.15)" : "rgba(var(--neon-purple-rgb),0.15)",
          border: saved ? "1px solid rgba(0,255,136,0.4)" : "1px solid rgba(var(--neon-purple-rgb),0.4)",
          color: saved ? "var(--neon-green)" : "var(--neon-purple)",
        }}
      >
        {saving ? "Saving…" : saved ? "Saved" : "Save"}
      </Button>
    </div>
  );
}

export function ConfigTab({ server }: Props) {
  const [config, setConfig] = useState<ServerConfigJson | null>(null);
  const [rawGus, setRawGus] = useState("");
  const [rawGame, setRawGame] = useState("");
  const [rawMode, setRawMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readingIni, setReadingIni] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFullModal, setShowFullModal] = useState(false);
  const [showPasteModal, setShowPasteModal] = useState(false);
  const [showQuickSetup, setShowQuickSetup] = useState(false);

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
      setIsDirty(false);
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
      setIsDirty(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setReadingIni(false);
    }
  }, [server.install_path]);

  const handleFieldChange = (field: IniFieldDef, value: string) => {
    if (!config) return;
    setConfig(setIniValue(config, field.section, field.iniSection, field.key, value));
    setIsDirty(true);
  };

  const handleLaunchArgChange = (key: string, val: string) => {
    if (!config) return;
    setConfig({ ...config, launchArgs: { ...(config.launchArgs as Record<string, string> ?? {}), [key]: val } });
    setIsDirty(true);
  };

  const handleImportFile = async () => {
    try {
      const selected = await openFilePicker({
        title: "Select INI File",
        filters: [{ name: "INI Files", extensions: ["ini"] }],
        multiple: false,
      });
      if (!selected || typeof selected !== "string") return;
      const text = await readTextFile(selected);
      const sections = rawTextToSections(text);
      if (!config) return;
      // Determine which file was picked by looking at key section names
      const isGus = Object.keys(sections).some((s) =>
        ["ServerSettings", "SessionSettings", "MessageOfTheDay", "Ragnarok"].includes(s),
      );
      const isGame = Object.keys(sections).some((s) =>
        s.toLowerCase().includes("shootergame"),
      );
      setConfig((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          ...(isGus ? { gameUserSettings: { ...(prev.gameUserSettings as Record<string, Record<string, string>>), ...sections } } : {}),
          ...(isGame ? { gameIni: { ...(prev.gameIni as Record<string, Record<string, string>>), ...sections } } : {}),
          ...(!isGus && !isGame ? { gameUserSettings: { ...(prev.gameUserSettings as Record<string, Record<string, string>>), ...sections } } : {}),
        };
      });
      setIsDirty(true);
      toast.success("INI file imported — review changes and save to apply.");
    } catch (e) {
      toast.error(`Failed to import file: ${e}`);
    }
  };

  const handlePasteApply = (
    gus: Record<string, Record<string, string>>,
    game: Record<string, Record<string, string>>,
  ) => {
    if (!config) return;
    setConfig({
      ...config,
      gameUserSettings: { ...(config.gameUserSettings as Record<string, Record<string, string>>), ...gus },
      gameIni: { ...(config.gameIni as Record<string, Record<string, string>>), ...game },
    });
    setIsDirty(true);
    toast.success("INI text applied — review changes and save to apply.");
  };

  const handleQuickSetupApply = (
    gus: Record<string, Record<string, string>>,
    game: Record<string, Record<string, string>>,
    mode: "overlay" | "replace",
  ) => {
    if (!config) return;
    const base = mode === "replace" ? { gameUserSettings: {}, gameIni: config.gameIni, launchArgs: config.launchArgs } : config;
    setConfig({
      ...base,
      gameUserSettings: { ...(base.gameUserSettings as Record<string, Record<string, string>>), ...gus },
      gameIni: { ...(base.gameIni as Record<string, Record<string, string>>), ...game },
    });
    setIsDirty(true);
    toast.success(`Preset applied (${mode}). Review changes and save.`);
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
      setIsDirty(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);

      // Snapshot INI files into the backup system (best-effort, non-blocking)
      const backupDir = await getAppSetting("backup_dir").catch(() => null);
      const plat = typeof navigator !== "undefined" && !navigator.userAgent.includes("Windows")
        ? "LinuxServer" : "WindowsServer";
      if (backupDir) {
        tauriCmd.createIniBackup(server.id, server.install_path, backupDir, plat).catch(() => {});
      }
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
    <TooltipProvider delayDuration={300}>
    <div className="flex flex-col gap-4 pr-6">
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
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowFullModal(true)}
                disabled={!config}
                style={{ color: "var(--neon-purple)", borderColor: "rgba(var(--neon-purple-rgb),0.3)" }}
              >
                <Settings2 className="w-3.5 h-3.5 mr-1.5" /> Full INI Editor
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowQuickSetup(true)}
                disabled={!config}
                style={{ color: "var(--text-muted)" }}
              >
                <Wand2 className="w-3.5 h-3.5 mr-1.5" /> Quick Setup
              </Button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isDirty && (
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "rgba(255,140,0,0.12)", color: "rgba(255,140,0,0.9)", border: "1px solid rgba(255,140,0,0.3)" }}>
              Unsaved changes
            </span>
          )}
          {/* Import dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                disabled={!config}
                style={{ color: "var(--text-muted)" }}
              >
                <Upload className="w-3.5 h-3.5 mr-1.5" />
                Import
                <ChevronDown className="w-3 h-3 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="text-xs">
              <DropdownMenuItem onClick={readFromIni} disabled={readingIni}>
                <RefreshCw className={`w-3.5 h-3.5 mr-2 ${readingIni ? "animate-spin" : ""}`} />
                Reload from disk
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleImportFile}>
                <FileText className="w-3.5 h-3.5 mr-2" />
                Pick INI file…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowPasteModal(true)}>
                <Clipboard className="w-3.5 h-3.5 mr-2" />
                Paste INI text…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                className={savedFlash ? "btn-neon-green" : "btn-neon-purple"}
                onClick={() => handleSave()}
                disabled={saving || !config || !isDirty}
              >
                <Save className="w-3.5 h-3.5 mr-1.5" />
                {saving ? "Saving…" : savedFlash ? "Saved!" : "Save"}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {isDirty ? "Save and create a config backup" : "No changes to save"}
            </TooltipContent>
          </Tooltip>
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
          <CustomModSections
            gameIni={config.gameIni as Record<string, Record<string, string>>}
            onChange={(updated) => {
              setConfig({ ...config, gameIni: updated });
              setIsDirty(true);
            }}
          />
          <p className="text-xs text-center" style={{ color: "var(--text-subtle)" }}>
            Click <strong style={{ color: "var(--neon-purple)" }}>Full INI Editor</strong> in the toolbar to access all server settings.
          </p>
        </div>
      )}

      {/* Raw INI editor */}
      {rawMode && (
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs font-semibold mb-2" style={{ color: "var(--text-primary)" }}>GameUserSettings.ini</p>
            <textarea
              className="w-full font-mono text-xs rounded-lg p-3 resize-y"
              rows={20}
              style={{ background: "#000008", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", color: "#e0e0ff", outline: "none" }}
              value={rawGus}
              onChange={(e) => { setRawGus(e.target.value); setIsDirty(true); }}
              spellCheck={false}
            />
          </div>
          <div>
            <p className="text-xs font-semibold mb-2" style={{ color: "var(--text-primary)" }}>Game.ini</p>
            <textarea
              className="w-full font-mono text-xs rounded-lg p-3 resize-y"
              rows={10}
              style={{ background: "#000008", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", color: "#e0e0ff", outline: "none" }}
              value={rawGame}
              onChange={(e) => { setRawGame(e.target.value); setIsDirty(true); }}
              spellCheck={false}
            />
          </div>
        </div>
      )}

      {/* Graceful shutdown / restart / update warning settings */}
      <ShutdownSettingsCard server={server} />
      <RestartSettingsCard server={server} />
      <UpdateSettingsCard server={server} />

      {/* Full INI Editor modal */}
      {showFullModal && config && (
        <FullIniModal
          config={config}
          onSave={(updated) => handleSave(updated)}
          onClose={() => setShowFullModal(false)}
        />
      )}

      {/* Paste INI modal */}
      {showPasteModal && (
        <PasteIniModal
          onApply={handlePasteApply}
          onClose={() => setShowPasteModal(false)}
        />
      )}

      {/* Quick Setup modal */}
      {showQuickSetup && (
        <QuickSetupModal
          onApply={handleQuickSetupApply}
          onClose={() => setShowQuickSetup(false)}
        />
      )}
    </div>
    </TooltipProvider>
  );
}
