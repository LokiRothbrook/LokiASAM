"use client";

import { Fragment, useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSavedFlash } from "@/hooks/useSavedFlash";
import { useOnMount } from "@/hooks/useOnMount";
import {
  Save, Code, LayoutList, RefreshCw, ChevronDown, ChevronRight,
  Settings2, X, ToggleLeft, ToggleRight, Terminal,
  HelpCircle, Upload, FileText, Clipboard, Wand2, Sparkles, Package, MessageSquare, AlertTriangle, History,
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { tauriCmd, type ServerConfigJson } from "@/lib/tauri-commands";
import { type IniSections, mergeIniSections, carryOverIdentity, isIdentityKey, parseIniText, iniToText, getIni, setIni, GAME_SESSION_SECTION } from "@/lib/ini-utils";
import { ServerIdentityCard } from "@/components/server/ServerIdentityCard";
import { ServerClusterCard } from "@/components/server/ServerClusterCard";
import { ConfigHistoryDialog } from "@/components/server/ConfigHistoryDialog";
import { AccessListsCard } from "@/components/server/AccessListsCard";
import { HiddenWindowCard } from "@/components/server/HiddenWindowCard";
import { loadEffectiveConfig, saveServerConfigFull } from "@/lib/server-config";
import { checkConfigBeforeSave } from "@/lib/config-checks";
import {
  type PresetBuildInput, type PresetStyleId,
  DEFAULT_GAME_MODE_OPTIONS, DEFAULT_GUIDED_RATES, buildPresetGus, buildPresetGameIni,
} from "@/lib/preset-builder";
import {
  INI_FIELD_GROUPS, LAUNCH_PARAMETERS, GAME_MODES, PRESET_STYLES,
  ARK_EVENTS,
  type IniFieldDef, type LaunchParameter,
} from "@/data/game-data";
import { useAllMaps } from "@/hooks/useAllMaps";
import { updateServerShutdownSettings, updateServerRestartSettings, updateServerUpdateSettings, getAppSetting, setServerActiveEvent, getServers, updateServerMemoryLimit, updateServerMap, addServerMod, removeServerMod, setModMapLock, type ServerRow } from "@/lib/db";
import { toast } from "sonner";
import { NumberField } from "@/components/shared/NumberField";
import { OptionSelect } from "@/components/shared/OptionSelect";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";

interface Props {
  server: ServerRow;
}

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
    const parsed = parseFloat(value);
    const numVal = isNaN(parsed) ? (field.defaultValue as number ?? 0) : parsed;
    return (
      <div className="py-2 space-y-1">
        <FieldLabel field={field} />
        <NumberField
          value={numVal}
          onChange={(v) => onChange(String(v))}
          min={field.min}
          max={field.max}
          step={field.step}
          defaultValue={typeof field.defaultValue === "number" ? field.defaultValue : undefined}
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
  if (param.options) {
    return (
      <div className="py-2 space-y-1">
        <span className="text-xs font-mono font-medium" style={{ color: "var(--text-primary)" }}>{param.flag}</span>
        {param.description && (
          <p className="text-xs" style={{ color: "var(--text-subtle)" }}>{param.description}</p>
        )}
        <OptionSelect value={value} options={param.options} onChange={onChange} size="sm" />
      </div>
    );
  }

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

// Edited on the Advanced tab instead (thread options are mutually exclusive
// there; platform has its own card) — listing them here too would give the
// same setting two editors.
const ADVANCED_TAB_PARAM_KEYS = new Set(["OneThread", "ForceUsePerfThreads", "NoPerfThreads", "ServerPlatform"]);

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
          {LAUNCH_PARAMETERS.filter((p) => p.category !== "cluster" && !ADVANCED_TAB_PARAM_KEYS.has(p.key)).map((p) => (
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
    onApply(parseIniText(gusText), parseIniText(gameText));
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
          background: "var(--popover)",
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
              style={{ background: "var(--terminal-bg)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", color: "var(--terminal-fg)", outline: "none" }}
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
              style={{ background: "var(--terminal-bg)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", color: "var(--terminal-fg)", outline: "none" }}
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
  sectionName: string;
  rows: { key: string; value: string }[];
};

type SettingType = "string" | "boolean" | "integer" | "float";

function inferType(value: string): SettingType {
  if (value === "True" || value === "False") return "boolean";
  if (/^-?\d+$/.test(value)) return "integer";
  if (/^-?\d*\.\d+$/.test(value)) return "float";
  return "string";
}

function defaultForType(t: SettingType): string {
  if (t === "boolean") return "False";
  if (t === "integer") return "0";
  if (t === "float") return "0.0";
  return "";
}

// ---------------------------------------------------------------------------
// Dialog for adding a new setting to a mod section
// ---------------------------------------------------------------------------

function AddSettingDialog({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (key: string, value: string) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<SettingType>("string");

  const handleAdd = () => {
    const k = name.trim();
    if (!k) return;
    onAdd(k, defaultForType(type));
    setName("");
    setType("string");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm" style={{ background: "var(--popover)", border: "1px solid rgba(var(--neon-purple-rgb),0.3)" }}>
        <DialogHeader>
          <DialogTitle className="text-sm" style={{ color: "var(--text-primary)" }}>Add Setting</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs" style={{ color: "var(--text-subtle)" }}>Setting name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              placeholder="e.g. MaxDinos"
              autoFocus
              className="h-8 text-xs font-mono"
              style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-primary)" }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs" style={{ color: "var(--text-subtle)" }}>Value type</label>
            <Select value={type} onValueChange={(v) => setType(v as SettingType)}>
              <SelectTrigger className="h-8 text-xs" style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-primary)" }}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="string">String</SelectItem>
                <SelectItem value="boolean">Boolean (True / False)</SelectItem>
                <SelectItem value="integer">Integer</SelectItem>
                <SelectItem value="float">Float</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
            Initial value: <code className="font-mono">{defaultForType(type) || '""'}</code>
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} style={{ color: "var(--text-muted)" }}>Cancel</Button>
          <Button size="sm" onClick={handleAdd} disabled={!name.trim()} className="btn-neon-purple">Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Type-aware value editor for a single mod setting row
// ---------------------------------------------------------------------------

function ModSettingValue({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const type = inferType(value);

  if (type === "boolean") {
    const checked = value === "True";
    return (
      <button
        type="button"
        onClick={() => onChange(checked ? "False" : "True")}
        className="shrink-0 flex items-center"
      >
        {checked
          ? <ToggleRight className="w-7 h-7" style={{ color: "var(--neon-purple)" }} />
          : <ToggleLeft className="w-7 h-7" style={{ color: "var(--text-subtle)" }} />}
      </button>
    );
  }

  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Value"
      className="h-7 text-xs font-mono flex-1"
      style={{ background: "rgba(0,0,0,0.35)", borderColor: "rgba(var(--neon-purple-rgb),0.18)", color: "var(--text-primary)" }}
    />
  );
}

// ---------------------------------------------------------------------------
// Custom mod sections editor
// ---------------------------------------------------------------------------

// Standard GameUserSettings.ini sections this app already manages elsewhere —
// never touched by the custom mod-section editor below.
const GUS_STANDARD_SECTIONS = new Set([
  "serversettings",
  "sessionsettings",
  "messageoftheday",
  "ragnarok",
  "/script/engine.gamesession",
]);

function CustomModSections({
  gameUserSettings,
  onChange,
}: {
  gameUserSettings: Record<string, Record<string, string>>;
  onChange: (updated: Record<string, Record<string, string>>) => void;
}) {
  const customSections: CustomSection[] = Object.entries(gameUserSettings)
    .filter(([name]) => !GUS_STANDARD_SECTIONS.has(name.toLowerCase()))
    .map(([name, kvs]) => ({
      sectionName: name,
      rows: Object.entries(kvs).map(([key, value]) => ({ key, value })),
    }));

  const [newSectionName, setNewSectionName] = useState("");
  const [deletingSection, setDeletingSection] = useState<string | null>(null);
  const [addSettingFor, setAddSettingFor] = useState<number | null>(null);

  const commit = (sections: CustomSection[]) => {
    const updated = { ...gameUserSettings };
    for (const key of Object.keys(updated)) {
      if (!GUS_STANDARD_SECTIONS.has(key.toLowerCase())) {
        delete updated[key];
      }
    }
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
    commit([...customSections, { sectionName: name, rows: [] }]);
    setNewSectionName("");
  };

  const deleteSection = (idx: number) => {
    commit(customSections.filter((_, i) => i !== idx));
    setDeletingSection(null);
  };

  const addRowWithValue = (secIdx: number, key: string, value: string) => {
    const updated = customSections.map((sec, si) =>
      si !== secIdx ? sec : { ...sec, rows: [...sec.rows, { key, value }] },
    );
    commit(updated);
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

  const removeRow = (secIdx: number, rowIdx: number) => {
    const updated = customSections.map((sec, si) =>
      si !== secIdx ? sec : { ...sec, rows: sec.rows.filter((_, ri) => ri !== rowIdx) },
    );
    commit(updated);
  };

  return (
    <>
      {addSettingFor !== null && (
        <AddSettingDialog
          open
          onClose={() => setAddSettingFor(null)}
          onAdd={(key, value) => addRowWithValue(addSettingFor, key, value)}
        />
      )}

      <div className="glass-card rounded-xl overflow-hidden" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.2)" }}>
        <div className="px-4 py-3 flex items-center justify-between" style={{ background: "var(--surface)", borderBottom: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}>
          <div>
            <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Mod Settings</span>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-subtle)" }}>Custom <code>GameUserSettings.ini</code> sections for mods — add a section per mod, then add its settings.</p>
          </div>
        </div>

        <div className="p-4 space-y-4">
          {customSections.length === 0 && (
            <p className="text-xs text-center py-4" style={{ color: "var(--text-subtle)" }}>
              No mod sections yet. Add one below using the mod&apos;s section name (e.g. <code className="font-mono">MyMod</code>).
            </p>
          )}

          {customSections.map((sec, si) => (
            <div key={sec.sectionName} className="rounded-lg overflow-hidden" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.18)" }}>
              <div className="flex items-center justify-between px-3 py-2" style={{ background: "rgba(var(--neon-purple-rgb),0.07)" }}>
                <span className="text-xs font-mono font-semibold" style={{ color: "rgba(var(--neon-purple-rgb),0.9)" }}>[{sec.sectionName}]</span>
                {deletingSection === sec.sectionName ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs" style={{ color: "rgba(var(--neon-red-rgb),0.9)" }}>Delete section?</span>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" style={{ color: "rgba(var(--neon-red-rgb),0.9)" }} onClick={() => deleteSection(si)}>Yes</Button>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" style={{ color: "var(--text-muted)" }} onClick={() => setDeletingSection(null)}>No</Button>
                  </div>
                ) : (
                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0" style={{ color: "var(--text-subtle)" }} onClick={() => setDeletingSection(sec.sectionName)}>
                    <X className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>

              <div className="p-3 space-y-2">
                {sec.rows.length === 0 && (
                  <p className="text-xs py-1" style={{ color: "var(--text-subtle)" }}>No settings yet — click &quot;Add Setting&quot; below.</p>
                )}
                {sec.rows.map((row, ri) => (
                  <div key={ri} className="flex items-center gap-2">
                    <span className="text-xs font-mono shrink-0 min-w-0 flex-1 truncate" style={{ color: "var(--text-primary)" }} title={row.key}>{row.key}</span>
                    <span className="text-xs shrink-0" style={{ color: "var(--text-subtle)" }}>=</span>
                    <div className="flex-1 min-w-0">
                      <ModSettingValue value={row.value} onChange={(v) => updateRow(si, ri, "value", v)} />
                    </div>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" style={{ color: "var(--text-subtle)" }} onClick={() => removeRow(si, ri)}>
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs mt-1"
                  style={{ color: "rgba(var(--neon-purple-rgb),0.8)", border: "1px dashed rgba(var(--neon-purple-rgb),0.3)" }}
                  onClick={() => setAddSettingFor(si)}
                >
                  + Add Setting
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
              className="h-8 text-xs font-mono flex-1"
              style={{ background: "rgba(0,0,0,0.3)", borderColor: "rgba(var(--neon-purple-rgb),0.25)", color: "var(--text-primary)" }}
            />
            <Button
              size="sm"
              onClick={addSection}
              disabled={!newSectionName.trim()}
              style={{ background: "rgba(var(--neon-purple-rgb),0.15)", color: "rgba(var(--neon-purple-rgb),0.9)", border: "1px solid rgba(var(--neon-purple-rgb),0.35)" }}
            >
              Add Section
            </Button>
          </div>
        </div>
      </div>
    </>
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
    // Same builder the creation wizard uses, so a preset means the same thing
    // in both places. Gameplay keys only — identity is never touched.
    const input: PresetBuildInput = {
      ...DEFAULT_GAME_MODE_OPTIONS,
      gameMode: selectedMode,
      presetStyle: selectedStyle as PresetStyleId,
      guidedRates: DEFAULT_GUIDED_RATES,
      fullCustomGus: {},
      fullCustomGameIni: {},
      name: "", serverPassword: "", adminPassword: "", rconPort: 0, maxPlayers: 0,
      motdMessage: "", motdDuration: 20,
    };
    onApply(buildPresetGus(input), buildPresetGameIni(input), applyMode);
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
          background: "var(--popover)",
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


// ---------------------------------------------------------------------------
// Main ConfigTab
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shutdown Settings Card
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Active Event card
// ---------------------------------------------------------------------------

function ActiveEventCard({ server }: { server: ServerRow }) {
  const queryClient = useQueryClient();
  const [activeEventId, setActiveEventId] = useState<string | null>(server.active_event ?? null);
  const [saving, setSaving] = useState(false);

  const currentEvent = ARK_EVENTS.find((e) => e.id === activeEventId) ?? null;

  const handleSelect = async (val: string) => {
    const newId = val === "none" ? null : val;
    setActiveEventId(newId);
    setSaving(true);
    try {
      await setServerActiveEvent(server.id, newId);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
    } catch (e) {
      toast.error(`Failed to save event: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      id="settings-active-event"
      className="glass-card rounded-xl p-4 space-y-3"
      style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}
    >
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="w-4 h-4 shrink-0" style={{ color: "var(--neon-purple)" }} />
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Active Event</p>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              Adds the event&apos;s mod to <span className="font-mono">-mods=</span> on next server start — that&apos;s what turns the event on in ASA.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {saving && <span className="text-xs" style={{ color: "var(--text-muted)" }}>Saving…</span>}
          <Select value={activeEventId ?? "none"} onValueChange={handleSelect}>
            <SelectTrigger className="w-52 text-sm" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)" }}>
              <SelectValue placeholder="No Event" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No Event</SelectItem>
              {ARK_EVENTS.map((evt) => (
                <SelectItem key={evt.id} value={evt.id}>{evt.displayName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {currentEvent && (
        <p className="text-xs pl-6" style={{ color: "var(--text-muted)" }}>
          {currentEvent.description} <span className="font-mono ml-1" style={{ color: "var(--text-subtle)" }}>Mod: {currentEvent.modId}</span>
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message of the Day card
// ---------------------------------------------------------------------------

const MOTD_SECTION = "MessageOfTheDay";
const MOTD_DEFAULT_DURATION = 20;

function MotdCard({
  config,
  onChange,
}: {
  config: ServerConfigJson;
  onChange: (updated: ServerConfigJson) => void;
}) {
  const gus = config.gameUserSettings as Record<string, Record<string, string>>;
  const message = gus?.[MOTD_SECTION]?.Message ?? "";
  const parsedDuration = parseInt(gus?.[MOTD_SECTION]?.Duration ?? "", 10);
  const duration = isNaN(parsedDuration) ? MOTD_DEFAULT_DURATION : parsedDuration;

  const commit = (nextMessage: string, nextDuration: number) => {
    const updated = { ...gus };
    // An empty message disables the MOTD — drop the section entirely,
    // matching what the creation wizard writes.
    if (nextMessage.trim()) {
      updated[MOTD_SECTION] = { ...(gus?.[MOTD_SECTION] ?? {}), Message: nextMessage, Duration: String(nextDuration) };
    } else {
      delete updated[MOTD_SECTION];
    }
    onChange({ ...config, gameUserSettings: updated });
  };

  return (
    <div
      id="settings-motd"
      className="glass-card rounded-xl p-4 space-y-3"
      style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <MessageSquare className="w-4 h-4 shrink-0" style={{ color: "var(--neon-purple)" }} />
        <div>
          <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Message of the Day</p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Shown to players in a pop-up when they join. Single line only — leave blank to disable.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-wrap pl-6">
        <Input
          type="text"
          value={message}
          // INI values can't span lines — strip any newlines from pasted text.
          onChange={(e) => commit(e.target.value.replace(/[\r\n]+/g, " "), duration)}
          placeholder="Welcome to the server!"
          className="h-8 text-sm flex-1 min-w-48"
          style={{ background: "rgba(0,0,0,0.3)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
        />
        <div className={`flex items-center gap-2 shrink-0 ${message.trim() ? "" : "opacity-50 pointer-events-none"}`}>
          <Label className="text-xs shrink-0" style={{ color: "var(--text-muted)" }}>Display for</Label>
          <div className="w-28">
            <NumberField
              value={duration}
              onChange={(v) => commit(message, v)}
              min={1}
              max={120}
              step={1}
              defaultValue={MOTD_DEFAULT_DURATION}
            />
          </div>
          <span className="text-xs shrink-0" style={{ color: "var(--text-muted)" }}>seconds</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Shared shape behind Shutdown/Restart/Update Warning cards — previously
 * three independent ~90-line copies differing only in which
 * `updateServer*Settings` DB call they made, their copy, and whether a
 * Cancel Message field applies (Shutdown has no countdown to cancel).
 */
function WarningSettingsCard({
  sectionId, title, description, warnLabel, messageLabel, messagePlaceholder,
  cancelMessagePlaceholder, initialWarnPlayers, initialWarnMinutes, initialMessage,
  initialCancelMessage, errorLabel, onSave,
}: {
  sectionId?: string;
  title: string;
  description: string;
  warnLabel: string;
  messageLabel: string;
  messagePlaceholder: string;
  /** Omit to hide the Cancel Message field. */
  cancelMessagePlaceholder?: string;
  initialWarnPlayers: boolean;
  initialWarnMinutes: number;
  initialMessage: string;
  initialCancelMessage?: string;
  errorLabel: string;
  onSave: (params: { warnPlayers: boolean; warnMinutes: number; message: string; cancelMessage: string }) => Promise<void>;
}) {
  const [warnPlayers, setWarnPlayers] = useState(initialWarnPlayers);
  const [warnMinutes, setWarnMinutes] = useState(initialWarnMinutes);
  const [message, setMessage]         = useState(initialMessage);
  const [cancelMessage, setCancelMessage] = useState(initialCancelMessage ?? "");
  const [saving, setSaving]   = useState(false);
  const [saved, triggerSaved] = useSavedFlash();

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({ warnPlayers, warnMinutes, message, cancelMessage });
      triggerSaved();
    } catch (e) {
      toast.error(`Failed to save ${errorLabel}: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      id={sectionId}
      className="glass-card rounded-xl p-4 space-y-4"
      style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}
    >
      <div className="flex items-center gap-2">
        <Settings2 className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{title}</h3>
      </div>
      <p className="text-xs -mt-2" style={{ color: "var(--text-subtle)" }}>{description}</p>

      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={warnPlayers}
          onChange={(e) => setWarnPlayers(e.target.checked)}
          className="w-3.5 h-3.5"
          style={{ accentColor: "var(--neon-purple)" }}
        />
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>{warnLabel}</span>
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
            {messageLabel} <span className="opacity-60">(&#123;time&#125; = countdown)</span>
          </Label>
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={messagePlaceholder}
            className="h-7 text-xs"
            style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
          />
        </div>
        {cancelMessagePlaceholder !== undefined && (
          <div className="space-y-1">
            <Label className="text-xs" style={{ color: "var(--text-muted)" }}>Cancel message</Label>
            <Input
              value={cancelMessage}
              onChange={(e) => setCancelMessage(e.target.value)}
              placeholder={cancelMessagePlaceholder}
              className="h-7 text-xs"
              style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
            />
          </div>
        )}
      </div>

      <Button
        size="sm"
        onClick={handleSave}
        disabled={saving}
        style={{
          background: saved ? "rgba(var(--neon-green-rgb),0.15)" : "rgba(var(--neon-purple-rgb),0.15)",
          border: saved ? "1px solid rgba(var(--neon-green-rgb),0.4)" : "1px solid rgba(var(--neon-purple-rgb),0.4)",
          color: saved ? "var(--neon-green)" : "var(--neon-purple)",
        }}
      >
        {saving ? "Saving…" : saved ? "Saved" : "Save"}
      </Button>
    </div>
  );
}

function ShutdownSettingsCard({ server }: { server: ServerRow }) {
  const queryClient = useQueryClient();
  return (
    <WarningSettingsCard
      title="Shutdown Warning"
      description="Used by the manual Stop button. There is no scheduled/automated shutdown."
      warnLabel="Warn online players before shutdown"
      messageLabel="Shutdown message"
      messagePlaceholder="Server will shut down in {time}."
      initialWarnPlayers={server.shutdown_warn_players !== 0}
      initialWarnMinutes={server.shutdown_warn_minutes ?? 5}
      initialMessage={server.shutdown_message || "Server will shut down in {time}."}
      errorLabel="shutdown settings"
      onSave={async ({ warnPlayers, warnMinutes, message }) => {
        await updateServerShutdownSettings(server.id, warnPlayers, warnMinutes, message);
        queryClient.invalidateQueries({ queryKey: ["servers"] });
      }}
    />
  );
}

function RestartSettingsCard({ server }: { server: ServerRow }) {
  const queryClient = useQueryClient();
  return (
    <WarningSettingsCard
      sectionId="restart-warning-section"
      title="Restart Warning"
      description="Shared by the manual Restart button and scheduled Auto-Restart (Automation tab) — one warning message either way."
      warnLabel="Warn online players before restart"
      messageLabel="Restart message"
      messagePlaceholder="Server restarting in {time}."
      cancelMessagePlaceholder="Restart has been canceled."
      initialWarnPlayers={server.restart_warn_players !== 0}
      initialWarnMinutes={server.restart_warn_minutes ?? 5}
      initialMessage={server.restart_message || "Server restarting in {time}."}
      initialCancelMessage={server.restart_cancel_message || "Restart has been canceled."}
      errorLabel="restart settings"
      onSave={async ({ warnPlayers, warnMinutes, message, cancelMessage }) => {
        await updateServerRestartSettings(server.id, warnPlayers, warnMinutes, message, cancelMessage);
        queryClient.invalidateQueries({ queryKey: ["servers"] });
      }}
    />
  );
}

function UpdateSettingsCard({ server }: { server: ServerRow }) {
  const queryClient = useQueryClient();
  return (
    <WarningSettingsCard
      sectionId="update-warning-section"
      title="Update Warning"
      description="Shared by the manual Apply Update button and Auto-Update (Automation tab) — one warning message either way."
      warnLabel="Warn online players before update"
      messageLabel="Update message"
      messagePlaceholder="Server going down for update in {time}."
      cancelMessagePlaceholder="Update has been canceled."
      initialWarnPlayers={server.update_warn_players !== 0}
      initialWarnMinutes={server.update_warn_minutes ?? 5}
      initialMessage={server.update_message || "Server going down for update in {time}."}
      initialCancelMessage={server.update_cancel_message || "Update has been canceled."}
      errorLabel="update settings"
      onSave={async ({ warnPlayers, warnMinutes, message, cancelMessage }) => {
        await updateServerUpdateSettings(server.id, warnPlayers, warnMinutes, message, cancelMessage);
        queryClient.invalidateQueries({ queryKey: ["servers"] });
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// AdvancedConfigTab
// ---------------------------------------------------------------------------

const SERVER_PLATFORM_OPTIONS = LAUNCH_PARAMETERS.find((p) => p.key === "ServerPlatform")?.options ?? [];

const THREAD_OPTIONS = [
  { value: "", label: "Default (let ARK decide)" },
  { value: "OneThread", label: "OneThread — single CPU thread" },
  { value: "ForceUsePerfThreads", label: "ForceUsePerfThreads — maximize perf threads" },
  { value: "NoPerfThreads", label: "NoPerfThreads — disable perf threads" },
];

function AdvancedConfigTab({
  server,
  config,
  onChange,
}: {
  server: ServerRow;
  config: ServerConfigJson;
  onChange: (patch: Partial<ServerConfigJson>) => void;
}) {
  const [memLimit, setMemLimit] = useState(server.memory_limit_gb != null ? String(server.memory_limit_gb) : "");
  const [savingMem, setSavingMem] = useState(false);

  const launchArgs = config.launchArgs as Record<string, string>;

  const setArg = (key: string, value: string) => {
    onChange({ launchArgs: { ...launchArgs, [key]: value } });
  };

  const currentThread = THREAD_OPTIONS.find((o) => o.value && launchArgs[o.value] === "true")?.value ?? "";

  const handleThreadChange = (val: string) => {
    const next = { ...launchArgs };
    for (const o of THREAD_OPTIONS) { if (o.value) delete next[o.value]; }
    if (val) next[val] = "true";
    onChange({ launchArgs: next });
  };

  const handleSaveMemLimit = async () => {
    setSavingMem(true);
    try {
      const n = parseFloat(memLimit);
      await updateServerMemoryLimit(server.id, isNaN(n) || n <= 0 ? null : n);
      toast.success("Memory limit saved");
    } catch (e) { toast.error(`Failed: ${e}`); }
    finally { setSavingMem(false); }
  };

  return (
    <div className="space-y-4">
      {/* Thread options */}
      <div className="glass-card rounded-xl p-4 space-y-3" style={{ border: "1px solid rgba(var(--neon-orange-rgb),0.2)" }}>
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Thread Options</h3>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Undocumented by Wildcard. Leave at Default unless you have a specific reason to change.
        </p>
        <OptionSelect value={currentThread} options={THREAD_OPTIONS} onChange={handleThreadChange} />
      </div>

      {/* Platform */}
      <div className="glass-card rounded-xl p-4 space-y-3" style={{ border: "1px solid rgba(var(--neon-orange-rgb),0.2)" }}>
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Server Platform</h3>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Passes <code>-ServerPlatform=</code>. Choose All platforms for crossplay between PC, Xbox and PlayStation.
        </p>
        <OptionSelect
          value={launchArgs["ServerPlatform"] ?? ""}
          options={SERVER_PLATFORM_OPTIONS}
          onChange={(v) => setArg("ServerPlatform", v)}
        />
      </div>

      {/* Player access lists */}
      <AccessListsCard
        server={server}
        exclusiveJoin={launchArgs["exclusivejoin"] === "true"}
        onExclusiveJoinChange={(on) => setArg("exclusivejoin", on ? "true" : "false")}
      />

      {/* Custom CLI */}
      <div className="glass-card rounded-xl p-4 space-y-3" style={{ border: "1px solid rgba(var(--neon-orange-rgb),0.2)" }}>
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Custom Launch Arguments</h3>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Appended verbatim to the launch command. Useful for undocumented or mod-specific flags.
        </p>
        <Input
          value={launchArgs["_customCli"] ?? ""}
          onChange={(e) => setArg("_customCli", e.target.value)}
          placeholder="-SomeFlag -AnotherFlag=value"
          className="font-mono text-xs"
          style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-orange-rgb),0.3)", color: "var(--text-primary)" }}
        />
      </div>

      {/* Hide server window — saved immediately (server row), applies on next start */}
      <HiddenWindowCard server={server} />

      {/* Memory limit */}
      <div className="glass-card rounded-xl p-4 space-y-3" style={{ border: "1px solid rgba(var(--neon-orange-rgb),0.2)" }}>
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Memory Limit Restart</h3>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Automatically restart the server if RAM usage exceeds this threshold. Leave blank to disable.
        </p>
        <div className="flex gap-2 items-center">
          <Input
            value={memLimit}
            onChange={(e) => setMemLimit(e.target.value)}
            placeholder="e.g. 12"
            type="number"
            min={1}
            step={0.5}
            className="w-32 text-xs"
            style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-orange-rgb),0.3)", color: "var(--text-primary)" }}
          />
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>GB</span>
          <Button size="sm" variant="outline" onClick={handleSaveMemLimit} disabled={savingMem}
            style={{ borderColor: "rgba(var(--neon-orange-rgb),0.4)", color: "rgba(var(--neon-orange-rgb),0.9)", background: "rgba(var(--neon-orange-rgb),0.06)" }}>
            {savingMem ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {/* Network settings */}
      <div className="glass-card rounded-xl p-4 space-y-3" style={{ border: "1px solid rgba(var(--neon-orange-rgb),0.2)" }}>
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Advanced Network</h3>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          For multi-NIC setups, VPN-based DDoS protection, or port forwarding edge cases. Leave blank if not needed.
        </p>
        {[
          { key: "ServerIP", label: "Server IP (-ServerIP=)", placeholder: "e.g. 1.2.3.4 — public IP for DDoS protection VPN" },
          { key: "MultiHome", label: "MultiHome IP (-MULTIHOME=)", placeholder: "e.g. 192.168.1.100 — internal NIC IP" },
          { key: "UDPSocketPort", label: "UDP Socket Port (-UDPSocketPort=)", placeholder: "Experimental — leave blank (undocumented)" },
        ].map(({ key, label, placeholder }) => (
          <div key={key}>
            <label className="text-xs mb-1 block" style={{ color: "var(--text-muted)" }}>{label}</label>
            <Input
              value={launchArgs[key] ?? ""}
              onChange={(e) => setArg(key, e.target.value)}
              placeholder={placeholder}
              className="text-xs font-mono"
              style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-orange-rgb),0.3)", color: "var(--text-primary)" }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Launch options that describe this particular server rather than gameplay —
 * kept when copying another server's config. (exclusivejoin especially: the
 * whitelist files aren't copied, so copying the flag could lock everyone out.)
 */
const SERVER_SPECIFIC_LAUNCH_ARGS = ["exclusivejoin", "ServerIP", "MultiHome", "MULTIHOME", "UDPSocketPort"];

export function ConfigTab({ server }: Props) {
  const queryClient = useQueryClient();
  // Primitive deps for the loader — the server row object itself is replaced
  // on every status refresh, which must not reload (and discard) edits.
  const serverId = server.id;
  const installPath = server.install_path;
  const allMaps = useAllMaps();
  const [config, setConfig] = useState<ServerConfigJson | null>(null);
  const [rawGus, setRawGus] = useState("");
  const [rawGame, setRawGame] = useState("");
  const [activeTab, setActiveTab] = useState<"settings" | "mods" | "advanced" | "raw">("settings");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readingIni, setReadingIni] = useState(false);
  const [savedFlash, triggerSavedFlash] = useSavedFlash();
  const [isDirty, setIsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPasteModal, setShowPasteModal] = useState(false);
  const [showQuickSetup, setShowQuickSetup] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showCopyFromServer, setShowCopyFromServer] = useState(false);
  const [copyFromServerId, setCopyFromServerId] = useState("");
  const [otherServers, setOtherServers] = useState<ServerRow[]>([]);

  useEffect(() => {
    getServers().then((all) => setOtherServers(all.filter((s) => s.id !== server.id))).catch(() => {});
  }, [server.id]);

  /**
   * This server's identity as INI keys: what the editor holds, with any
   * missing required key filled from the servers row. Passed to
   * carryOverIdentity, which removes identity keys this lacks — so a missing
   * key here must mean "this server has none" (e.g. no join password).
   */
  const ownIdentity = useCallback((gus: IniSections): IniSections => {
    let out = gus;
    const fill = (section: string, key: string, value: string) => {
      if (getIni(out, section, key) === undefined) out = setIni(out, section, key, value);
    };
    fill("SessionSettings", "SessionName", server.name);
    fill("ServerSettings", "ServerAdminPassword", server.admin_password);
    fill("ServerSettings", "RCONEnabled", "True");
    fill("ServerSettings", "RCONPort", String(server.rcon_port));
    fill(GAME_SESSION_SECTION, "MaxPlayers", String(server.max_players));
    if (server.server_password) fill("ServerSettings", "ServerPassword", server.server_password);
    return out;
  }, [server.name, server.admin_password, server.rcon_port, server.max_players, server.server_password]);

  // Bring another server's gameplay config into the editor. Its identity
  // keys (name, passwords, RCON port, max players), MOTD, and server-specific
  // launch options (network binding, whitelist-only mode) are NOT copied —
  // they describe that other server. Ports aren't in the config at all (they
  // come from the server's own record). Review + Save applies it.
  const handleCopyFromServer = async () => {
    if (!copyFromServerId || !config) return;
    try {
      const source = otherServers.find((s) => s.id === copyFromServerId);
      if (!source) return;
      const { config: src } = await loadEffectiveConfig(source);
      const launchArgs: Record<string, string> = { ...(src.launchArgs ?? {}) };
      const ownArgs = (config.launchArgs ?? {}) as Record<string, string>;
      for (const key of SERVER_SPECIFIC_LAUNCH_ARGS) {
        if (key in ownArgs) launchArgs[key] = ownArgs[key];
        else delete launchArgs[key];
      }
      setConfig({
        gameUserSettings: carryOverIdentity(ownIdentity(config.gameUserSettings), src.gameUserSettings),
        gameIni: src.gameIni,
        launchArgs,
      });
      setIsDirty(true);
      setShowCopyFromServer(false);
      setCopyFromServerId("");
      toast.success(`Config copied from ${source.name} — review and save to apply.`);
    } catch (e) {
      toast.error(`Failed to copy config: ${e}`);
    }
  };

  // Load the DB copy (what we last saved). Falls back to — and adopts — the
  // INI files on disk when the DB copy is empty (imported servers), so the
  // editor never opens blank over a real config.
  const loadFromDb = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { config: cfg, fromDisk } = await loadEffectiveConfig({ id: serverId, install_path: installPath });
      setConfig(cfg);
      setRawGus(iniToText(cfg.gameUserSettings));
      setRawGame(iniToText(cfg.gameIni));
      setIsDirty(false);
      if (fromDisk) toast.info("Loaded this server's existing INI files from disk.");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [serverId, installPath]);

  useOnMount(loadFromDb);

  // Explicitly read the INI files on disk into the editor. Launch args aren't
  // stored in the INI files, so the current ones are kept. Marked dirty so the
  // user can Save to make the disk version the app's copy too.
  const readFromIni = useCallback(async () => {
    setReadingIni(true);
    setError(null);
    try {
      const disk = await tauriCmd.readServerConfig(server.install_path);
      setConfig((prev) => ({ ...disk, launchArgs: prev?.launchArgs ?? {} }));
      setRawGus(iniToText(disk.gameUserSettings));
      setRawGame(iniToText(disk.gameIni));
      setIsDirty(true);
      toast.success("Loaded from disk — Save to keep this version.");
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
    setConfig({ ...config, launchArgs: { ...(config.launchArgs ?? {}), [key]: val } });
    setIsDirty(true);
  };

  /**
   * Merge imported sections key by key and keep this server's identity keys —
   * an imported file from another server must not rename it or change its
   * passwords/RCON port.
   */
  const mergeImported = (gus: IniSections, game: IniSections) => {
    setConfig((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        gameUserSettings: carryOverIdentity(ownIdentity(prev.gameUserSettings), mergeIniSections(prev.gameUserSettings, gus)),
        gameIni: mergeIniSections(prev.gameIni, game),
      };
    });
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
      const sections = parseIniText(text);
      if (!config) return;
      // Route each section to its file individually — an imported file
      // containing sections that belong to both files (a combined export,
      // or a custom mod section whose name happens to mention "shootergame")
      // must not dump its entire contents into both; only Game.ini actually
      // uses "/script/shootergame..." sections, everything else is GUS.
      const gusSections: IniSections = {};
      const gameSections: IniSections = {};
      for (const [name, kv] of Object.entries(sections)) {
        if (name.toLowerCase().startsWith("/script/shootergame")) {
          gameSections[name] = kv;
        } else {
          gusSections[name] = kv;
        }
      }
      mergeImported(gusSections, gameSections);
      toast.success("INI file imported — review changes and save to apply.");
    } catch (e) {
      toast.error(`Failed to import file: ${e}`);
    }
  };

  const handlePasteApply = (gus: IniSections, game: IniSections) => {
    if (!config) return;
    mergeImported(gus, game);
    toast.success("INI text applied — review changes and save to apply.");
  };

  const handleQuickSetupApply = (gus: IniSections, game: IniSections, mode: "overlay" | "replace") => {
    if (!config) return;
    if (mode === "overlay") {
      // Preset values win key by key; every other setting is kept.
      setConfig({
        ...config,
        gameUserSettings: carryOverIdentity(ownIdentity(config.gameUserSettings), mergeIniSections(config.gameUserSettings, gus)),
        gameIni: mergeIniSections(config.gameIni, game),
      });
    } else {
      // Replace the gameplay settings with the preset, but keep what isn't
      // gameplay: identity keys, the MOTD, and custom mod sections.
      const modSections: IniSections = Object.fromEntries(
        Object.entries(config.gameUserSettings).filter(([name]) => !GUS_STANDARD_SECTIONS.has(name.toLowerCase())),
      );
      setConfig({
        ...config,
        gameUserSettings: carryOverIdentity(ownIdentity(config.gameUserSettings), mergeIniSections(modSections, gus)),
        gameIni: game,
      });
    }
    setIsDirty(true);
    toast.success(`Preset applied (${mode}). Review changes and save.`);
  };

  // Identity was saved straight to disk + DB by the Identity card; mirror it
  // into the editor (and raw text) without discarding other unsaved edits.
  const handleIdentitySaved = (apply: (cfg: ServerConfigJson) => ServerConfigJson) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = apply(prev);
      setRawGus(iniToText(next.gameUserSettings));
      return next;
    });
  };

  // The config the toolbar Save would write (raw tab edits included).
  const pendingConfig = (): ServerConfigJson | null => {
    if (!config) return null;
    if (activeTab !== "raw") return config;
    return { ...config, gameUserSettings: parseIniText(rawGus), gameIni: parseIniText(rawGame) };
  };

  const [saveIssues, setSaveIssues] = useState<{ cfg: ServerConfigJson; issues: string[] } | null>(null);

  // Check for problems first; if any, ask before writing (feature: save-time checks).
  const handleSave = async (cfg?: ServerConfigJson) => {
    const toSave = cfg ?? pendingConfig();
    if (!toSave) return;
    const issues = await checkConfigBeforeSave(server, toSave).catch(() => []);
    if (issues.length > 0) {
      setSaveIssues({ cfg: toSave, issues });
      return;
    }
    await doSave(toSave);
  };

  // Write to disk AND the DB (snapshot first, identity synced) — see server-config.ts.
  const doSave = async (toSave: ServerConfigJson) => {
    setSaving(true);
    setError(null);
    try {
      setConfig(toSave);
      const { warnings } = await saveServerConfigFull(server, toSave);
      warnings.forEach((w) => toast.warning(w));
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      setIsDirty(false);
      triggerSavedFlash();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const switchToRaw = () => {
    if (config) {
      setRawGus(iniToText(config.gameUserSettings as Record<string, Record<string, string>>));
      setRawGame(iniToText(config.gameIni as Record<string, Record<string, string>>));
    }
    setActiveTab("raw");
  };

  const handleMapChange = async (newMapId: string) => {
    if (server.status !== "stopped") {
      toast.error("Server must be stopped to change maps");
      return;
    }
    try {
      const baseDir = await getAppSetting("base_dir");
      if (!baseDir) {
        toast.error("Base directory not configured");
        return;
      }
      const newMapData = allMaps.find((m) => m.id === newMapId);
      if (!newMapData) {
        toast.error("Map not found");
        return;
      }
      const oldMapData = allMaps.find((m) => m.id === server.map_id);
      // Update the SaveGames symlink for the new map
      await tauriCmd.createModsSavesLink(server.install_path, server.id, baseDir, newMapData.mapPath);
      // Update the database
      await updateServerMap(server.id, newMapId);

      // Swap the map-required mod: the old map's required mod is dropped
      // from the list entirely (unless the new map needs the exact same
      // mod) — mirrors the wizard's handleMapSelect, which drops the
      // previous map's mod from the list the same way when switching maps
      // pre-creation. The new map's required mod is added/locked so it
      // can't be disabled or removed from the Mods tab while selected.
      if (oldMapData?.isMod && oldMapData.requiredModId && oldMapData.requiredModId !== newMapData.requiredModId) {
        await removeServerMod(server.id, oldMapData.requiredModId);
      }
      if (newMapData.isMod && newMapData.requiredModId) {
        // The map's required mod never goes through the "paste ID"
        // CurseForge verification, so it has no real name available — fall
        // back to the custom/mod map's own display name instead of a bare
        // "Unknown Mod".
        await addServerMod(server.id, newMapData.requiredModId, newMapData.displayName);
        await setModMapLock(server.id, newMapData.requiredModId, true);
      }

      queryClient.invalidateQueries({ queryKey: ["servers"] });
      toast.success(`Map changed to ${newMapData.displayName}`);
    } catch (e) {
      toast.error(`Failed to change map: ${e}`);
    }
  };

  const switchFromRaw = () => {
    const gus = parseIniText(rawGus);
    const game = parseIniText(rawGame);
    if (config) setConfig({ ...config, gameUserSettings: gus, gameIni: game });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-6 h-6 animate-spin" style={{ color: "var(--neon-purple)" }} />
        <span className="ml-3 text-sm" style={{ color: "var(--text-muted)" }}>Loading saved config…</span>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
    <div className="flex flex-col gap-4 pr-6">

      {/* ── Sticky toolbar — always visible at top ─────────────────────────── */}
      <div
        className="sticky top-0 z-10 flex items-center justify-between gap-3 flex-wrap py-2 -mx-1 px-1"
        style={{ background: "var(--background)", borderBottom: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}
      >
        {/* Tab selectors */}
        <div className="flex items-center gap-1" data-tour="cfg-views">
          <button
            onClick={() => { if (activeTab === "raw") switchFromRaw(); setActiveTab("settings"); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            style={activeTab === "settings"
              ? { background: "rgba(var(--neon-purple-rgb),0.15)", color: "var(--neon-purple)", border: "1px solid rgba(var(--neon-purple-rgb),0.4)" }
              : { color: "var(--text-muted)", border: "1px solid transparent" }}
          >
            <LayoutList className="w-3.5 h-3.5" /> Settings
          </button>
          <button
            onClick={() => { if (activeTab === "raw") switchFromRaw(); setActiveTab("mods"); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            style={activeTab === "mods"
              ? { background: "rgba(var(--neon-purple-rgb),0.12)", color: "rgba(var(--neon-purple-rgb),0.9)", border: "1px solid rgba(var(--neon-purple-rgb),0.35)" }
              : { color: "var(--text-muted)", border: "1px solid transparent" }}
          >
            <Package className="w-3.5 h-3.5" /> Mod Settings
          </button>
          <button
            onClick={() => { if (activeTab === "raw") switchFromRaw(); setActiveTab("advanced"); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            style={activeTab === "advanced"
              ? { background: "rgba(var(--neon-orange-rgb),0.1)", color: "rgba(var(--neon-orange-rgb),0.9)", border: "1px solid rgba(var(--neon-orange-rgb),0.35)" }
              : { color: "var(--text-muted)", border: "1px solid transparent" }}
          >
            <Settings2 className="w-3.5 h-3.5" /> Advanced
          </button>
          <button
            onClick={switchToRaw}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            style={activeTab === "raw"
              ? { background: "rgba(var(--neon-cyan-rgb),0.08)", color: "var(--neon-cyan)", border: "1px solid rgba(var(--neon-cyan-rgb),0.35)" }
              : { color: "var(--text-muted)", border: "1px solid transparent" }}
          >
            <Code className="w-3.5 h-3.5" /> Raw INI
          </button>
          <button
            data-tour="cfg-quick-setup"
            onClick={() => setShowQuickSetup(true)}
            disabled={!config}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            style={{ color: "var(--text-subtle)", border: "1px solid transparent" }}
          >
            <Wand2 className="w-3.5 h-3.5" /> Quick Setup
          </button>
        </div>

        {/* Right: dirty badge + import + save */}
        <div className="flex items-center gap-2">
          {isDirty && (
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "rgba(var(--neon-orange-rgb),0.12)", color: "rgba(var(--neon-orange-rgb),0.9)", border: "1px solid rgba(var(--neon-orange-rgb),0.3)" }}>
              Unsaved changes
            </span>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild data-tour="cfg-menu">
              <Button size="sm" variant="ghost" disabled={!config} style={{ color: "var(--text-muted)" }}>
                <Upload className="w-3.5 h-3.5 mr-1.5" />
                Import
                <ChevronDown className="w-3 h-3 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="text-xs">
              <DropdownMenuItem onClick={() => setShowHistory(true)}>
                <History className="w-3.5 h-3.5 mr-2" />
                Config history…
              </DropdownMenuItem>
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
              {otherServers.length > 0 && (
                <DropdownMenuItem onClick={() => setShowCopyFromServer(true)}>
                  <Settings2 className="w-3.5 h-3.5 mr-2" />
                  Copy from server…
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                className={savedFlash ? "btn-neon-green" : "btn-neon-purple"}
                onClick={() => handleSave()}
                data-tour="cfg-save"
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
        <div className="text-sm px-4 py-3 rounded-lg" style={{ background: "rgba(var(--neon-red-rgb),0.08)", border: "1px solid rgba(var(--neon-red-rgb),0.3)", color: "var(--neon-red)" }}>
          {error}
        </div>
      )}

      {/* ── Settings view — all INI field groups plus session/warning settings ── */}
      {activeTab === "settings" && config && (
        <div className="flex flex-col gap-4">
          {/* Map Selector */}
          <div className="glass-card rounded-xl p-4 space-y-3" style={{ border: "1px solid rgba(var(--neon-cyan-rgb),0.2)" }}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Server Map</p>
                <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                  Current map: <strong>{allMaps.find((m) => m.id === server.map_id)?.displayName ?? server.map_id}</strong>
                </p>
              </div>
              {server.status !== "stopped" && (
                <div className="text-xs px-2 py-1 rounded" style={{ background: "rgba(var(--neon-orange-rgb),0.15)", color: "var(--neon-orange)" }}>
                  Stop to change
                </div>
              )}
            </div>
            <Select value={server.map_id} onValueChange={handleMapChange} disabled={server.status !== "stopped"}>
              <SelectTrigger style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-cyan-rgb),0.3)" }}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {allMaps.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Identity (name/ports/passwords/max players) has its own card and
              is filtered out of the generic field groups below, so each
              setting has exactly one editor. Active Event and MOTD follow it
              as the other session-scoped settings. */}
          <ServerIdentityCard server={server} onIdentitySaved={handleIdentitySaved} />
          <ActiveEventCard server={server} />
          <MotdCard config={config} onChange={(updated) => { setConfig(updated); setIsDirty(true); }} />
          <ServerClusterCard server={server} />
          {INI_FIELD_GROUPS.map((g, idx) => {
            const fields = g.fields.filter((f) => !isIdentityKey(f.iniSection, f.key));
            if (fields.length === 0) return null;
            return (
              <SectionGroup
                key={g.id}
                title={g.title}
                fields={fields}
                config={config}
                onChange={handleFieldChange}
                defaultOpen={idx < 3}
              />
            );
          })}
          <LaunchParamGroup config={config} onChange={handleLaunchArgChange} />

          {/* Warnings — governs both the manual action buttons and (for
              restart/update) their scheduled counterparts in the Automation tab. */}
          <div className="pt-2 flex items-center gap-2">
            <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Warnings</h3>
          </div>
          <ShutdownSettingsCard server={server} />
          <RestartSettingsCard server={server} />
          <UpdateSettingsCard server={server} />
        </div>
      )}

      {/* ── Mod Settings tab ─────────────────────────────────────────────── */}
      {activeTab === "mods" && config && (
        <CustomModSections
          gameUserSettings={config.gameUserSettings as Record<string, Record<string, string>>}
          onChange={(updated) => {
            setConfig({ ...config, gameUserSettings: updated });
            setIsDirty(true);
          }}
        />
      )}

      {/* ── Advanced tab ──────────────────────────────────────────────────── */}
      {activeTab === "advanced" && config && (
        <AdvancedConfigTab server={server} config={config} onChange={(patch) => { setConfig({ ...config, ...patch }); setIsDirty(true); }} />
      )}

      {/* ── Raw INI editor ────────────────────────────────────────────────── */}
      {activeTab === "raw" && (
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs font-semibold mb-2" style={{ color: "var(--text-primary)" }}>GameUserSettings.ini</p>
            <textarea
              className="w-full font-mono text-xs rounded-lg p-3 resize-y"
              rows={20}
              style={{ background: "var(--terminal-bg)", border: "1px solid rgba(var(--neon-cyan-rgb),0.2)", color: "var(--terminal-fg)", outline: "none" }}
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
              style={{ background: "var(--terminal-bg)", border: "1px solid rgba(var(--neon-cyan-rgb),0.2)", color: "var(--terminal-fg)", outline: "none" }}
              value={rawGame}
              onChange={(e) => { setRawGame(e.target.value); setIsDirty(true); }}
              spellCheck={false}
            />
          </div>
        </div>
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

      {/* Copy from server modal */}
      {showCopyFromServer && (
        <Dialog open onOpenChange={(v) => { if (!v) { setShowCopyFromServer(false); setCopyFromServerId(""); } }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Copy Config from Server</DialogTitle>
            </DialogHeader>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Replaces this server&apos;s gameplay settings and launch parameters with the selected server&apos;s.
              This server&apos;s name, passwords, ports and MOTD are kept. Review, then Save to apply.
            </p>
            <Select value={copyFromServerId} onValueChange={setCopyFromServerId}>
              <SelectTrigger className="w-full text-xs"><SelectValue placeholder="Select a server…" /></SelectTrigger>
              <SelectContent>
                {otherServers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => { setShowCopyFromServer(false); setCopyFromServerId(""); }}>Cancel</Button>
              <Button size="sm" className="btn-neon-purple" disabled={!copyFromServerId} onClick={handleCopyFromServer}>Copy Config</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {showHistory && config && (
        <ConfigHistoryDialog
          server={server}
          currentConfig={pendingConfig() ?? config}
          hasUnsavedChanges={isDirty}
          onClose={() => setShowHistory(false)}
          onRestored={() => { loadFromDb(); queryClient.invalidateQueries({ queryKey: ["servers"] }); }}
        />
      )}

      {/* Save-time checks — shown when the config has problems worth confirming */}
      {saveIssues && (
        <Dialog open onOpenChange={(v) => { if (!v) setSaveIssues(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" style={{ color: "var(--neon-orange)" }} />
                Check before saving
              </DialogTitle>
            </DialogHeader>
            <ul className="space-y-2">
              {saveIssues.issues.map((issue) => (
                <li key={issue} className="text-xs leading-relaxed rounded-lg px-3 py-2"
                  style={{ background: "rgba(var(--neon-orange-rgb),0.06)", border: "1px solid rgba(var(--neon-orange-rgb),0.2)", color: "var(--text-primary)" }}>
                  {issue}
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setSaveIssues(null)}>Go back</Button>
              <Button size="sm" className="btn-neon-purple" onClick={() => { const c = saveIssues.cfg; setSaveIssues(null); doSave(c); }}>
                Save anyway
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
    </TooltipProvider>
  );
}
