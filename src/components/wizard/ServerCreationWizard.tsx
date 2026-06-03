"use client";

/**
 * ServerCreationWizard — multi-step wizard for creating and installing a new ASA server.
 *
 * Dynamic step flow:
 *   0 - Basic Info        (name, map dropdown, max players, passwords)
 *   1 - Game Mode         (PvP / PvE)
 *   2 - Server Style      (Official | Casual | Boosted | Guided Custom | Full Custom)
 *   [2a] Guided Rates     (only if Guided Custom)
 *   [2b] Full INI Config  (only if Full Custom)
 *   N - Network & Ports
 *   N - Cluster
 *   N - Automation
 *   N - Mods
 *   N - Install
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Server, Network, GitBranch, Clock, Package,
  Download, ArrowRight, ArrowLeft, Loader2, AlertCircle,
  CheckCircle2, Plus, X, ChevronRight, StopCircle, RefreshCw,
  Sword, Leaf, Sliders, Settings2, Code2, Globe, Lock,
  ChevronDown, ChevronUp, LayoutList,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { CommandOutputPanel } from "@/components/shared/CommandOutputPanel";
import { LokiIcon } from "@/components/shared/LokiIcon";
import {
  getReleasedMaps, getOfficialMaps, getModMaps, getMapById,
  GAME_MODES, PRESET_STYLES, INI_FIELD_GROUPS, buildPresetConfig,
  DEFAULT_GAME_USER_SETTINGS, DEFAULT_GAME_INI,
  NOTIFICATION_EVENTS,
  type ArkMap, type GameModeConfig, type PresetStyle,
} from "@/data/game-data";
import { dispatchNotification } from "@/lib/notifications";
import {
  getAppSetting, createServer, deleteServerRecord, saveServerConfig,
  createSchedule, getClusters, isServerNameTaken, updateServerStatus,
  type ClusterRow,
} from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Wizard data model
// ---------------------------------------------------------------------------

interface GuidedRates {
  xpMultiplier: number;
  harvestMultiplier: number;
  tamingMultiplier: number;
  breedingSpeedMultiplier: number;
  resourceRespawnMultiplier: number;
  playerDamageMultiplier: number;
  nightSpeedMultiplier: number;
  enhanceSkillGains: boolean;
}

interface WizardData {
  // Step 0 — Basic Info
  name: string;
  mapId: string;
  maxPlayers: number;
  serverPassword: string;
  adminPassword: string;
  // Step 1 — Game Mode
  gameMode: "pvp" | "pve";
  // Step 2 — Style
  presetStyle: "official" | "casual" | "boosted" | "guided_custom" | "full_custom";
  // Step 2a — Guided Custom rates
  guidedRates: GuidedRates;
  // Step 2b — Full Custom INI (raw section maps)
  fullCustomGus: Record<string, Record<string, string>>;
  fullCustomGameIni: Record<string, Record<string, string>>;
  // Network
  port: number;
  queryPort: number;
  rconPort: number;
  // Cluster
  clusterId: string;
  // Automation
  autoUpdate: boolean;
  autoUpdateCron: string;
  autoRestart: boolean;
  autoRestartCron: string;
  autoBackup: boolean;
  autoBackupCron: string;
  backupRetention: number;
  // Mods — lockedModIds are auto-added from map selection and cannot be removed
  modIds: string[];
  lockedModIds: string[];
}

const DEFAULT_GUIDED_RATES: GuidedRates = {
  xpMultiplier: 2.0,
  harvestMultiplier: 2.0,
  tamingMultiplier: 3.0,
  breedingSpeedMultiplier: 5.0,
  resourceRespawnMultiplier: 0.5,
  playerDamageMultiplier: 1.0,
  nightSpeedMultiplier: 2.0,
  enhanceSkillGains: false,
};

const DEFAULT_DATA: WizardData = {
  name: "",
  mapId: "theisland",
  maxPlayers: 70,
  serverPassword: "",
  adminPassword: "",
  gameMode: "pve",
  presetStyle: "casual",
  guidedRates: DEFAULT_GUIDED_RATES,
  fullCustomGus: {},
  fullCustomGameIni: {},
  port: 7777,
  queryPort: 27015,
  rconPort: 27020,
  clusterId: "",
  autoUpdate: true,
  autoUpdateCron: "0 3 * * *",
  autoRestart: true,
  autoRestartCron: "0 6 * * *",
  autoBackup: true,
  autoBackupCron: "0 */6 * * *",
  backupRetention: 10,
  modIds: [],
  lockedModIds: [],
};

// ---------------------------------------------------------------------------
// Dynamic step definitions
// ---------------------------------------------------------------------------

interface StepDef {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}

function computeSteps(data: WizardData): StepDef[] {
  const steps: StepDef[] = [
    { id: "basic",    label: "Basic Info",  icon: Server },
    { id: "gamemode", label: "Game Mode",   icon: Sword },
    { id: "style",    label: "Server Style", icon: Sliders },
  ];
  if (data.presetStyle === "guided_custom") {
    steps.push({ id: "guided", label: "Custom Rates", icon: Settings2 });
  }
  if (data.presetStyle === "full_custom") {
    steps.push({ id: "full_ini", label: "INI Config", icon: Code2 });
  }
  steps.push(
    { id: "network",    label: "Network",    icon: Network },
    { id: "cluster",    label: "Cluster",    icon: GitBranch },
    { id: "automation", label: "Automation", icon: Clock },
    { id: "mods",       label: "Mods",       icon: Package },
    { id: "install",    label: "Install",    icon: Download },
  );
  return steps;
}

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

function BasicInfoStep({
  data,
  onChange,
  onNameValidated,
}: {
  data: WizardData;
  onChange: (patch: Partial<WizardData>) => void;
  onNameValidated: (valid: boolean) => void;
}) {
  const officialMaps = getOfficialMaps();
  const modMaps      = getModMaps();
  const [nameError, setNameError] = useState("");
  const [checkingName, setCheckingName] = useState(false);
  const [nameChecked, setNameChecked] = useState(false);
  const [mapMenuOpen, setMapMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedMap = getMapById(data.mapId);

  // Close dropdown when clicking outside
  useEffect(() => {
    function onClickOut(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMapMenuOpen(false);
      }
    }
    if (mapMenuOpen) document.addEventListener("mousedown", onClickOut);
    return () => document.removeEventListener("mousedown", onClickOut);
  }, [mapMenuOpen]);

  const checkName = useCallback(async (name: string) => {
    if (!name.trim()) {
      setNameError("Server name is required.");
      setNameChecked(true);
      onNameValidated(false);
      return;
    }
    setCheckingName(true);
    try {
      const taken = await isServerNameTaken(name.trim());
      setNameError(taken ? "A server with this name already exists." : "");
      setNameChecked(true);
      onNameValidated(!taken);
    } catch {
      setNameError("");
      setNameChecked(true);
      onNameValidated(true);
    } finally {
      setCheckingName(false);
    }
  }, [onNameValidated]);

  const handleMapSelect = (map: ArkMap) => {
    const patch: Partial<WizardData> = { mapId: map.id };
    if (map.isMod && map.requiredModId) {
      // Auto-add the required mod and lock it
      const newModIds = data.modIds.includes(map.requiredModId)
        ? data.modIds
        : [...data.modIds, map.requiredModId];
      patch.modIds = newModIds;
      patch.lockedModIds = [map.requiredModId];
    } else {
      // Removing any previously locked mod (map changed to non-mod)
      const prevMap = getMapById(data.mapId);
      if (prevMap?.isMod && prevMap.requiredModId) {
        patch.modIds = data.modIds.filter((id) => id !== prevMap.requiredModId);
        patch.lockedModIds = [];
      } else {
        patch.lockedModIds = [];
      }
    }
    onChange(patch);
    setMapMenuOpen(false);
  };

  const MapOption = ({ map }: { map: ArkMap }) => {
    const active = data.mapId === map.id;
    return (
      <button
        onClick={() => handleMapSelect(map)}
        className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-all hover:bg-[rgba(191,0,255,0.08)]"
        style={{
          background: active ? "rgba(191,0,255,0.12)" : "transparent",
        }}
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm truncate" style={{ color: active ? "var(--neon-purple)" : "var(--text-primary)" }}>
            {map.displayName}
            {map.isMod && (
              <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(0,255,255,0.1)", color: "var(--neon-cyan)", border: "1px solid rgba(0,255,255,0.2)" }}>
                MOD
              </span>
            )}
          </p>
          {map.dlcRequired && (
            <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>Requires: {map.dlcName}</p>
          )}
          {map.isMod && map.requiredModId && (
            <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>Mod ID: {map.requiredModId} (auto-added)</p>
          )}
        </div>
        {active && <CheckCircle2 className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--neon-purple)" }} />}
      </button>
    );
  };

  return (
    <div className="space-y-5">
      {/* Name */}
      <div className="space-y-1.5">
        <Label style={{ color: "var(--text-primary)" }}>Server Name <span style={{ color: "var(--neon-red)" }}>*</span></Label>
        <Input
          value={data.name}
          onChange={(e) => { onChange({ name: e.target.value }); onNameValidated(false); setNameChecked(false); }}
          onBlur={(e) => checkName(e.target.value)}
          placeholder="My ASA Server"
          style={{
            background: "rgba(10,10,30,0.8)",
            borderColor: nameError ? "var(--neon-red)" : "rgba(191,0,255,0.3)",
            color: "var(--text-primary)",
          }}
        />
        {checkingName && (
          <p className="text-xs flex items-center gap-1" style={{ color: "var(--text-muted)" }}>
            <Loader2 className="w-3 h-3 animate-spin" /> Checking availability…
          </p>
        )}
        {!checkingName && nameError && (
          <p className="text-xs flex items-center gap-1" style={{ color: "var(--neon-red)" }}>
            <AlertCircle className="w-3 h-3" /> {nameError}
          </p>
        )}
        {!checkingName && !nameError && nameChecked && data.name.trim() && (
          <p className="text-xs flex items-center gap-1" style={{ color: "var(--neon-green)" }}>
            <CheckCircle2 className="w-3 h-3" /> Name available
          </p>
        )}
      </div>

      {/* Map dropdown */}
      <div className="space-y-1.5">
        <Label style={{ color: "var(--text-primary)" }}>Map</Label>
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMapMenuOpen((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-left"
            style={{
              background: "rgba(10,10,30,0.8)",
              border: "1px solid rgba(191,0,255,0.3)",
              color: "var(--text-primary)",
            }}
          >
            <span className="flex items-center gap-2 text-sm">
              {selectedMap?.displayName ?? "Select a map…"}
              {selectedMap?.isMod && (
                <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(0,255,255,0.1)", color: "var(--neon-cyan)", border: "1px solid rgba(0,255,255,0.2)" }}>MOD</span>
              )}
              {selectedMap?.dlcRequired && (
                <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(191,0,255,0.1)", color: "var(--neon-purple)", border: "1px solid rgba(191,0,255,0.2)" }}>DLC</span>
              )}
            </span>
            <ChevronDown className="w-4 h-4 shrink-0" style={{ color: "var(--text-muted)" }} />
          </button>

          {mapMenuOpen && (
            <div
              className="absolute top-full left-0 right-0 z-50 mt-1 rounded-lg overflow-hidden"
              style={{
                background: "rgba(8,8,25,0.98)",
                border: "1px solid rgba(191,0,255,0.3)",
                boxShadow: "0 8px 32px rgba(0,0,0,0.7)",
                maxHeight: "320px",
                overflowY: "auto",
              }}
            >
              <div className="p-2">
                {/* Official Maps */}
                <p className="text-[10px] font-semibold px-3 pt-1 pb-2 uppercase tracking-wider" style={{ color: "var(--text-subtle)" }}>
                  Official Maps
                </p>
                {officialMaps.map((m) => <MapOption key={m.id} map={m} />)}

                {/* Mod Maps */}
                {modMaps.length > 0 && (
                  <>
                    <div className="my-2 border-t" style={{ borderColor: "rgba(191,0,255,0.12)" }} />
                    <p className="text-[10px] font-semibold px-3 pt-1 pb-2 uppercase tracking-wider" style={{ color: "var(--text-subtle)" }}>
                      Mod Maps
                    </p>
                    {modMaps.map((m) => <MapOption key={m.id} map={m} />)}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {selectedMap?.isMod && selectedMap.requiredModId && (
          <div
            className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
            style={{ background: "rgba(0,255,255,0.06)", border: "1px solid rgba(0,255,255,0.2)" }}
          >
            <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--neon-cyan)" }} />
            <p style={{ color: "var(--neon-cyan)" }}>
              Mod map selected — mod <strong>{selectedMap.requiredModId}</strong> will be automatically added and locked to your mod list.
            </p>
          </div>
        )}
      </div>

      {/* Max Players */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label style={{ color: "var(--text-primary)" }}>Max Players</Label>
          <span className="text-sm font-mono font-bold" style={{ color: "var(--neon-purple)" }}>{data.maxPlayers}</span>
        </div>
        <Slider min={1} max={200} step={1} value={[data.maxPlayers]} onValueChange={([v]) => onChange({ maxPlayers: v })} />
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
// Step 1 — Game Mode
// ---------------------------------------------------------------------------

function GameModeStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  return (
    <div className="space-y-4">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Choose the core ruleset for your server. This determines whether players can fight each other.
      </p>
      <div className="grid grid-cols-2 gap-4">
        {GAME_MODES.map((mode: GameModeConfig) => {
          const active = data.gameMode === mode.id;
          return (
            <button
              key={mode.id}
              onClick={() => onChange({ gameMode: mode.id })}
              className="rounded-xl p-5 text-left transition-all flex flex-col gap-3"
              style={{
                background: active ? "rgba(191,0,255,0.1)" : "rgba(10,10,30,0.5)",
                border: `1px solid ${active ? "rgba(191,0,255,0.5)" : "rgba(191,0,255,0.12)"}`,
                boxShadow: active ? "0 0 24px rgba(191,0,255,0.1)" : "none",
              }}
            >
              <div className="text-3xl">{mode.icon}</div>
              <div>
                <p className="text-base font-bold" style={{ color: active ? "var(--neon-purple)" : "var(--text-primary)" }}>
                  {mode.displayName}
                </p>
                <p className="text-xs mt-1.5 leading-relaxed" style={{ color: "var(--text-muted)" }}>
                  {mode.description}
                </p>
              </div>
              {active && (
                <div className="flex items-center gap-1.5 mt-auto">
                  <CheckCircle2 className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
                  <span className="text-xs font-semibold" style={{ color: "var(--neon-purple)" }}>Selected</span>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Server Style
// ---------------------------------------------------------------------------

function StyleStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const modeLabel = data.gameMode === "pvp" ? "PvP" : "PvE";

  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Pick the rate preset for your <strong style={{ color: "var(--text-primary)" }}>{modeLabel}</strong> server.
        Guided Custom lets you tune rates step-by-step; Full Custom opens the raw INI editor.
      </p>
      <div className="space-y-2 max-h-90 overflow-y-auto pr-1">
        {PRESET_STYLES.map((style: PresetStyle) => {
          const active = data.presetStyle === style.id;
          return (
            <button
              key={style.id}
              onClick={() => onChange({ presetStyle: style.id as WizardData["presetStyle"] })}
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
                    {style.displayName}
                  </p>
                  <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{style.description}</p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {style.tags.map((tag) => (
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
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded"
                      style={{
                        background: data.gameMode === "pvp" ? "rgba(255,0,85,0.1)" : "rgba(0,255,136,0.1)",
                        color: data.gameMode === "pvp" ? "var(--neon-red)" : "var(--neon-green)",
                        border: `1px solid ${data.gameMode === "pvp" ? "rgba(255,0,85,0.3)" : "rgba(0,255,136,0.3)"}`,
                      }}
                    >
                      {modeLabel}
                    </span>
                  </div>
                </div>
                {active && <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "var(--neon-purple)" }} />}
              </div>
              {(style.id === "guided_custom" || style.id === "full_custom") && active && (
                <p className="text-[10px] mt-2 flex items-center gap-1" style={{ color: "var(--neon-cyan)" }}>
                  <ArrowRight className="w-3 h-3" />
                  {style.id === "guided_custom" ? "Next step: configure your rates" : "Next step: open INI editor"}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2a — Guided Custom Rates
// ---------------------------------------------------------------------------

interface RateSliderProps {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  formatValue?: (v: number) => string;
}

function RateSlider({ label, description, value, min, max, step, onChange, formatValue }: RateSliderProps) {
  const display = formatValue ? formatValue(value) : `${value}×`;
  return (
    <div className="space-y-1.5 p-3 rounded-lg" style={{ background: "rgba(10,10,30,0.4)", border: "1px solid rgba(191,0,255,0.12)" }}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{label}</p>
          <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>{description}</p>
        </div>
        <span className="text-sm font-mono font-bold min-w-16 text-right" style={{ color: "var(--neon-purple)" }}>{display}</span>
      </div>
      <Slider min={min} max={max} step={step} value={[value]} onValueChange={([v]) => onChange(v)} />
    </div>
  );
}

function GuidedRatesStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const r = data.guidedRates;
  const set = (k: keyof GuidedRates, v: number | boolean) =>
    onChange({ guidedRates: { ...r, [k]: v } });

  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Tune your server rates. These stack on top of the {data.gameMode === "pvp" ? "PvP" : "PvE"} base settings.
        All values can be changed from the Config tab later.
      </p>
      <div className="space-y-2 max-h-95 overflow-y-auto pr-1">
        <RateSlider label="XP Multiplier" description="How fast players and tames gain experience." value={r.xpMultiplier} min={0.5} max={20} step={0.5} onChange={(v) => set("xpMultiplier", v)} />
        <RateSlider label="Harvest Amount" description="Resource yield per harvest action." value={r.harvestMultiplier} min={0.5} max={20} step={0.5} onChange={(v) => set("harvestMultiplier", v)} />
        <RateSlider label="Taming Speed" description="How quickly taming effectiveness increases." value={r.tamingMultiplier} min={0.5} max={20} step={0.5} onChange={(v) => set("tamingMultiplier", v)} />
        <RateSlider label="Breeding Speed" description="Baby mature speed + egg hatch speed multiplier." value={r.breedingSpeedMultiplier} min={0.5} max={50} step={0.5} onChange={(v) => set("breedingSpeedMultiplier", v)} />
        <RateSlider label="Resource Respawn" description="Lower = faster respawn. 0.5 = twice as fast." value={r.resourceRespawnMultiplier} min={0.05} max={2.0} step={0.05} onChange={(v) => set("resourceRespawnMultiplier", v)} formatValue={(v) => `${v}×`} />
        <RateSlider label="Player Damage" description="Damage output multiplier for players." value={r.playerDamageMultiplier} min={0.5} max={5.0} step={0.1} onChange={(v) => set("playerDamageMultiplier", v)} />
        <RateSlider label="Night Speed" description="Higher = nights pass faster." value={r.nightSpeedMultiplier} min={1.0} max={10} step={0.5} onChange={(v) => set("nightSpeedMultiplier", v)} />

        <div className="flex items-center justify-between p-3 rounded-lg" style={{ background: "rgba(10,10,30,0.4)", border: "1px solid rgba(191,0,255,0.12)" }}>
          <div>
            <p className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Enhance Skill Gains</p>
            <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>Boosts per-level stat gains for players (increases health, stamina, and damage points per level).</p>
          </div>
          <Switch checked={r.enhanceSkillGains} onCheckedChange={(v) => set("enhanceSkillGains", v)} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2b — Full INI Config Editor
// ---------------------------------------------------------------------------

function FullIniStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["session", "admin", "rates"]));

  const toggleGroup = (id: string) =>
    setExpandedGroups((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  // Build an initial GUS from defaults + mode settings if not yet customized
  const gus = useMemo(() => {
    if (Object.keys(data.fullCustomGus).length > 0) return data.fullCustomGus;
    const preset = buildPresetConfig(data.gameMode, "official");
    const result: Record<string, Record<string, string>> = {
      SessionSettings: {
        SessionName: data.name || "My ASA Server",
        ServerPassword: data.serverPassword,
        RCONEnabled: "True",
        RCONPort: String(data.rconPort),
      },
      ServerSettings: {},
    };
    const skip = new Set(["SessionName", "ServerPassword", "QueryPort", "Port", "RCONEnabled", "RCONPort"]);
    for (const [k, v] of Object.entries(preset)) {
      if (!skip.has(k)) result.ServerSettings[k] = String(v);
    }
    result.ServerSettings.ServerAdminPassword = data.adminPassword || "changeme";
    result.ServerSettings.MaxPlayers = String(data.maxPlayers);
    return result;
  }, [data.fullCustomGus, data.gameMode, data.name, data.serverPassword, data.rconPort, data.adminPassword, data.maxPlayers]);

  const getValue = (iniSection: string, key: string): string => {
    return gus[iniSection]?.[key] ?? "";
  };

  const setValue = (iniSection: string, key: string, value: string) => {
    const updated = {
      ...gus,
      [iniSection]: { ...(gus[iniSection] ?? {}), [key]: value },
    };
    onChange({ fullCustomGus: updated });
  };

  // Skip read-only fields (ports/name managed elsewhere)
  const readonlyKeys = new Set(["SessionName", "ServerPassword", "QueryPort", "Port", "RCONEnabled", "RCONPort", "MaxPlayers", "ServerAdminPassword"]);

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs" style={{ background: "rgba(191,0,255,0.06)", border: "1px solid rgba(191,0,255,0.2)" }}>
        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--neon-purple)" }} />
        <p style={{ color: "var(--text-muted)" }}>
          Server name, passwords, and ports are configured on the previous pages and are excluded here.
          All settings here will be written to <code>GameUserSettings.ini</code>.
        </p>
      </div>

      <div className="space-y-2 max-h-95 overflow-y-auto pr-1">
        {INI_FIELD_GROUPS.map((group) => {
          const open = expandedGroups.has(group.id);
          const visibleFields = group.fields.filter(
            (f) => f.section === "gus" && !readonlyKeys.has(f.key)
          );
          if (visibleFields.length === 0) return null;
          return (
            <div key={group.id} className="rounded-lg overflow-hidden" style={{ border: "1px solid rgba(191,0,255,0.15)" }}>
              <button
                onClick={() => toggleGroup(group.id)}
                className="w-full flex items-center justify-between px-4 py-2.5"
                style={{ background: "rgba(10,10,30,0.7)" }}
              >
                <span className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{group.title}</span>
                {open ? <ChevronUp className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} /> : <ChevronDown className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} />}
              </button>
              {open && (
                <div className="p-3 space-y-2.5" style={{ background: "rgba(5,5,20,0.5)" }}>
                  {visibleFields.map((field) => {
                    const val = getValue(field.iniSection, field.key);
                    return (
                      <div key={field.key} className="space-y-1">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs" style={{ color: "var(--text-primary)" }}>{field.label}</Label>
                          {field.description && (
                            <span className="text-[10px]" style={{ color: "var(--text-subtle)" }}>{field.description}</span>
                          )}
                        </div>
                        {field.type === "boolean" ? (
                          <Switch
                            checked={val.toLowerCase() === "true"}
                            onCheckedChange={(v) => setValue(field.iniSection, field.key, v ? "True" : "False")}
                          />
                        ) : (
                          <Input
                            type={field.type === "number" ? "number" : "text"}
                            value={val}
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            placeholder={field.placeholder}
                            onChange={(e) => setValue(field.iniSection, field.key, e.target.value)}
                            className="h-7 text-xs font-mono"
                            style={{
                              background: "rgba(10,10,30,0.8)",
                              borderColor: "rgba(191,0,255,0.2)",
                              color: "var(--text-primary)",
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Network Step
// ---------------------------------------------------------------------------

function NetworkStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const [portStatus, setPortStatus] = useState<Record<string, boolean | null>>({});
  const [checking, setChecking] = useState(false);

  const checkPort = async (portKey: string, port: number) => {
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

  const PortField = ({ label, fieldKey, description }: { label: string; fieldKey: "port" | "queryPort" | "rconPort"; description: string }) => {
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
          type="number" min={1024} max={65535} value={val}
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
        Configure the ports this server will listen on. Each server needs a unique set of three ports.
      </p>
      <PortField label="Game Port" fieldKey="port" description="Clients connect here (UDP). Default: 7777" />
      <PortField label="Query Port" fieldKey="queryPort" description="Steam server browser (UDP). Default: 27015" />
      <PortField label="RCON Port" fieldKey="rconPort" description="Remote console (TCP). Default: 27020" />
      {checking && (
        <p className="text-xs flex items-center gap-1" style={{ color: "var(--text-muted)" }}>
          <Loader2 className="w-3 h-3 animate-spin" /> Checking port availability…
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cluster Step
// ---------------------------------------------------------------------------

function ClusterStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const [clusters, setClusters] = useState<ClusterRow[]>([]);
  const [joinCluster, setJoinCluster] = useState(!!data.clusterId);

  useEffect(() => { getClusters().then(setClusters).catch(() => {}); }, []);

  return (
    <div className="space-y-5">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Clusters allow players to transfer characters and dinos between servers. Optional.
      </p>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Join a Cluster</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Enable cross-server travel</p>
        </div>
        <Switch checked={joinCluster} onCheckedChange={(v) => { setJoinCluster(v); if (!v) onChange({ clusterId: "" }); }} />
      </div>
      {joinCluster && (
        <div className="space-y-2">
          {clusters.length === 0 ? (
            <div className="rounded-lg p-4 text-center" style={{ background: "rgba(191,0,255,0.05)", border: "1px solid rgba(191,0,255,0.15)" }}>
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>No clusters yet. Create one from the Clusters page after setup.</p>
            </div>
          ) : (
            clusters.map((cluster) => (
              <button
                key={cluster.id}
                onClick={() => onChange({ clusterId: cluster.id })}
                className="w-full rounded-lg p-3 text-left transition-all"
                style={{
                  background: data.clusterId === cluster.id ? "rgba(191,0,255,0.1)" : "rgba(10,10,30,0.5)",
                  border: `1px solid ${data.clusterId === cluster.id ? "rgba(191,0,255,0.5)" : "rgba(191,0,255,0.15)"}`,
                }}
              >
                <p className="text-sm font-medium" style={{ color: data.clusterId === cluster.id ? "var(--neon-purple)" : "var(--text-primary)" }}>{cluster.name}</p>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Automation Step
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
      style={{ background: "rgba(10,10,30,0.8)", border: "1px solid rgba(191,0,255,0.3)", color: "var(--text-primary)", outline: "none" }}
    >
      {CRON_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      <option value="custom">Custom…</option>
    </select>
  );
}

function AutomationStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const schedules = [
    { key: "autoUpdate" as const, cronKey: "autoUpdateCron" as const, label: "Auto-Update", desc: "Download and apply ASA server updates automatically" },
    { key: "autoRestart" as const, cronKey: "autoRestartCron" as const, label: "Auto-Restart", desc: "Restart the server on a schedule with an in-game broadcast warning" },
    { key: "autoBackup" as const, cronKey: "autoBackupCron" as const, label: "Auto-Backup", desc: "Create scheduled save-game ZIP backups" },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>Configure automation schedules. All times are in your local timezone.</p>
      {schedules.map(({ key, cronKey, label, desc }) => (
        <div key={key} className="rounded-lg p-4 space-y-3" style={{ background: "rgba(10,10,30,0.5)", border: `1px solid ${data[key] ? "rgba(191,0,255,0.3)" : "rgba(191,0,255,0.12)"}` }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{label}</p>
              <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{desc}</p>
            </div>
            <Switch checked={data[key] as boolean} onCheckedChange={(v) => onChange({ [key]: v })} />
          </div>
          {data[key] && <CronPicker value={data[cronKey] as string} onChange={(v) => onChange({ [cronKey]: v })} />}
        </div>
      ))}
      {data.autoBackup && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label style={{ color: "var(--text-primary)" }}>Keep last N backups</Label>
            <span className="font-mono text-sm" style={{ color: "var(--neon-purple)" }}>{data.backupRetention}</span>
          </div>
          <Slider min={1} max={50} step={1} value={[data.backupRetention]} onValueChange={([v]) => onChange({ backupRetention: v })} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mods Step
// ---------------------------------------------------------------------------

function ModsStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const [input, setInput] = useState("");

  const addMod = () => {
    const id = input.trim();
    if (!id || data.modIds.includes(id)) { setInput(""); return; }
    onChange({ modIds: [...data.modIds, id] });
    setInput("");
  };

  const removeMod = (id: string) => {
    if (data.lockedModIds.includes(id)) return; // cannot remove locked
    onChange({ modIds: data.modIds.filter((m) => m !== id) });
  };

  const selectedMap = getMapById(data.mapId);

  return (
    <div className="space-y-5">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Add CurseForge mods by ID. The full mod browser is available on the Mods tab after creation.
      </p>

      {selectedMap?.isMod && selectedMap.requiredModId && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs" style={{ background: "rgba(0,255,255,0.06)", border: "1px solid rgba(0,255,255,0.2)" }}>
          <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--neon-cyan)" }} />
          <p style={{ color: "var(--neon-cyan)" }}>
            <strong>{selectedMap.displayName}</strong> map mod ({selectedMap.requiredModId}) is locked and will always be loaded.
            To remove it, change the map on the Basic Info step.
          </p>
        </div>
      )}

      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addMod()}
          placeholder="CurseForge mod ID (e.g. 928793)"
          className="font-mono text-sm"
          style={{ background: "rgba(10,10,30,0.8)", borderColor: "rgba(191,0,255,0.3)", color: "var(--text-primary)" }}
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
        <div className="rounded-lg p-4 text-center" style={{ background: "rgba(191,0,255,0.04)", border: "1px dashed rgba(191,0,255,0.2)" }}>
          <Package className="w-8 h-8 mx-auto mb-2" style={{ color: "var(--text-subtle)" }} />
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>No mods added. You can add mods later.</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {data.modIds.map((id, i) => {
            const locked = data.lockedModIds.includes(id);
            return (
              <div
                key={id}
                className="flex items-center justify-between px-3 py-2 rounded-lg"
                style={{
                  background: locked ? "rgba(0,255,255,0.05)" : "rgba(10,10,30,0.6)",
                  border: `1px solid ${locked ? "rgba(0,255,255,0.2)" : "rgba(191,0,255,0.15)"}`,
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: "var(--text-subtle)" }}>#{i + 1}</span>
                  {locked && <Lock className="w-3 h-3" style={{ color: "var(--neon-cyan)" }} />}
                  <span className="text-sm font-mono" style={{ color: locked ? "var(--neon-cyan)" : "var(--text-primary)" }}>{id}</span>
                  {locked && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(0,255,255,0.1)", color: "var(--neon-cyan)", border: "1px solid rgba(0,255,255,0.2)" }}>Map Mod</span>}
                </div>
                {!locked && (
                  <Button
                    variant="ghost" size="sm" onClick={() => removeMod(id)}
                    className="h-6 w-6 p-0" style={{ color: "var(--text-muted)" }}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Install Step
// ---------------------------------------------------------------------------

function InstallStep({
  data,
  serverId,
  steps,
  onInstallComplete,
  onGoToDashboard,
  onStatusChange,
  onCleanupReady,
}: {
  data: WizardData;
  serverId: string;
  steps: StepDef[];
  onInstallComplete: () => void;
  onGoToDashboard: () => void;
  onStatusChange: (status: string) => void;
  onCleanupReady: (fn: () => Promise<void>) => void;
}) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"idle" | "installing" | "done" | "error">("idle");
  const [canceled, setCanceled] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const dbSavedRef = useRef(false);
  const installPathRef = useRef("");
  const steamcmdPathRef = useRef("");
  const cacheDirRef = useRef("");
  const terminalRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const backgroundRef = useRef(false);
  const queryClientRef = useRef(queryClient);

  const scrollToBottom = useCallback(() => {
    sentinelRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  useEffect(() => { onStatusChange(status); }, [status, onStatusChange]);
  useEffect(() => { if (status !== "idle") setTimeout(scrollToBottom, 100); }, [status, scrollToBottom]);
  useEffect(() => {
    if (!terminalRef.current) return;
    const ro = new ResizeObserver(scrollToBottom);
    ro.observe(terminalRef.current);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  const selectedMap = getMapById(data.mapId);
  const presetLabel = (() => {
    const modeLabel = data.gameMode === "pvp" ? "PvP" : "PvE";
    const styleLabel = PRESET_STYLES.find((s) => s.id === data.presetStyle)?.displayName ?? data.presetStyle;
    return `${modeLabel} — ${styleLabel}`;
  })();

  const summaryItems = [
    { label: "Server Name",  value: data.name },
    { label: "Map",          value: selectedMap?.displayName ?? data.mapId },
    { label: "Mode / Style", value: presetLabel },
    { label: "Max Players",  value: String(data.maxPlayers) },
    { label: "Ports",        value: `${data.port} / ${data.queryPort} / ${data.rconPort}` },
    { label: "Auto-Update",  value: data.autoUpdate ? humanCron(data.autoUpdateCron) : "Disabled" },
    { label: "Auto-Restart", value: data.autoRestart ? humanCron(data.autoRestartCron) : "Disabled" },
    { label: "Auto-Backup",  value: data.autoBackup ? `${humanCron(data.autoBackupCron)}, keep ${data.backupRetention}` : "Disabled" },
    { label: "Mods",         value: data.modIds.length > 0 ? `${data.modIds.length} mod(s)` : "None" },
  ];

  /** Build the full GameUserSettings INI sections from wizard data */
  const buildGusJson = (): Record<string, Record<string, string>> => {
    if (data.presetStyle === "full_custom" && Object.keys(data.fullCustomGus).length > 0) {
      const result = { ...data.fullCustomGus };
      if (!result.SessionSettings) result.SessionSettings = {};
      result.SessionSettings.SessionName = data.name;
      result.SessionSettings.ServerPassword = data.serverPassword;
      if (!result.ServerSettings) result.ServerSettings = {};
      result.ServerSettings.ServerAdminPassword = data.adminPassword;
      result.ServerSettings.RCONEnabled = "True";
      result.ServerSettings.RCONPort = String(data.rconPort);
      // MaxPlayers lives in [/Script/Engine.GameSession] in ASA
      if (!result["/Script/Engine.GameSession"]) result["/Script/Engine.GameSession"] = {};
      result["/Script/Engine.GameSession"].MaxPlayers = String(data.maxPlayers);
      return result;
    }

    // Build config from mode + style (or guided custom)
    let config = buildPresetConfig(data.gameMode, data.presetStyle);

    if (data.presetStyle === "guided_custom") {
      const r = data.guidedRates;
      config = {
        ...config,
        XPMultiplier: r.xpMultiplier,
        HarvestAmountMultiplier: r.harvestMultiplier,
        TamingSpeedMultiplier: r.tamingMultiplier,
        EggHatchSpeedMultiplier: r.breedingSpeedMultiplier,
        BabyMatureSpeedMultiplier: r.breedingSpeedMultiplier,
        ResourcesRespawnPeriodMultiplier: r.resourceRespawnMultiplier,
        PlayerDamageMultiplier: r.playerDamageMultiplier,
        NightTimeSpeedScale: r.nightSpeedMultiplier,
      };
    }

    // Keys that go in specific sections or are port/network (handled separately)
    const skipKeys = new Set(["QueryPort", "Port", "MaxPlayers", "SessionName", "ServerPassword", "ServerAdminPassword", "RCONEnabled", "RCONPort"]);

    const sessionSettings: Record<string, string> = {
      SessionName: data.name,
      ServerPassword: data.serverPassword,
    };
    const serverSettings: Record<string, string> = {
      ServerAdminPassword: data.adminPassword,
      RCONEnabled: "True",
      RCONPort: String(data.rconPort),
    };

    for (const [k, v] of Object.entries(config)) {
      if (skipKeys.has(k)) continue;
      serverSettings[k] = String(v);
    }

    return {
      SessionSettings: sessionSettings,
      ServerSettings: serverSettings,
      // ASA reads MaxPlayers from this UE section, not [ServerSettings]
      "/Script/Engine.GameSession": { MaxPlayers: String(data.maxPlayers) },
    };
  };

  const startInstall = async () => {
    backgroundRef.current = false;
    setCanceled(false);
    setAttempt((a) => a + 1);
    setStatus("installing");
    setError("");

    try {
      let installPath: string;
      let steamcmdPath: string;

      if (!dbSavedRef.current) {
        const [baseDir, scmdPath] = await Promise.all([
          getAppSetting("base_dir"),
          getAppSetting("steamcmd_path"),
        ]);

        if (!baseDir) throw new Error("Base directory not configured. Please run Setup first.");
        if (!scmdPath) throw new Error("SteamCMD path not configured. Please run Setup first.");

        const sep = baseDir.includes("\\") ? "\\" : "/";
        installPath = `${baseDir}${sep}servers${sep}${data.name}`;
        steamcmdPath = scmdPath;
        cacheDirRef.current = `${baseDir}${sep}lokiasam${sep}cache${sep}asa-server`;

        // Determine combined preset ID for storage
        const presetId = (data.presetStyle === "guided_custom" || data.presetStyle === "full_custom")
          ? data.presetStyle
          : `${data.gameMode}_${data.presetStyle}`;

        await createServer({
          id: serverId,
          name: data.name,
          mapId: data.mapId,
          installPath,
          port: data.port,
          queryPort: data.queryPort,
          rconPort: data.rconPort,
          rconPassword: data.adminPassword,
          maxPlayers: data.maxPlayers,
          serverPassword: data.serverPassword || undefined,
          adminPassword: data.adminPassword,
          clusterId: data.clusterId || undefined,
          presetId,
        });
        await updateServerStatus(serverId, "installing", null);
        await saveServerConfig(serverId, "{}", "{}", "{}");

        const scheduleEntries = [
          { enabled: data.autoUpdate,  cron: data.autoUpdateCron,  type: "update" },
          { enabled: data.autoRestart, cron: data.autoRestartCron, type: "restart" },
          { enabled: data.autoBackup,  cron: data.autoBackupCron,  type: "backup" },
        ];
        for (const s of scheduleEntries) {
          if (s.enabled) {
            await createSchedule({
              id: generateUUID(), serverId, scheduleType: s.type,
              cronExpression: s.cron, enabled: true,
              configJson: s.type === "backup" ? JSON.stringify({ retention: data.backupRetention }) : "{}",
            });
          }
        }

        installPathRef.current = installPath;
        steamcmdPathRef.current = steamcmdPath;
        dbSavedRef.current = true;

        queryClientRef.current.invalidateQueries({ queryKey: ["servers"] });

        onCleanupReady(async () => {
          if (dbSavedRef.current) {
            await deleteServerRecord(serverId).catch(() => {});
            dbSavedRef.current = false;
          }
          if (installPathRef.current) {
            await tauriCmd.deleteDirectory(installPathRef.current).catch(() => {});
          }
        });
      } else {
        installPath = installPathRef.current;
        steamcmdPath = steamcmdPathRef.current;
      }

      await tauriCmd.installServer(serverId, installPath, cacheDirRef.current, steamcmdPath);

      // Write comprehensive INI from wizard data
      const gusJson = buildGusJson();

      await tauriCmd.writeServerConfig(installPath, {
        gameUserSettings: gusJson,
        gameIni: {},
        launchArgs: {},
      });

      await saveServerConfig(serverId, JSON.stringify(gusJson), "{}", "{}");
      await updateServerStatus(serverId, "stopped", null);
      queryClientRef.current.invalidateQueries({ queryKey: ["servers"] });

      dispatchNotification({
        eventType: NOTIFICATION_EVENTS.SERVER_INSTALL_COMPLETE,
        serverId,
        serverName: data.name,
        title: `${data.name} installed successfully`,
        body: "Server files are ready. You can start the server now.",
        severity: "success",
      });

      if (!backgroundRef.current) setStatus("done");
    } catch (err) {
      const msg = String(err);
      if (msg === "Aborted") {
        if (!backgroundRef.current) { setCanceled(true); setStatus("error"); }
      } else {
        await updateServerStatus(serverId, "install_failed", null).catch(() => {});
        queryClientRef.current.invalidateQueries({ queryKey: ["servers"] });
        dispatchNotification({
          eventType: NOTIFICATION_EVENTS.SERVER_INSTALL_FAILED,
          serverId,
          serverName: data.name,
          title: `${data.name} install failed`,
          body: msg,
          severity: "error",
        });
        if (!backgroundRef.current) { setError(msg); setStatus("error"); }
      }
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--text-primary)" }}>Configuration Summary</h3>
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {summaryItems.map(({ label, value }) => (
            <div key={label} className="flex items-center justify-between px-3 py-1.5 rounded" style={{ background: "rgba(10,10,30,0.5)", border: "1px solid rgba(191,0,255,0.1)" }}>
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
          style={{ background: "rgba(191,0,255,0.15)", border: "1px solid rgba(191,0,255,0.5)", color: "var(--neon-purple)", boxShadow: "0 0 20px rgba(191,0,255,0.15)" }}
        >
          <Download className="w-4 h-4" /> Install Server
        </Button>
      )}

      {(status === "installing" || status === "done" || status === "error") && (
        <div ref={terminalRef}>
          <CommandOutputPanel
            key={attempt}
            eventChannel={`steamcmd://output/${serverId}`}
            label="SteamCMD — Installing ASA Server"
            completed={status === "done" || status === "error"}
            canceled={canceled}
          />
        </div>
      )}

      {status === "installing" && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-purple)" }}>
            <Loader2 className="w-3 h-3 animate-spin" />
            Installation in progress. This may take 15–30 minutes…
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <Button onClick={() => { backgroundRef.current = true; onGoToDashboard(); }} size="sm" variant="ghost" className="gap-1.5 h-7 text-xs" style={{ color: "var(--neon-cyan)", border: "1px solid rgba(0,255,255,0.3)" }}>
              <ArrowRight className="w-3 h-3" /> Continue in Background
            </Button>
            <Button onClick={async () => { await tauriCmd.abortOperation(`server_${serverId}`); }} size="sm" variant="ghost" className="gap-1.5 h-7 text-xs" style={{ color: "var(--neon-red)", border: "1px solid rgba(255,0,85,0.3)" }}>
              <StopCircle className="w-3 h-3" /> Cancel Install
            </Button>
          </div>
        </div>
      )}

      {status === "done" && (
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-2" style={{ color: "var(--neon-green)" }}>
            <CheckCircle2 className="w-5 h-5" />
            <span className="text-sm font-semibold">Server installed successfully!</span>
          </div>
          <Button onClick={onInstallComplete} className="gap-2" style={{ background: "rgba(0,255,136,0.1)", border: "1px solid rgba(0,255,136,0.4)", color: "var(--neon-green)" }}>
            Go to Dashboard <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      )}

      {status === "error" && (
        <div className="space-y-2">
          {!canceled && (
            <p className="text-xs flex items-start gap-1.5" style={{ color: "var(--neon-red)" }}>
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
            </p>
          )}
          <Button onClick={startInstall} variant="outline" size="sm" className="gap-1" style={{ borderColor: "rgba(191,0,255,0.4)", color: "var(--neon-purple)" }}>
            <RefreshCw className="w-3 h-3" /> Retry Install
          </Button>
        </div>
      )}

      <div ref={sentinelRef} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main ServerCreationWizard
// ---------------------------------------------------------------------------

interface ServerCreationWizardProps {
  onClose: () => void;
}

export function ServerCreationWizard({ onClose }: ServerCreationWizardProps) {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [data, setData] = useState<WizardData>(DEFAULT_DATA);
  const [serverId] = useState(() => generateUUID());
  const [nameValid, setNameValid] = useState(false);
  const [installStatus, setInstallStatus] = useState("idle");
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const cleanupFnRef = useRef<(() => Promise<void>) | null>(null);

  const steps = useMemo(() => computeSteps(data), [data.presetStyle]);
  const currentStepDef = steps[step];
  const isInstallStep = currentStepDef?.id === "install";

  const onChange = useCallback((patch: Partial<WizardData>) => {
    setData((prev) => {
      const next = { ...prev, ...patch };
      // If presetStyle changes away from guided/full, reset to first available step after style
      return next;
    });
  }, []);

  // When presetStyle changes, clamp step to avoid being past the new step count
  useEffect(() => {
    const newSteps = computeSteps(data);
    if (step >= newSteps.length) setStep(newSteps.length - 1);
  }, [data.presetStyle]);

  const canAdvance = (): boolean => {
    if (!currentStepDef) return false;
    switch (currentStepDef.id) {
      case "basic":    return !!data.name.trim() && !!data.adminPassword.trim() && nameValid;
      case "gamemode": return !!data.gameMode;
      case "style":    return !!data.presetStyle;
      default:         return true;
    }
  };

  const next = () => { setDirection(1); setStep((s) => Math.min(s + 1, steps.length - 1)); };
  const prev = () => { setDirection(-1); setStep((s) => Math.max(s - 1, 0)); };

  const handleClose = () => {
    if (isInstallStep && installStatus === "error") { setShowCancelConfirm(true); return; }
    onClose();
  };

  const handleConfirmCancel = async () => {
    setShowCancelConfirm(false);
    await cleanupFnRef.current?.().catch(() => {});
    onClose();
  };

  const renderStep = () => {
    if (!currentStepDef) return null;
    switch (currentStepDef.id) {
      case "basic":      return <BasicInfoStep data={data} onChange={onChange} onNameValidated={setNameValid} />;
      case "gamemode":   return <GameModeStep data={data} onChange={onChange} />;
      case "style":      return <StyleStep data={data} onChange={onChange} />;
      case "guided":     return <GuidedRatesStep data={data} onChange={onChange} />;
      case "full_ini":   return <FullIniStep data={data} onChange={onChange} />;
      case "network":    return <NetworkStep data={data} onChange={onChange} />;
      case "cluster":    return <ClusterStep data={data} onChange={onChange} />;
      case "automation": return <AutomationStep data={data} onChange={onChange} />;
      case "mods":       return <ModsStep data={data} onChange={onChange} />;
      case "install":    return (
        <InstallStep
          data={data}
          serverId={serverId}
          steps={steps}
          onInstallComplete={onClose}
          onGoToDashboard={onClose}
          onStatusChange={setInstallStatus}
          onCleanupReady={(fn) => { cleanupFnRef.current = fn; }}
        />
      );
      default: return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "var(--background)" }}>
      {/* Background gradient */}
      <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: "radial-gradient(ellipse 80% 50% at 50% -20%, rgba(191,0,255,0.08) 0%, transparent 60%)" }} />

      {/* Top bar */}
      <div className="relative z-10 flex items-center justify-between px-6 py-3 border-b shrink-0" style={{ borderColor: "rgba(191,0,255,0.15)", background: "rgba(5,5,20,0.8)" }}>
        <div className="flex items-center gap-2">
          <LokiIcon size={16} style={{ filter: "drop-shadow(0 0 4px var(--neon-purple))" }} />
          <span className="text-sm font-semibold text-glow-purple" style={{ color: "var(--neon-purple)" }}>New Server</span>
        </div>
        <Button variant="ghost" size="sm" onClick={handleClose} className="h-8 w-8 p-0" style={{ color: "var(--text-muted)" }} title="Close">
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="relative z-10 flex-1 overflow-hidden p-6">
        <div className="flex h-full gap-6">
          {/* Left sidebar */}
          <div
            className="w-52 shrink-0 rounded-xl p-4 flex flex-col gap-1 self-stretch"
            style={{ background: "rgba(10,10,30,0.7)", border: "1px solid rgba(191,0,255,0.15)", backdropFilter: "blur(12px)" }}
          >
            <p className="text-xs font-semibold mb-3 px-1" style={{ color: "var(--text-muted)" }}>NEW SERVER</p>
            {steps.map((s, i) => {
              const done = i < step;
              const active = i === step;
              const Icon = s.icon;
              return (
                <div
                  key={s.id}
                  className={cn("flex items-center gap-3 px-3 py-2 rounded-lg transition-all", active && "bg-[rgba(191,0,255,0.1)]", done && "opacity-70")}
                  style={{ border: active ? "1px solid rgba(191,0,255,0.4)" : "1px solid transparent" }}
                >
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                    style={{
                      background: done ? "rgba(0,255,136,0.15)" : active ? "rgba(191,0,255,0.2)" : "rgba(191,0,255,0.05)",
                      border: `1px solid ${done ? "rgba(0,255,136,0.4)" : active ? "rgba(191,0,255,0.5)" : "rgba(191,0,255,0.15)"}`,
                      color: done ? "var(--neon-green)" : active ? "var(--neon-purple)" : "var(--text-subtle)",
                    }}
                  >
                    {done ? "✓" : i + 1}
                  </div>
                  <span className="text-xs truncate" style={{ color: active ? "var(--neon-purple)" : done ? "var(--text-primary)" : "var(--text-muted)" }}>
                    {s.label}
                  </span>
                  {active && <ChevronRight className="w-3 h-3 ml-auto shrink-0" style={{ color: "var(--neon-purple)" }} />}
                </div>
              );
            })}
          </div>

          {/* Main content */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="mb-6">
              <h1 className="text-2xl font-bold text-glow-purple" style={{ color: "var(--neon-purple)" }}>
                {currentStepDef?.label}
              </h1>
              <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
                Step {step + 1} of {steps.length}
              </p>
            </div>

            <div
              className="flex-1 rounded-xl p-6 overflow-y-auto"
              style={{ background: "rgba(10,10,30,0.6)", border: "1px solid rgba(191,0,255,0.15)", backdropFilter: "blur(12px)" }}
            >
              <AnimatePresence mode="wait" custom={direction}>
                <motion.div
                  key={`${step}-${currentStepDef?.id}`}
                  custom={direction}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.2, ease: "easeInOut" }}
                >
                  {renderStep()}
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Navigation */}
            {!isInstallStep && (
              <div className="flex items-center justify-between mt-4">
                <Button variant="ghost" onClick={prev} disabled={step === 0} className="gap-2" style={{ color: "var(--text-muted)" }}>
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
                  {step === steps.length - 2 ? "Review & Install" : "Next"}
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Cancel confirmation overlay */}
      {showCancelConfirm && (
        <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)" }}>
          <div className="rounded-xl p-6 max-w-sm w-full mx-4 flex flex-col gap-4" style={{ background: "rgba(8,8,25,0.98)", border: "1px solid rgba(255,0,85,0.35)", boxShadow: "0 8px 32px rgba(0,0,0,0.7)" }}>
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "var(--neon-red)" }} />
              <div>
                <p className="text-sm font-semibold mb-1" style={{ color: "var(--text-primary)" }}>Cancel Server Setup?</p>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>The server record and any partially downloaded files will be permanently deleted.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <Button onClick={handleConfirmCancel} className="flex-1 text-sm" style={{ background: "rgba(255,0,85,0.1)", border: "1px solid rgba(255,0,85,0.4)", color: "var(--neon-red)" }}>
                Yes, Cancel
              </Button>
              <Button onClick={() => setShowCancelConfirm(false)} className="flex-1 text-sm" style={{ background: "rgba(191,0,255,0.08)", border: "1px solid rgba(191,0,255,0.3)", color: "var(--neon-purple)" }}>
                Keep Going
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
