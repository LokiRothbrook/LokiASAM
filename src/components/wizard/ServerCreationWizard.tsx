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
  Sword, Sliders, Settings2, Code2, Globe, Lock,
  ChevronDown, ChevronUp, ToggleLeft, ToggleRight, Terminal,
  Shield, Info, Heart, AlertTriangle, HelpCircle, Eye, EyeOff,
  HardDrive, Skull, RotateCcw, MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { CommandOutputPanel } from "@/components/shared/CommandOutputPanel";
import { NumberField } from "@/components/shared/NumberField";
import { LokiIcon } from "@/components/shared/LokiIcon";
import { useAllMaps } from "@/hooks/useAllMaps";
import {
  GAME_MODES, PRESET_STYLES, INI_FIELD_GROUPS, buildPresetConfig,
  LAUNCH_PARAMETERS, NOTIFICATION_EVENTS, ARK_EVENTS,
  type ArkMap, type GameModeConfig, type PresetStyle, type LaunchParameter, type ArkEvent,
} from "@/data/game-data";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { dispatchNotification } from "@/lib/notifications";
import {
  getAppSetting, setAppSetting, createServer, deleteServerRecord, saveServerConfig,
  createSchedule, updateScheduleConfig, getClusters, isServerNameTaken, updateServerStatus,
  addServerMod, getServers, getServerMods, createClusterRecord,
  updateBackupBroadcastMessage, getServerConfig, setServerActiveEvent,
  type ClusterRow,
} from "@/lib/db";
import { getNextCronDate } from "@/components/shared/CronBuilder";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useOnMount } from "@/hooks/useOnMount";
import { tauriCmd, type PortDef, type FirewallStatus } from "@/lib/tauri-commands";
import { getServerFirewallPorts } from "@/lib/firewall-utils";
import { useAppStore } from "@/store/useAppStore";
import { cn } from "@/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Wizard data model
// ---------------------------------------------------------------------------

interface GuidedRates {
  // Core Rates (page 1)
  xpMultiplier: number;
  harvestMultiplier: number;
  harvestHealthMultiplier: number;
  tamingMultiplier: number;
  wildDinoMaxLevel: number;
  resourceRespawnMultiplier: number;
  nightSpeedMultiplier: number;
  // Breeding (page 2)
  matureSpeedMultiplier: number;
  hatchSpeedMultiplier: number;
  foodConsumptionMultiplier: number;
  matingIntervalMultiplier: number;
  matingSpeedMultiplier: number;
  cuddleIntervalMultiplier: number;
  cuddleGraceMultiplier: number;
  imprintAmountMultiplier: number;
  // Combat (page 3)
  playerDamageMultiplier: number;
  playerResistanceMultiplier: number;
  dinoDamageMultiplier: number;
  dinoResistanceMultiplier: number;
  tamedDinoDamageMultiplier: number;
  tamedDinoResistanceMultiplier: number;
  structureDamageMultiplier: number;
  structureResistanceMultiplier: number;
  enableRespawnPenalty: boolean;
  enableTurretLimits: boolean;
  // Server QoL (page 4)
  allowFlyingStaminaRecovery: boolean;
  allowSpeedLeveling: boolean;
  allowFlyerSpeedLeveling: boolean;
  allowUnlimitedRespecs: boolean;
  enhanceSkillGains: boolean;
  globalSpoilingTimeMultiplier: number;
  globalItemDecompMultiplier: number;
  globalCorpseDecompMultiplier: number;
  enableORP: boolean;
  orpInterval: number;
  disableStructureDecay: boolean;
  disableDinoDecay: boolean;
}

interface WizardData {
  // Step 0 — Basic Info
  name: string;
  mapId: string;
  maxPlayers: number;
  serverPassword: string;
  serverPasswordConfirm: string;
  adminPassword: string;
  adminPasswordConfirm: string;
  motdMessage: string;
  motdDuration: number;
  // Step 0 — Event
  activeEventId: string;
  // Step 1 — Game Mode
  gameMode: "pvp" | "pve";
  // Game Mode — General (both PvP & PvE)
  adminLogging: boolean;
  serverCrosshair: boolean;
  showDamageNumbers: boolean;
  showPlayerLocation: boolean;
  forceAllStructureLocking: boolean;
  alwaysAllowStructurePickup: boolean;
  disableStructurePlacementCollision: boolean;
  // Game Mode — PvE specific
  flyerCarryPvE: boolean;
  allowCaveBuildingPvE: boolean;
  pveAllowStructuresAtSupplyDrops: boolean;
  allowCrateSpawnsOnTopOfStructures: boolean;
  disableStructureDecayPvE: boolean;
  disableDinoDecayPvE: boolean;
  // Game Mode — PvP specific
  pvpFriendlyFire: boolean;
  preventOfflinePvP: boolean;
  preventOfflinePvPInterval: number;
  // Copy from server
  copyFromServerId: string;
  // Step 2 — Style
  presetStyle: "official" | "casual" | "boosted" | "guided_custom" | "full_custom";
  // Step 2a — Guided Custom rates
  guidedRates: GuidedRates;
  // Step 2b — Full Custom INI (raw section maps)
  fullCustomGus: Record<string, Record<string, string>>;
  fullCustomGameIni: Record<string, Record<string, string>>;
  // Launch parameters (CLI args)
  launchArgs: Record<string, string>;
  // Network
  port: number;
  queryPort: number;
  rconPort: number;
  // Cluster
  clusterId: string;
  // Automation — restart
  autoRestart: boolean;
  autoRestartCron: string;
  autoRestartWarnPlayers: boolean;
  autoRestartWarnMinutes: number;
  autoRestartMessage: string;
  // Automation — backup tiers (TimeShift)
  serverBackupTiers: Record<"H"|"D"|"W"|"M", { enabled: boolean; keep: number }>;
  playerBackupTiers: Record<"H"|"D"|"W"|"M", { enabled: boolean; keep: number }>;
  fullBackupEnabled: boolean;
  fullBackupKeep: number;
  loginBackupEnabled: boolean;
  loginBackupKeep: number;
  manualBackupKeep: number;
  backupBroadcastMessage: string;
  // Automation — wild dino wipe
  wipeDinosEnabled: boolean;
  wipeDinosCron: string;
  // Mods — lockedModIds are auto-added from map selection and cannot be removed
  modIds: string[];
  lockedModIds: string[];
  // Names resolved from the mod browser (id → display name). Only populated when
  // a mod was added via the browser; manually-typed IDs default to "Unknown Mod".
  modNames: Record<string, string>;
}

const DEFAULT_GUIDED_RATES: GuidedRates = {
  // Core Rates
  xpMultiplier: 2.0,
  harvestMultiplier: 2.0,
  harvestHealthMultiplier: 2.0,
  tamingMultiplier: 5.0,
  wildDinoMaxLevel: 150,
  resourceRespawnMultiplier: 0.5,
  nightSpeedMultiplier: 2.0,
  // Breeding
  matureSpeedMultiplier: 10.0,
  hatchSpeedMultiplier: 10.0,
  foodConsumptionMultiplier: 5.0,
  matingIntervalMultiplier: 0.25,
  matingSpeedMultiplier: 2.0,
  cuddleIntervalMultiplier: 0.3,
  cuddleGraceMultiplier: 2.0,
  imprintAmountMultiplier: 2.0,
  // Combat
  playerDamageMultiplier: 1.0,
  playerResistanceMultiplier: 1.0,
  dinoDamageMultiplier: 1.0,
  dinoResistanceMultiplier: 1.0,
  tamedDinoDamageMultiplier: 1.0,
  tamedDinoResistanceMultiplier: 1.0,
  structureDamageMultiplier: 1.0,
  structureResistanceMultiplier: 1.0,
  enableRespawnPenalty: true,
  enableTurretLimits: true,
  // QoL
  allowFlyingStaminaRecovery: true,
  allowSpeedLeveling: false,
  allowFlyerSpeedLeveling: false,
  allowUnlimitedRespecs: false,
  enhanceSkillGains: false,
  globalSpoilingTimeMultiplier: 2.0,
  globalItemDecompMultiplier: 2.0,
  globalCorpseDecompMultiplier: 2.0,
  enableORP: true,
  orpInterval: 900,
  disableStructureDecay: true,
  disableDinoDecay: true,
};

const DEFAULT_DATA: WizardData = {
  name: "",
  mapId: "theisland",
  maxPlayers: 70,
  serverPassword: "",
  serverPasswordConfirm: "",
  adminPassword: "",
  adminPasswordConfirm: "",
  activeEventId: "",
  gameMode: "pve",
  adminLogging: true,
  serverCrosshair: true,
  showDamageNumbers: true,
  showPlayerLocation: true,
  forceAllStructureLocking: true,
  alwaysAllowStructurePickup: true,
  disableStructurePlacementCollision: false,
  flyerCarryPvE: false,
  allowCaveBuildingPvE: false,
  pveAllowStructuresAtSupplyDrops: true,
  allowCrateSpawnsOnTopOfStructures: true,
  disableStructureDecayPvE: false,
  disableDinoDecayPvE: false,
  pvpFriendlyFire: true,
  preventOfflinePvP: false,
  preventOfflinePvPInterval: 900,
  copyFromServerId: "",
  presetStyle: "casual",
  guidedRates: DEFAULT_GUIDED_RATES,
  fullCustomGus: {},
  fullCustomGameIni: {},
  launchArgs: { NoBattlEye: "true", servergamelog: "true" },
  port: 7777,
  queryPort: 27015,
  rconPort: 27020,
  clusterId: "",
  autoRestart: true,
  autoRestartCron: "0 6 * * *",
  autoRestartWarnPlayers: true,
  autoRestartWarnMinutes: 15,
  autoRestartMessage: "Server restarting in {minutes} minutes. Progress will be saved.",
  serverBackupTiers: {
    H: { enabled: false, keep: 24 },
    D: { enabled: true,  keep: 7  },
    W: { enabled: false, keep: 4  },
    M: { enabled: false, keep: 3  },
  },
  playerBackupTiers: {
    H: { enabled: false, keep: 24 },
    D: { enabled: false, keep: 7  },
    W: { enabled: false, keep: 4  },
    M: { enabled: false, keep: 3  },
  },
  fullBackupEnabled: false,
  fullBackupKeep: 3,
  loginBackupEnabled: false,
  loginBackupKeep: 3,
  manualBackupKeep: 5,
  backupBroadcastMessage: "Server backup in progress — lag may occur.",
  wipeDinosEnabled: false,
  wipeDinosCron: "0 6 * * *",
  modIds: [],
  lockedModIds: [],
  modNames: {},
  motdMessage: "",
  motdDuration: 20,
};

// ---------------------------------------------------------------------------
// Dynamic step definitions
// ---------------------------------------------------------------------------

interface StepDef {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}

function computeSteps(presetStyle: WizardData["presetStyle"], copyFromServerId: WizardData["copyFromServerId"]): StepDef[] {
  const steps: StepDef[] = [
    { id: "basic",    label: "Basic Info",  icon: Server },
    { id: "gamemode", label: "Game Mode",   icon: Sword },
  ];

  if (!copyFromServerId) {
    steps.push({ id: "style", label: "Server Style", icon: Sliders });
    if (presetStyle === "guided_custom") {
      steps.push({ id: "guided_rates",    label: "Core Rates", icon: Sliders });
      steps.push({ id: "guided_breeding", label: "Breeding",   icon: Heart });
      steps.push({ id: "guided_combat",   label: "Combat",     icon: Sword });
      steps.push({ id: "guided_behavior", label: "Server QoL", icon: Settings2 });
    }
    if (presetStyle === "full_custom") {
      steps.push({ id: "full_ini", label: "INI Config", icon: Code2 });
    }
  }

  steps.push(
    { id: "network",    label: "Network",    icon: Network },
    { id: "cluster",    label: "Cluster",    icon: GitBranch },
    { id: "automation", label: "Automation", icon: Clock },
  );

  if (!copyFromServerId) {
    steps.push({ id: "launch", label: "Launch Args", icon: Terminal });
  }

  steps.push(
    { id: "mods",     label: "Mods",     icon: Package },
    { id: "firewall", label: "Firewall", icon: Shield },
    { id: "install",  label: "Install",  icon: Download },
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
  const allMaps      = useAllMaps();
  const officialMaps = allMaps.filter((m) => m.released && !m.isMod);
  const modMaps      = allMaps.filter((m) => m.released && m.isMod);
  const [nameError, setNameError] = useState("");
  const [checkingName, setCheckingName] = useState(false);
  const [nameChecked, setNameChecked] = useState(false);
  const [mapMenuOpen, setMapMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const nameDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameReqIdRef = useRef(0);
  const [showAdminPw,      setShowAdminPw]      = useState(false);
  const [showAdminConfirm, setShowAdminConfirm] = useState(false);
  const [showServerPw,     setShowServerPw]     = useState(false);
  const [showServerConfirm,setShowServerConfirm]= useState(false);

  const selectedMap = allMaps.find((m) => m.id === data.mapId);

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
    // Debounce only prevents overlapping *scheduled* checks — a slow
    // in-flight request for an older name could still resolve after a newer
    // one. Drop the result if a newer check has started since.
    const reqId = ++nameReqIdRef.current;
    setCheckingName(true);
    try {
      const taken = await isServerNameTaken(name.trim());
      if (reqId !== nameReqIdRef.current) return;
      setNameError(taken ? "A server with this name already exists." : "");
      setNameChecked(true);
      onNameValidated(!taken);
    } catch {
      if (reqId !== nameReqIdRef.current) return;
      setNameError("");
      setNameChecked(true);
      onNameValidated(true);
    } finally {
      if (reqId === nameReqIdRef.current) setCheckingName(false);
    }
  }, [onNameValidated]);

  const handleMapSelect = (map: ArkMap) => {
    const patch: Partial<WizardData> = { mapId: map.id };

    // Start from whatever mods are currently selected, minus the previous
    // map's required mod if it had one and it isn't also the new map's
    // required mod — this used to only run in the "switching to a non-mod
    // map" branch below, so mod-map → mod-map left the old map's mod
    // installed and unlocked in the final server.
    let modIds = data.modIds;
    if (selectedMap?.isMod && selectedMap.requiredModId && selectedMap.requiredModId !== map.requiredModId) {
      modIds = modIds.filter((id) => id !== selectedMap.requiredModId);
    }

    if (map.isMod && map.requiredModId) {
      // Auto-add the required mod and lock it
      patch.modIds = modIds.includes(map.requiredModId) ? modIds : [...modIds, map.requiredModId];
      patch.lockedModIds = [map.requiredModId];
    } else {
      patch.modIds = modIds;
      patch.lockedModIds = [];
    }
    onChange(patch);
    setMapMenuOpen(false);
  };

  const MapOption = ({ map }: { map: ArkMap }) => {
    const active = data.mapId === map.id;
    return (
      <button
        onClick={() => handleMapSelect(map)}
        className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-all hover:bg-[rgba(var(--neon-purple-rgb),0.08)]"
        style={{
          background: active ? "rgba(var(--neon-purple-rgb),0.12)" : "transparent",
        }}
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm truncate" style={{ color: active ? "var(--neon-purple)" : "var(--text-primary)" }}>
            {map.displayName}
            {map.isMod && (
              <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(var(--neon-purple-rgb),0.1)", color: "var(--neon-cyan)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
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
          onChange={(e) => {
            const val = e.target.value;
            onChange({ name: val });
            onNameValidated(false);
            setNameChecked(false);
            if (nameDebounce.current) clearTimeout(nameDebounce.current);
            nameDebounce.current = setTimeout(() => checkName(val), 600);
          }}
          onBlur={(e) => {
            if (nameDebounce.current) clearTimeout(nameDebounce.current);
            checkName(e.target.value);
          }}
          placeholder="My ASA Server"
          style={{
            background: "var(--surface)",
            borderColor: nameError ? "var(--neon-red)" : "rgba(var(--neon-purple-rgb),0.3)",
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
              background: "var(--surface)",
              border: "1px solid rgba(var(--neon-purple-rgb),0.3)",
              color: "var(--text-primary)",
            }}
          >
            <span className="flex items-center gap-2 text-sm">
              {selectedMap?.displayName ?? "Select a map…"}
              {selectedMap?.isMod && (
                <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(var(--neon-purple-rgb),0.1)", color: "var(--neon-cyan)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>MOD</span>
              )}
              {selectedMap?.dlcRequired && (
                <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(var(--neon-purple-rgb),0.1)", color: "var(--neon-purple)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>DLC</span>
              )}
            </span>
            <ChevronDown className="w-4 h-4 shrink-0" style={{ color: "var(--text-muted)" }} />
          </button>

          {mapMenuOpen && (
            <div
              className="absolute top-full left-0 right-0 z-50 mt-1 rounded-lg overflow-hidden"
              style={{
                background: "var(--popover)",
                border: "1px solid rgba(var(--neon-purple-rgb),0.3)",
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
                    <div className="my-2 border-t" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.12)" }} />
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
            style={{ background: "rgba(var(--neon-purple-rgb),0.06)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}
          >
            <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--neon-cyan)" }} />
            <p style={{ color: "var(--neon-cyan)" }}>
              Mod map selected — mod <strong>{selectedMap.requiredModId}</strong> will be automatically added and locked to your mod list.
            </p>
          </div>
        )}
      </div>

      {/* Custom mod maps hint */}
      <div
        className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
        style={{ background: "rgba(var(--neon-purple-rgb),0.04)", border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}
      >
        <p style={{ color: "var(--text-muted)" }}>
          Don&apos;t see your mod map? Add it first from the{" "}
          <strong style={{ color: "var(--neon-purple)" }}>Mod Maps</strong> page (sidebar), then come back and it will appear in the list above.
        </p>
      </div>

      {/* Active Event */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Label style={{ color: "var(--text-primary)" }}>
            Active Event <span style={{ color: "var(--text-muted)" }}>(optional)</span>
          </Label>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="w-3 h-3 cursor-help" style={{ color: "var(--neon-purple)" }} />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs leading-snug">
                Activates a seasonal event on the server. The required event mod is automatically downloaded and enabled when the server starts — you don&apos;t need to add it to the mod list manually.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <select
          value={data.activeEventId}
          onChange={(e) => onChange({ activeEventId: e.target.value })}
          className="w-full text-sm rounded-lg px-3 py-2"
          style={{
            background: "var(--surface)",
            border: "1px solid rgba(var(--neon-purple-rgb),0.3)",
            color: "var(--text-primary)",
            outline: "none",
          }}
        >
          <option value="">No active event</option>
          {ARK_EVENTS.map((ev: ArkEvent) => (
            <option key={ev.id} value={ev.id}>{ev.displayName}</option>
          ))}
        </select>
        {data.activeEventId && (() => {
          const ev = ARK_EVENTS.find((e) => e.id === data.activeEventId);
          return ev ? (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
              style={{ background: "rgba(var(--neon-purple-rgb),0.06)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--neon-purple)" }} />
              <div>
                <p style={{ color: "var(--text-primary)" }}>{ev.description}</p>
                <p className="mt-0.5" style={{ color: "var(--text-muted)" }}>Event mod ID: {ev.modId} (auto-managed)</p>
              </div>
            </div>
          ) : null;
        })()}
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
      {(() => {
        const adminMismatch = !!data.adminPassword && data.adminPassword !== data.adminPasswordConfirm;
        const serverMismatch = !!data.serverPassword && data.serverPassword !== data.serverPasswordConfirm;
        const fieldStyle = (hasValue: boolean, mismatch: boolean) => ({
          background: "var(--surface)",
          borderColor: mismatch ? "var(--neon-red)" : !hasValue ? "rgba(255,0,85,0.5)" : "rgba(var(--neon-purple-rgb),0.3)",
          color: "var(--text-primary)",
        });
        return (
          <div className="space-y-3">
            {/* Admin password */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label style={{ color: "var(--text-primary)" }}>Admin Password <span style={{ color: "var(--neon-red)" }}>*</span></Label>
                <div className="relative">
                  <Input
                    type={showAdminPw ? "text" : "password"}
                    value={data.adminPassword}
                    onChange={(e) => onChange({ adminPassword: e.target.value })}
                    placeholder="Required"
                    className="pr-8"
                    style={fieldStyle(!!data.adminPassword, false)}
                  />
                  <button type="button" tabIndex={-1} onClick={() => setShowAdminPw(v => !v)}
                    className="absolute inset-y-0 right-0 flex items-center pr-2.5 opacity-50 hover:opacity-90 transition-opacity"
                    style={{ color: "var(--text-primary)" }}>
                    {showAdminPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label style={{ color: "var(--text-primary)" }}>Confirm Admin Password <span style={{ color: "var(--neon-red)" }}>*</span></Label>
                <div className="relative">
                  <Input
                    type={showAdminConfirm ? "text" : "password"}
                    value={data.adminPasswordConfirm}
                    onChange={(e) => onChange({ adminPasswordConfirm: e.target.value })}
                    placeholder="Re-enter password"
                    className="pr-8"
                    style={fieldStyle(!!data.adminPasswordConfirm, adminMismatch)}
                  />
                  <button type="button" tabIndex={-1} onClick={() => setShowAdminConfirm(v => !v)}
                    className="absolute inset-y-0 right-0 flex items-center pr-2.5 opacity-50 hover:opacity-90 transition-opacity"
                    style={{ color: "var(--text-primary)" }}>
                    {showAdminConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {adminMismatch && (
                  <p className="text-xs" style={{ color: "var(--neon-red)" }}>Passwords do not match</p>
                )}
              </div>
            </div>

            {/* Server password */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label style={{ color: "var(--text-primary)" }}>Server Password <span style={{ color: "var(--text-muted)" }}>(optional)</span></Label>
                <div className="relative">
                  <Input
                    type={showServerPw ? "text" : "password"}
                    value={data.serverPassword}
                    onChange={(e) => onChange({ serverPassword: e.target.value })}
                    placeholder="Leave blank for public"
                    className="pr-8"
                    style={fieldStyle(true, false)}
                  />
                  <button type="button" tabIndex={-1} onClick={() => setShowServerPw(v => !v)}
                    className="absolute inset-y-0 right-0 flex items-center pr-2.5 opacity-50 hover:opacity-90 transition-opacity"
                    style={{ color: "var(--text-primary)" }}>
                    {showServerPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label style={{ color: "var(--text-primary)" }}>Confirm Server Password</Label>
                <div className="relative">
                  <Input
                    type={showServerConfirm ? "text" : "password"}
                    value={data.serverPasswordConfirm}
                    onChange={(e) => onChange({ serverPasswordConfirm: e.target.value })}
                    placeholder={data.serverPassword ? "Re-enter password" : "—"}
                    disabled={!data.serverPassword}
                    className="pr-8"
                    style={fieldStyle(true, serverMismatch)}
                  />
                  {data.serverPassword && (
                    <button type="button" tabIndex={-1} onClick={() => setShowServerConfirm(v => !v)}
                      className="absolute inset-y-0 right-0 flex items-center pr-2.5 opacity-50 hover:opacity-90 transition-opacity"
                      style={{ color: "var(--text-primary)" }}>
                      {showServerConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  )}
                </div>
                {serverMismatch && (
                  <p className="text-xs" style={{ color: "var(--neon-red)" }}>Passwords do not match</p>
                )}
              </div>
            </div>

            {/* Message of the Day */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label style={{ color: "var(--text-primary)" }}>
                  Message of the Day <span style={{ color: "var(--text-muted)" }}>(optional)</span>
                </Label>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="w-3 h-3 cursor-help" style={{ color: "var(--neon-purple)" }} />
                    </TooltipTrigger>
                    <TooltipContent>Shown to players in a pop-up when they join. Leave blank to disable. Use \n for line breaks.</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <textarea
                value={data.motdMessage}
                onChange={(e) => onChange({ motdMessage: e.target.value })}
                placeholder={"Welcome to the server!\nUse \\n for line breaks."}
                rows={3}
                className="w-full text-sm rounded px-3 py-2 resize-none"
                style={{
                  background: "var(--surface)",
                  border: "1px solid rgba(var(--neon-purple-rgb),0.3)",
                  color: "var(--text-primary)",
                  outline: "none",
                  fontFamily: "inherit",
                }}
              />
              {data.motdMessage.trim() && (
                <div className="flex items-center gap-3">
                  <Label className="text-xs shrink-0" style={{ color: "var(--text-muted)" }}>Display for</Label>
                  <div className="flex-1">
                    <NumberField
                      value={data.motdDuration}
                      onChange={(v) => onChange({ motdDuration: v })}
                      min={1}
                      max={120}
                      step={1}
                      defaultValue={20}
                    />
                  </div>
                  <span className="text-xs shrink-0" style={{ color: "var(--text-muted)" }}>seconds</span>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Game Mode
// ---------------------------------------------------------------------------

function GameModeToggle({ label, description, value, onChange: onChangeFn, warn }: {
  label: string; description: string; value: boolean;
  onChange: (v: boolean) => void; warn?: boolean;
}) {
  const color = warn ? "rgba(255,140,0,0.06)" : "rgba(var(--neon-purple-rgb),0.04)";
  const border = warn ? "rgba(255,140,0,0.15)" : "rgba(var(--neon-purple-rgb),0.12)";
  const accent = warn ? "var(--neon-orange, #ff8c00)" : "var(--neon-purple)";
  return (
    <div className="flex items-center justify-between px-2 py-2 rounded-lg gap-3"
      style={{ background: color, border: `1px solid ${border}` }}>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-sm" style={{ color: "var(--text-primary)" }}>{label}</span>
        <TooltipProvider><Tooltip><TooltipTrigger asChild>
          <HelpCircle className="w-3 h-3 cursor-help shrink-0" style={{ color: accent }} />
        </TooltipTrigger><TooltipContent className="max-w-xs text-xs leading-snug">{description}</TooltipContent></Tooltip></TooltipProvider>
      </div>
      <button type="button" onClick={() => onChangeFn(!value)} className="shrink-0">
        {value
          ? <ToggleRight className="w-8 h-8" style={{ color: accent }} />
          : <ToggleLeft  className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />}
      </button>
    </div>
  );
}

function GameModeStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  // Shared ["servers"] cache — dedupes with other steps' getServers() reads
  // (and the rest of the app) within React Query's staleTime window instead
  // of each mounting step re-fetching independently.
  const { data: existingServers = [] } = useQuery({ queryKey: ["servers"], queryFn: getServers });
  const [loadingCopy, setLoadingCopy] = useState(false);
  const allMaps = useAllMaps();

  const handleCopyFrom = async (serverId: string) => {
    setLoadingCopy(true);
    try {
      const [config, mods, allServers] = await Promise.all([
        getServerConfig(serverId),
        getServerMods(serverId),
        getServers(),
      ]);
      const source = allServers.find((s) => s.id === serverId);
      const gus = config && config.game_user_settings_json
        ? (JSON.parse(config.game_user_settings_json) as Record<string, Record<string, string>>)
        : {};
      const serverPVE = gus?.ServerSettings?.ServerPVE?.toLowerCase();
      const detectedMode: "pve" | "pvp" =
        serverPVE === "true" || source?.preset_id?.includes("pve") ? "pve" : "pvp";
      const newModNames: Record<string, string> = { ...data.modNames };
      for (const m of mods) newModNames[m.mod_id] = m.mod_name;
      // Merge into the existing mod list rather than replacing it — a
      // wholesale replace here used to silently drop the currently selected
      // map's required mod (added earlier on the Basic Info step).
      const modIds = [...data.modIds];
      for (const m of mods) {
        if (!modIds.includes(m.mod_id)) modIds.push(m.mod_id);
      }
      let lockedModIds = data.lockedModIds;
      const selectedMap = allMaps.find((m) => m.id === data.mapId);
      if (selectedMap?.isMod && selectedMap.requiredModId) {
        if (!modIds.includes(selectedMap.requiredModId)) modIds.push(selectedMap.requiredModId);
        lockedModIds = [selectedMap.requiredModId];
      }
      onChange({
        copyFromServerId: serverId,
        gameMode: detectedMode,
        presetStyle: "full_custom",
        fullCustomGus: gus,
        fullCustomGameIni: config?.game_ini_json ? JSON.parse(config.game_ini_json) : {},
        launchArgs: config?.launch_args_json ? JSON.parse(config.launch_args_json) : { NoBattlEye: "true", servergamelog: "true" },
        modIds,
        modNames: newModNames,
        lockedModIds,
      });
    } catch (e) {
      console.error("Copy from server failed:", e);
    } finally {
      setLoadingCopy(false);
    }
  };

  const isCopying = !!data.copyFromServerId;
  const copySource = existingServers.find((s) => s.id === data.copyFromServerId);

  return (
    <TooltipProvider>
      <div className="space-y-4">
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Choose the core ruleset for your server. This determines whether players can fight each other.
        </p>

        {/* PvP / PvE cards */}
        <div className={cn("grid gap-4", existingServers.length > 0 ? "grid-cols-3" : "grid-cols-2")}>
          {GAME_MODES.map((mode: GameModeConfig) => {
            const active = data.gameMode === mode.id && !isCopying;
            return (
              <button
                key={mode.id}
                onClick={() => { onChange({ gameMode: mode.id, copyFromServerId: "" }); }}
                className="rounded-xl p-5 text-left transition-all flex flex-col gap-3"
                style={{
                  background: active ? "rgba(var(--neon-purple-rgb),0.1)" : "var(--surface)",
                  border: `1px solid ${active ? "rgba(var(--neon-purple-rgb),0.5)" : "rgba(var(--neon-purple-rgb),0.12)"}`,
                  boxShadow: active ? "0 0 24px rgba(var(--neon-purple-rgb),0.1)" : "none",
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

          {/* Copy from server card */}
          {existingServers.length > 0 && (
            <div className="rounded-xl p-5 flex flex-col gap-3 transition-all"
              style={{
                background: isCopying ? "rgba(var(--neon-purple-rgb),0.08)" : "var(--surface)",
                border: `1px solid ${isCopying ? "rgba(var(--neon-purple-rgb),0.5)" : "rgba(var(--neon-purple-rgb),0.12)"}`,
              }}>
              <div className="text-3xl">🗂️</div>
              <div>
                <p className="text-base font-bold" style={{ color: isCopying ? "var(--neon-purple)" : "var(--text-primary)" }}>
                  Copy from Server
                </p>
                <p className="text-xs mt-1.5 leading-relaxed" style={{ color: "var(--text-muted)" }}>
                  Clone INI config, launch args, and mods from an existing server.
                </p>
              </div>
              {isCopying && copySource ? (
                <div className="mt-auto space-y-1.5">
                  <div className="flex items-center gap-1.5" style={{ color: "var(--neon-purple)" }}>
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    <span className="text-xs font-semibold truncate">{copySource.name}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onChange({
                      copyFromServerId: "",
                      presetStyle: "casual",
                      // Reset every field handleCopyFrom populated — Clear
                      // used to only reset the two above, silently leaving
                      // the copied mods/launch-args/INI in place on a server
                      // the user believed they'd reverted to blank.
                      fullCustomGus: DEFAULT_DATA.fullCustomGus,
                      fullCustomGameIni: DEFAULT_DATA.fullCustomGameIni,
                      launchArgs: DEFAULT_DATA.launchArgs,
                      modIds: DEFAULT_DATA.modIds,
                      modNames: DEFAULT_DATA.modNames,
                    })}
                    className="text-[10px] underline"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Clear
                  </button>
                </div>
              ) : (
                <div className="mt-auto space-y-1">
                  {existingServers.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      disabled={loadingCopy}
                      onClick={() => handleCopyFrom(s.id)}
                      className="w-full text-left px-2 py-1.5 rounded text-xs transition-colors hover:bg-[rgba(var(--neon-purple-rgb),0.1)] flex items-center gap-2"
                      style={{ color: "var(--text-primary)", border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}
                    >
                      {loadingCopy ? <Loader2 className="w-3 h-3 animate-spin shrink-0" /> : <Server className="w-3 h-3 shrink-0" style={{ color: "var(--text-muted)" }} />}
                      <span className="truncate">{s.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Copy-mode info banner */}
        {isCopying && (
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-xs"
            style={{ background: "rgba(var(--neon-purple-rgb),0.06)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--neon-purple)" }} />
            <p style={{ color: "var(--text-muted)" }}>
              Configuration copied from <strong style={{ color: "var(--text-primary)" }}>{copySource?.name}</strong>.
              INI config, launch args, and mods will mirror the source server.
              Style and Rate steps are skipped — you can still adjust network, automation, and other settings.
            </p>
          </div>
        )}

        {/* General settings — shown for non-copy flow */}
        {!isCopying && (
          <>
            {/* General */}
            <div className="rounded-xl p-4 space-y-2" style={{ background: "var(--surface)", border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}>
              <p className="text-xs font-semibold mb-3" style={{ color: "var(--neon-purple)" }}>General Settings</p>
              <GameModeToggle label="Admin Logging" description="Logs all admin commands to the server's game log file and in-game chat. Recommended for accountability." value={data.adminLogging} onChange={(v) => onChange({ adminLogging: v })} />
              <GameModeToggle label="Server Crosshair" description="Enables the crosshair reticle for all players on this server." value={data.serverCrosshair} onChange={(v) => onChange({ serverCrosshair: v })} />
              <GameModeToggle label="Show Damage Numbers" description="Shows floating damage numbers above targets when hit (ShowFloatingDamageText)." value={data.showDamageNumbers} onChange={(v) => onChange({ showDamageNumbers: v })} />
              <GameModeToggle label="Show Player Location" description="Players can see their GPS coordinates on the map (ShowMapPlayerLocation)." value={data.showPlayerLocation} onChange={(v) => onChange({ showPlayerLocation: v })} />
              <GameModeToggle label="Force All Structures Locking" description="Newly placed structures default to locked so only the owner/tribe can access them." value={data.forceAllStructureLocking} onChange={(v) => onChange({ forceAllStructureLocking: v })} />
              <GameModeToggle label="Always Allow Structure Pickup" description="Players can pick up their own structures at any time, not just within the placement grace period." value={data.alwaysAllowStructurePickup} onChange={(v) => onChange({ alwaysAllowStructurePickup: v })} />
              <GameModeToggle label="Disable Structure Placement Collision" description="Allows structures to be placed overlapping terrain and other objects. Useful for creative builds." value={data.disableStructurePlacementCollision} onChange={(v) => onChange({ disableStructurePlacementCollision: v })} />
              {/* NoBattlEye — CLI shortcut */}
              <GameModeToggle
                label="Disable BattlEye"
                description="Passes -NoBattlEye at launch. Disables BattlEye anti-cheat. Recommended for private/modded servers to avoid false positives."
                value={data.launchArgs.NoBattlEye === "true"}
                onChange={(v) => onChange({ launchArgs: { ...data.launchArgs, NoBattlEye: v ? "true" : "false" } })}
                warn
              />
              {/* ForceAllowCaveFlyers — CLI shortcut */}
              <GameModeToggle
                label="Force Allow Cave Flyers"
                description="Passes -ForceAllowCaveFlyers at launch. Allows flying dinosaurs inside caves. Default is off in vanilla."
                value={data.launchArgs.ForceAllowCaveFlyers === "true"}
                onChange={(v) => onChange({ launchArgs: { ...data.launchArgs, ForceAllowCaveFlyers: v ? "true" : "false" } })}
              />
            </div>

            {/* PvE options */}
            {data.gameMode === "pve" && (
              <div className="rounded-xl p-4 space-y-2" style={{ background: "var(--surface)", border: "1px solid rgba(0,255,136,0.15)" }}>
                <p className="text-xs font-semibold mb-3" style={{ color: "var(--neon-green)" }}>PvE Options</p>
                <GameModeToggle label="Flyer Carry (PvE)" description="AllowFlyerCarryPvE — allows flyers to carry wild dinos and players. Off by default in vanilla PvE." value={data.flyerCarryPvE} onChange={(v) => onChange({ flyerCarryPvE: v })} />
                <GameModeToggle label="Cave Building (PvE)" description="AllowCaveBuildingPvE — allows players to build structures inside caves. Off by default." value={data.allowCaveBuildingPvE} onChange={(v) => onChange({ allowCaveBuildingPvE: v })} />
                <GameModeToggle label="Build Near Supply Drops" description="PvEAllowStructuresAtSupplyDrops — allows players to build structures near supply drop landing zones." value={data.pveAllowStructuresAtSupplyDrops} onChange={(v) => onChange({ pveAllowStructuresAtSupplyDrops: v })} />
                <GameModeToggle label="Supply Drops Land on Structures" description="AllowCrateSpawnsOnTopOfStructures — supply crates can land on top of player structures." value={data.allowCrateSpawnsOnTopOfStructures} onChange={(v) => onChange({ allowCrateSpawnsOnTopOfStructures: v })} />
                <GameModeToggle label="Disable Structure Decay (PvE)" description="DisableStructureDecayPvE — structures never decay from inactivity. Useful for casual or roleplaying servers." value={data.disableStructureDecayPvE} onChange={(v) => onChange({ disableStructureDecayPvE: v })} />
                <GameModeToggle label="Disable Dino Decay (PvE)" description="DisableDinoDecayPvE — tamed dinos never decay from owner inactivity." value={data.disableDinoDecayPvE} onChange={(v) => onChange({ disableDinoDecayPvE: v })} />
              </div>
            )}

            {/* PvP options */}
            {data.gameMode === "pvp" && (
              <div className="rounded-xl p-4 space-y-2" style={{ background: "var(--surface)", border: "1px solid rgba(255,0,85,0.2)" }}>
                <p className="text-xs font-semibold mb-3" style={{ color: "var(--neon-red)" }}>PvP Options</p>
                <GameModeToggle label="Friendly Fire" description="Allows tribe members to damage each other in combat. On by default for PvP." value={data.pvpFriendlyFire} onChange={(v) => onChange({ pvpFriendlyFire: v })} />
                <GameModeToggle label="Offline Raid Protection (ORP)" description="PreventOfflinePvP — prevents structures and tames from taking damage when the owning tribe is offline." value={data.preventOfflinePvP} onChange={(v) => onChange({ preventOfflinePvP: v })} />
                {data.preventOfflinePvP && (
                  <div className="flex items-center gap-3 pl-1">
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-xs" style={{ color: "var(--text-muted)" }}>ORP Grace Period</span>
                      <TooltipProvider><Tooltip><TooltipTrigger asChild>
                        <HelpCircle className="w-3 h-3 cursor-help" style={{ color: "var(--neon-red)" }} />
                      </TooltipTrigger><TooltipContent className="max-w-xs text-xs">PreventOfflinePvPInterval — seconds after all tribe members log off before ORP activates. Default: 900 (15 minutes).</TooltipContent></Tooltip></TooltipProvider>
                    </div>
                    <div className="w-28">
                      <NumberField value={data.preventOfflinePvPInterval} onChange={(v) => onChange({ preventOfflinePvPInterval: v })} min={0} max={7200} step={60} defaultValue={900} />
                    </div>
                    <span className="text-xs shrink-0" style={{ color: "var(--text-muted)" }}>seconds</span>
                  </div>
                )}
                <div className="flex items-start gap-2 pt-2 border-t" style={{ borderColor: "rgba(255,0,85,0.15)" }}>
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--text-muted)" }} />
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                    Cryo sickness cannot be disabled on PvP servers via INI — it is hardcoded to PvP mode by the game. A mod is required to remove it on PvP.
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </TooltipProvider>
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
      <div className="space-y-2 pr-1">
        {PRESET_STYLES.map((style: PresetStyle) => {
          const active = data.presetStyle === style.id;
          return (
            <button
              key={style.id}
              onClick={() => onChange({ presetStyle: style.id as WizardData["presetStyle"] })}
              className="w-full rounded-lg p-4 text-left transition-all"
              style={{
                background: active ? "rgba(var(--neon-purple-rgb),0.1)" : "var(--surface)",
                border: `1px solid ${active ? "rgba(var(--neon-purple-rgb),0.5)" : "rgba(var(--neon-purple-rgb),0.12)"}`,
                boxShadow: active ? "0 0 16px rgba(var(--neon-purple-rgb),0.1)" : "none",
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
                          background: active ? "rgba(var(--neon-purple-rgb),0.15)" : "rgba(var(--neon-purple-rgb),0.07)",
                          color: active ? "var(--neon-purple)" : "var(--text-muted)",
                          border: "1px solid rgba(var(--neon-purple-rgb),0.2)",
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
                <p className="text-[10px] mt-2 flex items-center gap-1" style={{ color: "var(--neon-purple)" }}>
                  <ArrowRight className="w-3 h-3" />
                  {style.id === "guided_custom" ? "Next: 4-step guided setup — rates, breeding, combat, and QoL" : "Next step: open INI editor"}
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
// Step 2a–2d — Guided Custom Setup (4 pages)
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
    <div className="space-y-1.5 p-3 rounded-lg" style={{ background: "var(--surface)", border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}>
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

function GuidedToggle({ label, description, value, onChange, warn }: {
  label: string; description: string; value: boolean;
  onChange: (v: boolean) => void; warn?: boolean;
}) {
  const color = warn ? "var(--neon-red)" : "var(--neon-purple)";
  const border = warn ? "rgba(255,0,85,0.2)" : "rgba(var(--neon-purple-rgb),0.12)";
  return (
    <div className="flex items-center justify-between p-3 rounded-lg" style={{ background: "var(--surface)", border: `1px solid ${border}` }}>
      <div>
        <p className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{label}</p>
        <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>{description}</p>
      </div>
      <button type="button" onClick={() => onChange(!value)} className="shrink-0" aria-label={value ? "Disable" : "Enable"}>
        {value
          ? <ToggleRight className="w-8 h-8" style={{ color }} />
          : <ToggleLeft  className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />}
      </button>
    </div>
  );
}

// Page 1 — Core Rates
function GuidedRatesStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const r = data.guidedRates;
  const set = (k: keyof GuidedRates, v: number | boolean) =>
    onChange({ guidedRates: { ...r, [k]: v } });

  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Set the core experience rates. Everything else can be fine-tuned on the next pages or in the Config tab later.
      </p>
      <div className="space-y-2 pr-1">
        <RateSlider label="XP Multiplier" description="How fast players and tames gain experience." value={r.xpMultiplier} min={0.5} max={20} step={0.5} onChange={(v) => set("xpMultiplier", v)} />
        <RateSlider label="Harvest Amount" description="Resource yield per harvest action." value={r.harvestMultiplier} min={0.5} max={20} step={0.5} onChange={(v) => set("harvestMultiplier", v)} />
        <RateSlider label="Harvest Health" description="How many hits a resource node takes before it depletes. Higher = resources last longer per node." value={r.harvestHealthMultiplier} min={0.5} max={10} step={0.5} onChange={(v) => set("harvestHealthMultiplier", v)} />
        <RateSlider label="Taming Speed" description="How quickly taming effectiveness increases per feeding." value={r.tamingMultiplier} min={0.5} max={30} step={0.5} onChange={(v) => set("tamingMultiplier", v)} />
        <RateSlider label="Wild Dino Max Level" description="Highest level wild dinos can spawn. 150 is standard for most community servers." value={r.wildDinoMaxLevel} min={30} max={300} step={30} onChange={(v) => set("wildDinoMaxLevel", v)} formatValue={(v) => `Level ${v}`} />
        <RateSlider label="Resource Respawn" description="Lower = faster respawn. 0.5 = twice as fast as vanilla." value={r.resourceRespawnMultiplier} min={0.05} max={2.0} step={0.05} onChange={(v) => set("resourceRespawnMultiplier", v)} />
        <RateSlider label="Night Speed" description="How fast nights pass. 2× means nights are half as long." value={r.nightSpeedMultiplier} min={1.0} max={10} step={0.5} onChange={(v) => set("nightSpeedMultiplier", v)} />
      </div>
    </div>
  );
}

// Page 2 — Breeding
function GuidedBreedingStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const r = data.guidedRates;
  const set = (k: keyof GuidedRates, v: number | boolean) =>
    onChange({ guidedRates: { ...r, [k]: v } });

  // Warn if food consumption is high enough relative to mature speed that babies could starve
  const starvationRisk = r.foodConsumptionMultiplier > r.matureSpeedMultiplier;

  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Tune breeding rates. Food consumption speed is critical — if it&apos;s too high relative to mature speed, babies will starve before they grow up.
      </p>
      <div className="space-y-2 pr-1">
        <RateSlider label="Baby Mature Speed" description="How fast babies grow to adults. 10× = maturation is 10× faster than vanilla." value={r.matureSpeedMultiplier} min={1} max={100} step={1} onChange={(v) => set("matureSpeedMultiplier", v)} />
        <RateSlider label="Egg Hatch Speed" description="How fast eggs hatch. Can be set independently from mature speed." value={r.hatchSpeedMultiplier} min={1} max={100} step={1} onChange={(v) => set("hatchSpeedMultiplier", v)} />

        <div className="space-y-1.5 p-3 rounded-lg" style={{ background: "var(--surface)", border: `1px solid ${starvationRisk ? "rgba(255,0,85,0.4)" : "rgba(var(--neon-purple-rgb),0.12)"}` }}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold" style={{ color: starvationRisk ? "var(--neon-red)" : "var(--text-primary)" }}>
                Baby Food Consumption Speed
              </p>
              <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                How fast babies eat food. Keep this below your Mature Speed or babies will starve.
              </p>
            </div>
            <span className="text-sm font-mono font-bold min-w-16 text-right" style={{ color: starvationRisk ? "var(--neon-red)" : "var(--neon-purple)" }}>{r.foodConsumptionMultiplier}×</span>
          </div>
          <Slider min={0.1} max={50} step={0.5} value={[r.foodConsumptionMultiplier]} onValueChange={([v]) => set("foodConsumptionMultiplier", v)} />
          {starvationRisk && (
            <div className="flex items-center gap-1.5 mt-1">
              <AlertTriangle className="w-3 h-3 shrink-0" style={{ color: "var(--neon-red)" }} />
              <p className="text-[10px]" style={{ color: "var(--neon-red)" }}>
                Food consumption ({r.foodConsumptionMultiplier}×) exceeds mature speed ({r.matureSpeedMultiplier}×) — babies will likely starve. Set food consumption lower than mature speed.
              </p>
            </div>
          )}
        </div>

        <RateSlider label="Mating Interval" description="Cooldown between matings. Lower = breed more often. 0.25 = 4× more frequent." value={r.matingIntervalMultiplier} min={0.01} max={2.0} step={0.01} onChange={(v) => set("matingIntervalMultiplier", v)} />
        <RateSlider label="Mating Speed" description="How fast the mating animation completes." value={r.matingSpeedMultiplier} min={1} max={5} step={0.5} onChange={(v) => set("matingSpeedMultiplier", v)} />
        <RateSlider label="Cuddle Interval" description="How often babies request cuddles (imprinting). Lower = less frequent requests." value={r.cuddleIntervalMultiplier} min={0.05} max={2.0} step={0.05} onChange={(v) => set("cuddleIntervalMultiplier", v)} />
        <RateSlider label="Cuddle Grace Period" description="How long you have to respond to a cuddle before imprint quality drops." value={r.cuddleGraceMultiplier} min={1} max={10} step={0.5} onChange={(v) => set("cuddleGraceMultiplier", v)} />
        <RateSlider label="Imprint Amount per Cuddle" description="How much imprint % each cuddle gives. Higher = reach 100% with fewer cuddles." value={r.imprintAmountMultiplier} min={1} max={10} step={0.5} onChange={(v) => set("imprintAmountMultiplier", v)} />
      </div>
    </div>
  );
}

// Page 3 — Combat
function GuidedCombatStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const r = data.guidedRates;
  const set = (k: keyof GuidedRates, v: number | boolean) =>
    onChange({ guidedRates: { ...r, [k]: v } });
  const isPvP = data.gameMode === "pvp";

  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Tune combat damage and resistance. 1× is vanilla. All values can be changed from the Config tab later.
      </p>
      <div className="space-y-2 pr-1">
        <RateSlider label="Player Damage" description="Damage output multiplier for players." value={r.playerDamageMultiplier} min={0.5} max={5} step={0.1} onChange={(v) => set("playerDamageMultiplier", v)} />
        <RateSlider label="Player Resistance" description="Incoming damage reduction for players. Higher = tankier players." value={r.playerResistanceMultiplier} min={0.5} max={5} step={0.1} onChange={(v) => set("playerResistanceMultiplier", v)} />
        <RateSlider label="Dino Damage (Wild)" description="Damage output multiplier for wild dinos." value={r.dinoDamageMultiplier} min={0.5} max={5} step={0.1} onChange={(v) => set("dinoDamageMultiplier", v)} />
        <RateSlider label="Dino Resistance (Wild)" description="Incoming damage reduction for wild dinos." value={r.dinoResistanceMultiplier} min={0.5} max={5} step={0.1} onChange={(v) => set("dinoResistanceMultiplier", v)} />
        <RateSlider label="Tamed Dino Damage" description="Damage output multiplier for player-tamed dinos." value={r.tamedDinoDamageMultiplier} min={0.5} max={5} step={0.1} onChange={(v) => set("tamedDinoDamageMultiplier", v)} />
        <RateSlider label="Tamed Dino Resistance" description="Incoming damage reduction for player-tamed dinos." value={r.tamedDinoResistanceMultiplier} min={0.5} max={5} step={0.1} onChange={(v) => set("tamedDinoResistanceMultiplier", v)} />
        {isPvP && <>
          <RateSlider label="Structure Damage" description="Damage multiplier for attacks against player structures. Affects raiding." value={r.structureDamageMultiplier} min={0.5} max={10} step={0.5} onChange={(v) => set("structureDamageMultiplier", v)} />
          <RateSlider label="Structure Resistance" description="Incoming damage reduction for player-built structures." value={r.structureResistanceMultiplier} min={0.5} max={5} step={0.1} onChange={(v) => set("structureResistanceMultiplier", v)} />
          <GuidedToggle
            label="PvP Respawn Penalty"
            description="Adds increasing respawn time when a player is repeatedly killed by the same player. Discourages spawn camping."
            value={r.enableRespawnPenalty}
            onChange={(v) => set("enableRespawnPenalty", v)}
          />
        </>}
        <GuidedToggle
          label="Turret Limits"
          description="Limits turrets to 100 within a 10,000 unit radius. Prevents server performance issues from turret spam."
          value={r.enableTurretLimits}
          onChange={(v) => set("enableTurretLimits", v)}
        />
      </div>
    </div>
  );
}

// Page 4 — Server QoL / Behavior
function GuidedBehaviorStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const r = data.guidedRates;
  const set = (k: keyof GuidedRates, v: number | boolean) =>
    onChange({ guidedRates: { ...r, [k]: v } });
  const isPvP = data.gameMode === "pvp";
  const isPvE = data.gameMode === "pve";

  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Quality-of-life and server behavior settings. {isPvP ? "ORP protects offline players." : "Decay settings reduce maintenance stress for PvE."}
      </p>
      <div className="space-y-2 pr-1">
        <GuidedToggle
          label="Flyer Stamina Recovery"
          description="Flyers recover stamina while the rider is standing on them in-flight (not just when landed)."
          value={r.allowFlyingStaminaRecovery}
          onChange={(v) => set("allowFlyingStaminaRecovery", v)}
        />
        <GuidedToggle
          label="Speed Leveling"
          description="Players can spend level-up points on movement speed for creatures."
          value={r.allowSpeedLeveling}
          onChange={(v) => set("allowSpeedLeveling", v)}
        />
        <GuidedToggle
          label="Flyer Speed Leveling"
          description="Players can level up flyer movement speed. Separate from ground creature speed leveling."
          value={r.allowFlyerSpeedLeveling}
          onChange={(v) => set("allowFlyerSpeedLeveling", v)}
        />
        <GuidedToggle
          label="Unlimited Respecs"
          description="Remove the 24-hour cooldown on Mindwipe Tonic. Players can respec as often as they want."
          value={r.allowUnlimitedRespecs}
          onChange={(v) => set("allowUnlimitedRespecs", v)}
        />
        <GuidedToggle
          label="Enhance Skill Gains"
          description="Boosts per-level stat gains for players — more health, stamina, and damage points per level."
          value={r.enhanceSkillGains}
          onChange={(v) => set("enhanceSkillGains", v)}
        />
        <RateSlider label="Global Spoiling Time" description="How long food stays fresh. 2× = food lasts twice as long as vanilla." value={r.globalSpoilingTimeMultiplier} min={0.5} max={10} step={0.5} onChange={(v) => set("globalSpoilingTimeMultiplier", v)} />
        <RateSlider label="Item Decomposition Time" description="How long dropped bags and items last on the ground." value={r.globalItemDecompMultiplier} min={0.5} max={10} step={0.5} onChange={(v) => set("globalItemDecompMultiplier", v)} />
        {isPvE && (
          <RateSlider label="Corpse Decomposition Time" description="How long player corpses last. More time to retrieve your items." value={r.globalCorpseDecompMultiplier} min={0.5} max={10} step={0.5} onChange={(v) => set("globalCorpseDecompMultiplier", v)} />
        )}
        {/* ORP is now controlled in the Game Mode step */}
        {/* Structure/tame decay is now controlled in the Game Mode step */}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2b — Full INI Config Editor
// ---------------------------------------------------------------------------

// Read-only fields (ports/name managed elsewhere) — module-level so it's a
// stable reference for the useMemo below instead of being recreated (and
// needing to be a dependency) on every render.
const FULL_INI_READONLY_KEYS = new Set(["SessionName", "ServerPassword", "QueryPort", "Port", "RCONEnabled", "RCONPort", "MaxPlayers", "ServerAdminPassword"]);

function FullIniStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["session", "admin", "rates"]));
  const [searchQuery, setSearchQuery] = useState("");
  const preSearchExpandedRef = useRef<Set<string> | null>(null);

  const handleSearchChange = (q: string) => {
    if (q && !searchQuery) {
      preSearchExpandedRef.current = new Set(expandedGroups);
    } else if (!q && searchQuery) {
      if (preSearchExpandedRef.current) {
        setExpandedGroups(preSearchExpandedRef.current);
        preSearchExpandedRef.current = null;
      }
    }
    setSearchQuery(q);
  };

  const toggleGroup = (id: string) => {
    if (searchQuery) return;
    setExpandedGroups((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

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
    const skip = new Set(["SessionName", "ServerPassword", "QueryPort", "Port", "RCONEnabled", "RCONPort", "MaxPlayers"]);
    for (const [k, v] of Object.entries(preset)) {
      if (!skip.has(k)) result.ServerSettings[k] = String(v);
    }
    result.ServerSettings.ServerAdminPassword = data.adminPassword || "changeme";
    result["/Script/Engine.GameSession"] = { MaxPlayers: String(data.maxPlayers) };
    return result;
  }, [data.fullCustomGus, data.gameMode, data.name, data.serverPassword, data.rconPort, data.adminPassword, data.maxPlayers]);

  // Snapshot the wizard-built config on first render (lazy state initializer,
  // runs once) — used as the reset baseline for boolean fields so the icon
  // only appears when the user changes something from what the wizard set
  // up, not from the raw game-engine default. State rather than a ref since
  // it needs to be read during render.
  const [initialGus] = useState(() => gus);

  const getValue = (iniSection: string, key: string): string => {
    return gus[iniSection]?.[key] ?? "";
  };

  const getInitialVal = (iniSection: string, key: string): string => {
    return initialGus?.[iniSection]?.[key] ?? "";
  };

  const setValue = (iniSection: string, key: string, value: string) => {
    const updated = {
      ...gus,
      [iniSection]: { ...(gus[iniSection] ?? {}), [key]: value },
    };
    onChange({ fullCustomGus: updated });
  };

  const lq = searchQuery.toLowerCase().trim();
  const filteredGroups = useMemo(() => {
    if (!lq) return null;
    return INI_FIELD_GROUPS.map((group) => ({
      ...group,
      fields: group.fields.filter(
        (f) => f.section === "gus" && !FULL_INI_READONLY_KEYS.has(f.key) && (
          f.label.toLowerCase().includes(lq) ||
          f.key.toLowerCase().includes(lq) ||
          (f.description ?? "").toLowerCase().includes(lq)
        )
      ),
    })).filter((g) => g.fields.length > 0);
  }, [lq]);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="space-y-3">
        {/* Search bar */}
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Filter settings…"
            className="w-full text-sm rounded-lg px-3 py-2 pr-8"
            style={{
              background: "var(--surface)",
              border: "1px solid rgba(var(--neon-purple-rgb),0.3)",
              color: "var(--text-primary)",
              outline: "none",
            }}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => handleSearchChange("")}
              className="absolute inset-y-0 right-0 flex items-center pr-2.5"
              style={{ color: "var(--neon-purple)" }}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {lq && filteredGroups?.length === 0 && (
          <div className="rounded-lg py-8 text-center" style={{ background: "rgba(var(--neon-purple-rgb),0.04)", border: "1px dashed rgba(var(--neon-purple-rgb),0.2)" }}>
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>No settings match &ldquo;{searchQuery}&rdquo;</p>
          </div>
        )}
        <div className="space-y-2 pr-1">
          {(filteredGroups ?? INI_FIELD_GROUPS).map((group) => {
            const isFiltering = !!lq;
            const open = isFiltering || expandedGroups.has(group.id);
            const visibleFields = isFiltering
              ? group.fields
              : group.fields.filter((f) => f.section === "gus" && !FULL_INI_READONLY_KEYS.has(f.key));
            if (!isFiltering && visibleFields.length === 0) return null;
            return (
              <div key={group.id} className="rounded-lg overflow-hidden" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}>
                <button
                  onClick={() => toggleGroup(group.id)}
                  className="w-full flex items-center justify-between px-4 py-2.5"
                  style={{ background: "var(--surface-elevated)", cursor: isFiltering ? "default" : "pointer" }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{group.title}</span>
                    {isFiltering && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: "rgba(var(--neon-purple-rgb),0.15)", color: "var(--neon-purple)", border: "1px solid rgba(var(--neon-purple-rgb),0.3)" }}>
                        {visibleFields.length}
                      </span>
                    )}
                  </div>
                  {!isFiltering && (open ? <ChevronUp className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} /> : <ChevronDown className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} />)}
                </button>
                {open && (
                  <div className="p-3 space-y-2.5" style={{ background: "var(--surface)" }}>
                    {visibleFields.map((field) => {
                      const raw = getValue(field.iniSection, field.key);
                      // Fall back to the field's defaultValue when the config hasn't set this key yet,
                      // so the slider starts at the documented default rather than 0.
                      const val = raw !== "" ? raw : field.defaultValue !== undefined ? String(field.defaultValue) : "";
                      const isBool = field.type === "boolean";

                      const LabelWithTooltip = (
                        <div className="flex items-center gap-1.5 min-w-0">
                          <Label className="text-xs truncate" style={{ color: "var(--text-primary)" }}>{field.label}</Label>
                          {field.description && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <HelpCircle className="w-3 h-3 shrink-0 cursor-help" style={{ color: "var(--neon-purple)" }} />
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-xs text-xs leading-snug">
                                {field.description}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      );

                      if (isBool) {
                        const initialVal = getInitialVal(field.iniSection, field.key);
                        const baseVal = initialVal !== "" ? initialVal : (field.defaultValue !== undefined ? String(field.defaultValue) : "");
                        const isNonDefault = baseVal !== "" && val.toLowerCase() !== baseVal.toLowerCase();
                        return (
                          <div key={field.key} className="flex items-center justify-between gap-2">
                            {LabelWithTooltip}
                            <div className="flex items-center gap-1.5 shrink-0">
                              {isNonDefault && (
                                <button
                                  type="button"
                                  onClick={() => setValue(field.iniSection, field.key, baseVal.charAt(0).toUpperCase() + baseVal.slice(1).toLowerCase())}
                                  title="Reset to default"
                                  style={{ background: "none", border: "none", padding: "2px", cursor: "pointer", color: "rgba(var(--neon-purple-rgb),0.5)", lineHeight: 0 }}
                                >
                                  <RotateCcw className="w-3 h-3" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => setValue(field.iniSection, field.key, val.toLowerCase() === "true" ? "False" : "True")}
                                aria-label={val.toLowerCase() === "true" ? "Disable" : "Enable"}
                                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", lineHeight: 0 }}
                              >
                                {val.toLowerCase() === "true"
                                  ? <ToggleRight className="w-7 h-7" style={{ color: "var(--neon-purple)" }} />
                                  : <ToggleLeft  className="w-7 h-7" style={{ color: "var(--text-subtle)" }} />}
                              </button>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div key={field.key} className="space-y-1">
                          {LabelWithTooltip}
                          {field.type === "number" && field.min !== undefined && field.max !== undefined ? (
                            <NumberField
                              value={parseFloat(val) || 0}
                              onChange={(v) => setValue(field.iniSection, field.key, String(v))}
                              min={field.min}
                              max={field.max}
                              step={field.step}
                              defaultValue={typeof field.defaultValue === "number" ? field.defaultValue : undefined}
                            />
                          ) : (
                            <Input
                              type="text"
                              value={val}
                              placeholder={field.placeholder}
                              onChange={(e) => setValue(field.iniSection, field.key, e.target.value)}
                              className="h-7 text-xs font-mono"
                              style={{
                                background: "var(--surface)",
                                borderColor: "rgba(var(--neon-purple-rgb),0.2)",
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
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Network Step
// ---------------------------------------------------------------------------

function PortField({
  label, fieldKey, value, status, conflict, description, onChange, onBlur,
}: {
  label: string;
  fieldKey: "port" | "queryPort" | "rconPort";
  value: number;
  status: boolean | null | undefined;
  conflict: string | undefined;
  description: string;
  onChange: (fieldKey: "port" | "queryPort" | "rconPort", val: number) => void;
  onBlur: (fieldKey: string, val: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label style={{ color: "var(--text-primary)" }}>{label}</Label>
        {status === true && !conflict && <span className="text-[10px]" style={{ color: "var(--neon-green)" }}>Available</span>}
        {status === false && <span className="text-[10px]" style={{ color: "var(--neon-red)" }}>In use on this machine!</span>}
      </div>
      <Input
        type="number" min={1024} max={65535} value={value}
        onChange={(e) => onChange(fieldKey, Number(e.target.value))}
        onBlur={() => onBlur(fieldKey, value)}
        className="font-mono"
        style={{
          background: "var(--surface)",
          borderColor: conflict ? "rgba(255,140,0,0.6)" : status === false ? "var(--neon-red)" : status === true ? "rgba(0,255,136,0.4)" : "rgba(var(--neon-purple-rgb),0.3)",
          color: "var(--text-primary)",
        }}
      />
      {conflict && (
        <p className="text-[10px] flex items-center gap-1" style={{ color: "rgba(255,140,0,0.9)" }}>
          <AlertTriangle className="w-3 h-3 shrink-0" />
          Shared with <strong>{conflict}</strong> — both servers cannot run at the same time.
        </p>
      )}
      <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>{description}</p>
    </div>
  );
}

function NetworkStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const [portStatus, setPortStatus] = useState<Record<string, boolean | null>>({});
  const [checking, setChecking] = useState(false);
  const [conflicts, setConflicts] = useState<Record<string, string>>({});
  const conflictDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every call so an older, slower-resolving request can never
  // overwrite a newer one's result if responses arrive out of order.
  const conflictReqIdRef = useRef(0);
  // Same idea per-field for checkPort — keyed since game/query/rcon ports
  // can each have an independent check in flight at once.
  const portReqIdRef = useRef<Record<string, number>>({});

  useEffect(() => () => {
    if (conflictDebounceRef.current) clearTimeout(conflictDebounceRef.current);
  }, []);

  const updateConflicts = useCallback((
    game: number, query: number, rcon: number,
    usedMap?: Map<number, string>,
  ) => {
    const reqId = ++conflictReqIdRef.current;
    getServers().then((servers) => {
      if (reqId !== conflictReqIdRef.current) return;
      const used = usedMap ?? new Map(servers.flatMap((s) => [
        [s.port, s.name], [s.query_port, s.name], [s.rcon_port, s.name],
      ] as [number, string][]));
      const next: Record<string, string> = {};
      if (used.has(game))  next.port      = used.get(game)!;
      if (used.has(query)) next.queryPort  = used.get(query)!;
      if (used.has(rcon))  next.rconPort   = used.get(rcon)!;
      setConflicts(next);
    }).catch(() => {});
  }, []);

  // On mount: load existing servers, suggest next available ports, detect conflicts
  const suggestPorts = useCallback(() => {
    getServers().then((servers) => {
      if (servers.length === 0) return;

      // Collect all ports in use
      const usedPorts = new Map<number, string>(); // port → server name
      for (const s of servers) {
        usedPorts.set(s.port, s.name);
        usedPorts.set(s.query_port, s.name);
        usedPorts.set(s.rcon_port, s.name);
      }

      // Find next available game port (step by 1 — ASA does not use port+1)
      const maxGame  = Math.max(...servers.map((s) => s.port));
      const maxQuery = Math.max(...servers.map((s) => s.query_port));
      const maxRcon  = Math.max(...servers.map((s) => s.rcon_port));

      const suggestGame  = maxGame  + 1;
      const suggestQuery = maxQuery + 1;
      const suggestRcon  = maxRcon  + 1;

      // Only apply suggestion if the user hasn't changed from the default
      const isDefault =
        data.port === 7777 && data.queryPort === 27015 && data.rconPort === 27020;
      if (isDefault) {
        onChange({ port: suggestGame, queryPort: suggestQuery, rconPort: suggestRcon });
      }

      // Check conflicts against the ports that will actually be displayed —
      // if we just auto-incremented, use the suggested values, not the stale closure values.
      const checkGame  = isDefault ? suggestGame  : data.port;
      const checkQuery = isDefault ? suggestQuery : data.queryPort;
      const checkRcon  = isDefault ? suggestRcon  : data.rconPort;
      updateConflicts(checkGame, checkQuery, checkRcon, usedPorts);
    }).catch(() => {});
  }, [data.port, data.queryPort, data.rconPort, onChange, updateConflicts]);
  useOnMount(suggestPorts);

  const checkPort = async (portKey: string, port: number) => {
    // Guards against editing+blurring the same field twice in quick
    // succession — an older, slower response could otherwise overwrite the
    // correct newer status.
    const reqId = (portReqIdRef.current[portKey] ?? 0) + 1;
    portReqIdRef.current[portKey] = reqId;
    setChecking(true);
    try {
      const available = await tauriCmd.checkPortAvailable(port);
      if (portReqIdRef.current[portKey] !== reqId) return;
      setPortStatus((prev) => ({ ...prev, [portKey]: available }));
    } catch {
      if (portReqIdRef.current[portKey] !== reqId) return;
      setPortStatus((prev) => ({ ...prev, [portKey]: null }));
    } finally {
      setChecking(false);
    }
  };

  const handlePortChange = (fieldKey: "port" | "queryPort" | "rconPort", val: number) => {
    const next = { ...{ port: data.port, queryPort: data.queryPort, rconPort: data.rconPort }, [fieldKey]: val };
    onChange({ [fieldKey]: val });
    if (conflictDebounceRef.current) clearTimeout(conflictDebounceRef.current);
    conflictDebounceRef.current = setTimeout(() => {
      updateConflicts(next.port, next.queryPort, next.rconPort);
    }, 400);
  };

  return (
    <div className="space-y-5">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Ports have been auto-suggested based on your existing servers. Each server needs a unique set of three ports.
      </p>
      <PortField label="Game Port" fieldKey="port" value={data.port} status={portStatus["port"]} conflict={conflicts["port"]} description="Clients connect here (UDP)." onChange={handlePortChange} onBlur={checkPort} />
      <PortField label="Query Port" fieldKey="queryPort" value={data.queryPort} status={portStatus["queryPort"]} conflict={conflicts["queryPort"]} description="Steam server browser (UDP)." onChange={handlePortChange} onBlur={checkPort} />
      <PortField label="RCON Port" fieldKey="rconPort" value={data.rconPort} status={portStatus["rconPort"]} conflict={conflicts["rconPort"]} description="Remote console (TCP)." onChange={handlePortChange} onBlur={checkPort} />
      {checking && (
        <p className="text-xs flex items-center gap-1" style={{ color: "var(--text-muted)" }}>
          <Loader2 className="w-3 h-3 animate-spin" /> Checking port availability…
        </p>
      )}
      {/* All Platforms toggle */}
      <div className="flex items-center justify-between px-1 py-2 rounded-lg"
        style={{ background: "rgba(var(--neon-purple-rgb),0.04)", border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}>
        <div>
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>All Platforms (Crossplay)</p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>Allow PC, Xbox, PlayStation, and other platforms to join via <code>-crossplay</code>.</p>
        </div>
        <button type="button"
          onClick={() => onChange({ launchArgs: { ...data.launchArgs, crossplay: data.launchArgs?.crossplay === "true" ? "false" : "true" } })}
          className="shrink-0 flex items-center">
          {data.launchArgs?.crossplay === "true"
            ? <ToggleRight className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
            : <ToggleLeft className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />}
        </button>
      </div>

      <div
        className="flex gap-2.5 rounded-lg px-3 py-2.5"
        style={{ background: "rgba(var(--neon-purple-rgb),0.06)", border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}
      >
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "var(--neon-purple)" }} />
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          These ports also need to be forwarded on your router or VPN service for players outside
          your home network to connect. See the{" "}
          <span style={{ color: "var(--neon-purple)" }}>Quick Start Guide</span>
          {" "}(? in the sidebar) for details.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Firewall Step
// ---------------------------------------------------------------------------

type FirewallPhase = "checking" | "ready" | "adding" | "done" | "skipped" | "error";

function FirewallStep({ data }: { data: WizardData }) {
  const [phase, setPhase] = useState<FirewallPhase>("checking");
  const [status, setStatus] = useState<FirewallStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const ports: PortDef[] = [
    { port: data.port,      protocol: "udp" },
    { port: data.queryPort, protocol: "udp" },
    { port: data.rconPort,  protocol: "tcp" },
  ];

  const checkFirewall = useCallback(() => {
    const checkPorts: PortDef[] = [
      { port: data.port,      protocol: "udp" },
      { port: data.queryPort, protocol: "udp" },
      { port: data.rconPort,  protocol: "tcp" },
    ];
    tauriCmd.checkFirewallPorts(checkPorts).then((result) => {
      setStatus(result);
      const allCovered = !result.active || result.ports.every((p) => p.covered);
      setPhase(allCovered ? "done" : "ready");
    }).catch(() => setPhase("ready"));
  }, [data.port, data.queryPort, data.rconPort]);
  useOnMount(checkFirewall);

  const handleAddRules = async () => {
    if (!status) return;
    const missing = status.ports.filter((p) => !p.covered);
    if (missing.length === 0) { setPhase("done"); return; }
    setPhase("adding");
    try {
      // Build the complete desired port set: all existing servers + this new server.
      // The new server isn't in the DB yet, so we add its ports explicitly.
      const existingServers = await getServers();
      const allPortsMap = new Map<string, PortDef>();
      for (const srv of existingServers) {
        for (const p of getServerFirewallPorts(srv)) {
          allPortsMap.set(`${p.port}/${p.protocol}`, p);
        }
      }
      for (const p of ports) {
        allPortsMap.set(`${p.port}/${p.protocol}`, p);
      }
      const protonPath = (await getAppSetting("proton_path")) ?? undefined;
      await tauriCmd.addFirewallRules([...allPortsMap.values()], protonPath);
      // Re-check so the port list shows real green checkmarks instead of staying stale.
      const updated = await tauriCmd.checkFirewallPorts(ports);
      setStatus(updated);
      setPhase("done");
    } catch (e) {
      setErrorMsg(String(e));
      setPhase("error");
    }
  };

  const firewallLabel: Record<string, string> = {
    ufw: "UFW", firewalld: "firewalld", iptables: "iptables",
    nftables: "nftables", windows: "Windows Firewall", none: "None detected",
  };

  return (
    <div className="space-y-5">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        LokiASAM can open the required ports in your system firewall so players can connect.
        This requires a one-time administrator prompt.
      </p>

      {/* Status */}
      {phase === "checking" && (
        <div className="flex items-center gap-2" style={{ color: "var(--text-muted)" }}>
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Checking firewall…</span>
        </div>
      )}

      {status && !status.active && (phase === "done" || phase === "ready") && (
        <div className="flex items-center gap-2 rounded-lg px-3 py-2.5"
          style={{ background: "rgba(0,255,136,0.07)", border: "1px solid rgba(0,255,136,0.2)" }}>
          <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: "var(--neon-green)" }} />
          <p className="text-sm" style={{ color: "var(--neon-green)" }}>
            No active firewall detected — nothing to configure.
          </p>
        </div>
      )}

      {status && status.active && (phase === "ready" || phase === "done") && (
        <div className="space-y-2">
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Firewall: <span style={{ color: "var(--text-primary)" }}>{firewallLabel[status.firewallType] ?? status.firewallType}</span>
          </p>
          {status.ports.map((p) => (
            <div key={`${p.port}-${p.protocol}`}
              className="flex items-center justify-between text-xs px-3 py-1.5 rounded-lg"
              style={{ background: "rgba(var(--neon-purple-rgb),0.05)", border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}>
              <span style={{ color: "var(--text-primary)" }}>
                {p.port}/{p.protocol.toUpperCase()}
                </span>
              {p.covered
                ? <CheckCircle2 className="w-3.5 h-3.5" style={{ color: "var(--neon-green)" }} />
                : <AlertCircle className="w-3.5 h-3.5" style={{ color: "var(--neon-orange, #f97316)" }} />}
            </div>
          ))}
        </div>
      )}

      {phase === "done" && status?.active && status.ports.every((p) => p.covered) && (
        <div className="flex items-center gap-2 rounded-lg px-3 py-2.5"
          style={{ background: "rgba(0,255,136,0.07)", border: "1px solid rgba(0,255,136,0.2)" }}>
          <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: "var(--neon-green)" }} />
          <p className="text-sm" style={{ color: "var(--neon-green)" }}>All ports are open.</p>
        </div>
      )}

      {phase === "adding" && (
        <div className="flex items-center gap-2" style={{ color: "var(--text-muted)" }}>
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Waiting for administrator approval…</span>
        </div>
      )}

      {phase === "error" && (
        <div className="rounded-lg px-3 py-2.5 space-y-1"
          style={{ background: "rgba(255,59,59,0.08)", border: "1px solid rgba(255,59,59,0.25)" }}>
          <p className="text-sm font-medium" style={{ color: "var(--neon-red)" }}>Failed to add rules</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>{errorMsg}</p>
        </div>
      )}

      {phase === "skipped" && (
        <div className="rounded-lg px-3 py-2.5"
          style={{ background: "rgba(249,115,22,0.08)", border: "1px solid rgba(249,115,22,0.25)" }}>
          <p className="text-xs" style={{ color: "var(--neon-orange, #f97316)" }}>
            Firewall rules will not be managed by LokiASAM. You are responsible for opening the
            required ports. Players outside your local network may not be able to connect.
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-col gap-2">
        {(phase === "ready" || phase === "error") && status?.active && (
          <button
            onClick={handleAddRules}
            className="w-full py-2.5 rounded-lg text-sm font-medium transition-all"
            style={{
              background: "rgba(var(--neon-purple-rgb),0.15)",
              border: "1px solid rgba(var(--neon-purple-rgb),0.4)",
              color: "var(--neon-purple)",
            }}
          >
            <Shield className="w-4 h-4 inline mr-2" />
            Open Ports in Firewall
          </button>
        )}
        {phase !== "done" && phase !== "skipped" && phase !== "adding" && (
          <button
            onClick={() => setPhase("skipped")}
            className="text-xs text-center py-1.5"
            style={{ color: "var(--text-subtle)" }}
          >
            Skip — I&apos;ll manage manually
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cluster Step
// ---------------------------------------------------------------------------

function ClusterStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const [clusters, setClusters] = useState<ClusterRow[]>([]);
  const [joinCluster, setJoinCluster] = useState(!!data.clusterId);
  const [newClusterName, setNewClusterName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => { getClusters().then(setClusters).catch(() => {}); }, []);

  const handleToggleJoin = (join: boolean) => {
    setJoinCluster(join);
    if (!join) {
      // Remove NoTransferFromFiltering when leaving cluster
      const nextArgs = { ...data.launchArgs };
      delete nextArgs["NoTransferFromFiltering"];
      onChange({ clusterId: "", launchArgs: nextArgs });
    }
  };

  const handleSelectCluster = (id: string) => {
    // Auto-apply NoTransferFromFiltering when joining a cluster
    const nextArgs = { ...data.launchArgs, NoTransferFromFiltering: "true" };
    onChange({ clusterId: id, launchArgs: nextArgs });
  };

  const handleCreateCluster = async () => {
    const name = newClusterName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const id = generateUUID();
      await createClusterRecord(id, name, null);
      const updated = await getClusters();
      setClusters(updated);
      setNewClusterName("");
      handleSelectCluster(id);
    } catch (e) {
      console.error("Failed to create cluster:", e);
    } finally {
      setCreating(false);
    }
  };

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
        <button
          type="button"
          onClick={() => handleToggleJoin(!joinCluster)}
          className="shrink-0 flex items-center"
          aria-label={joinCluster ? "Disable cluster" : "Enable cluster"}
        >
          {joinCluster
            ? <ToggleRight className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
            : <ToggleLeft className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />}
        </button>
      </div>
      {joinCluster && (
        <div className="space-y-3">
          {clusters.map((cluster) => (
            <button
              key={cluster.id}
              onClick={() => handleSelectCluster(cluster.id)}
              className="w-full rounded-lg p-3 text-left transition-all"
              style={{
                background: data.clusterId === cluster.id ? "rgba(var(--neon-purple-rgb),0.1)" : "var(--surface)",
                border: `1px solid ${data.clusterId === cluster.id ? "rgba(var(--neon-purple-rgb),0.5)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
              }}
            >
              <p className="text-sm font-medium" style={{ color: data.clusterId === cluster.id ? "var(--neon-purple)" : "var(--text-primary)" }}>{cluster.name}</p>
            </button>
          ))}

          {/* Create new cluster inline */}
          <div className="rounded-lg p-3 space-y-2" style={{ background: "var(--surface)", border: "1px dashed rgba(var(--neon-purple-rgb),0.2)" }}>
            <p className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Create a new cluster</p>
            <div className="flex gap-2">
              <Input
                value={newClusterName}
                onChange={(e) => setNewClusterName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateCluster()}
                placeholder="Cluster name"
                className="text-sm"
                style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-primary)" }}
              />
              <Button
                size="sm" variant="outline"
                disabled={!newClusterName.trim() || creating}
                onClick={handleCreateCluster}
                style={{ borderColor: "rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)", background: "rgba(var(--neon-purple-rgb),0.05)" }}
              >
                {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Create"}
              </Button>
            </div>
          </div>

          {data.clusterId && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs" style={{ background: "rgba(var(--neon-purple-rgb),0.06)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--neon-purple)" }} />
              <p style={{ color: "var(--text-muted)" }}>
                <strong style={{ color: "var(--text-primary)" }}>NoTransferFromFiltering</strong> has been automatically enabled to isolate this cluster from other servers.
              </p>
            </div>
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
  { value: "0 3 * * *",    label: "Daily at 3:00 AM" },
  { value: "0 6 * * *",    label: "Daily at 6:00 AM" },
  { value: "0 0 * * *",    label: "Daily at midnight" },
  { value: "0 */6 * * *",  label: "Every 6 hours" },
  { value: "0 */12 * * *", label: "Every 12 hours" },
  { value: "0 * * * *",    label: "Every hour" },
  { value: "0 */2 * * *",  label: "Every 2 hours" },
];

function CronSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select
      value={CRON_OPTIONS.find((o) => o.value === value) ? value : "custom"}
      onChange={(e) => onChange(e.target.value === "custom" ? value : e.target.value)}
      className="w-full text-xs rounded px-2 py-1.5 font-mono"
      style={{ background: "var(--surface)", border: "1px solid rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-primary)", outline: "none" }}
    >
      {CRON_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      <option value="custom">Custom…</option>
    </select>
  );
}

const WIZ_TIER_ORDER = ["M", "W", "D", "H"] as const;
type WizTier = typeof WIZ_TIER_ORDER[number];
const WIZ_TIER_LABEL: Record<WizTier, string> = { M: "monthly", W: "weekly", D: "daily", H: "hourly" };

function wizBackupEffectiveCron(tiers: WizardData["serverBackupTiers"]): string {
  if (tiers.H.enabled) return "0 * * * *";
  if (tiers.D.enabled) return "0 2 * * *";
  if (tiers.W.enabled) return "0 3 * * 0";
  if (tiers.M.enabled) return "0 4 1 * *";
  return "0 * * * *";
}

function WizTierRow({
  tier,
  state,
  onChange,
}: {
  tier: WizTier;
  state: { enabled: boolean; keep: number };
  onChange: (patch: { enabled?: boolean; keep?: number }) => void;
}) {
  return (
    <div
      className="flex items-center gap-3 px-3 py-2 rounded-lg"
      style={{
        background: "rgba(255,255,255,0.02)",
        border: `1px solid ${state.enabled ? "rgba(var(--neon-purple-rgb),0.3)" : "rgba(255,255,255,0.05)"}`,
      }}
    >
      <Input
        type="number" min={1} max={999} value={state.keep}
        onChange={(e) => onChange({ keep: Math.max(1, parseInt(e.target.value, 10) || 1) })}
        className="w-16 h-8 text-sm text-center shrink-0"
        style={{
          background: "var(--surface)",
          border: `1px solid ${state.enabled ? "rgba(var(--neon-purple-rgb),0.35)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
          color: "var(--text-primary)",
        }}
      />
      <span className="flex-1 text-sm" style={{ color: "var(--text-muted)" }}>
        {WIZ_TIER_LABEL[tier]} backups to keep
      </span>
      <button type="button" onClick={() => onChange({ enabled: !state.enabled })} className="cursor-pointer shrink-0">
        {state.enabled
          ? <ToggleRight className="w-6 h-6" style={{ color: "var(--neon-purple)" }} />
          : <ToggleLeft  className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
        }
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Launch Parameters Step
// ---------------------------------------------------------------------------

const LAUNCH_PARAM_CATEGORY_LABELS: Record<string, string> = {
  performance: "Performance & Anti-Cheat",
  admin:       "Admin & Logging",
  gameplay:    "Gameplay",
  access:      "Access Control",
  cluster:     "Cluster",
  network:     "Network",
};

// Keys shown in guided paths (NoBattlEye + ForceAllowCaveFlyers are in Game Mode; crossplay in Network)
const GUIDED_LAUNCH_KEYS = new Set([
  "DisableUndermeshChecking",
  "DisableUndermeshKilling",
  "culture",
  "servergamelog",
  "ServerRCONOutputTribeLogs",
  "servergamelogincludetribelogs",
  "EnableIdlePlayerKick",
  "AutoDestroyStructures",
  "DisableCustomCosmetics",
]);

// NoBattlEye and ForceAllowCaveFlyers are always in Game Mode — hidden from Launch Args entirely
const GAME_MODE_KEYS = new Set(["NoBattlEye", "ForceAllowCaveFlyers"]);

const CULTURE_OPTIONS = [
  { value: "",    label: "None (server default)" },
  { value: "en",  label: "English (en)" },
  { value: "de",  label: "German (de)" },
  { value: "fr",  label: "French (fr)" },
  { value: "es",  label: "Spanish (es)" },
  { value: "it",  label: "Italian (it)" },
  { value: "ja",  label: "Japanese (ja)" },
  { value: "ko",  label: "Korean (ko)" },
  { value: "pt",  label: "Portuguese (pt)" },
  { value: "ru",  label: "Russian (ru)" },
  { value: "zh",  label: "Chinese Simplified (zh)" },
];

function LaunchParamsStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const args = data.launchArgs;
  const isFullCustom = data.presetStyle === "full_custom";

  const setArg = (key: string, value: string) =>
    onChange({ launchArgs: { ...args, [key]: value } });

  const categories = ["performance", "admin", "gameplay", "access"] as const;

  return (
    <TooltipProvider>
      <div className="space-y-4">
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Command-line arguments passed when starting the server. These cannot be set in INI files.
          {!isFullCustom && " Showing commonly-used parameters — all others can be set from the Config tab after setup."}
        </p>
        <div className="space-y-3 pr-1">
          {categories.map((cat) => {
            const allParams = LAUNCH_PARAMETERS.filter((p: LaunchParameter) => p.category === cat);
            const params = allParams.filter((p: LaunchParameter) => {
              if (GAME_MODE_KEYS.has(p.key)) return false;
              if (!isFullCustom && !GUIDED_LAUNCH_KEYS.has(p.key)) return false;
              return true;
            });
            if (params.length === 0) return null;
            return (
              <div key={cat} className="rounded-lg overflow-hidden" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}>
                <div className="px-3 py-2" style={{ background: "var(--surface-elevated)" }}>
                  <p className="text-xs font-semibold" style={{ color: "var(--neon-purple)" }}>
                    {LAUNCH_PARAM_CATEGORY_LABELS[cat]}
                  </p>
                </div>
                <div className="p-3 space-y-2.5" style={{ background: "var(--surface)" }}>
                  {params.map((p: LaunchParameter) => {
                    const val = args[p.key] ?? String(p.defaultValue ?? "");

                    // Culture: render as dropdown
                    if (p.key === "culture") {
                      return (
                        <div key={p.key} className="space-y-1">
                          <div className="flex items-center gap-1.5">
                            <p className="text-xs font-medium font-mono" style={{ color: "var(--text-primary)" }}>{p.flag}</p>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <HelpCircle className="w-3 h-3 cursor-help shrink-0" style={{ color: "var(--neon-purple)" }} />
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs text-xs leading-snug">{p.description}</TooltipContent>
                            </Tooltip>
                          </div>
                          <select
                            value={val}
                            onChange={(e) => setArg(p.key, e.target.value)}
                            className="w-full text-xs rounded px-2 py-1.5"
                            style={{ background: "var(--surface)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)", outline: "none" }}
                          >
                            {CULTURE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </div>
                      );
                    }

                    if (p.type === "boolean") {
                      const on = val === "true" || val === "1";
                      return (
                        <div key={p.key} className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <p className="text-xs font-medium font-mono truncate" style={{ color: "var(--text-primary)" }}>{p.flag}</p>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <HelpCircle className="w-3 h-3 cursor-help shrink-0" style={{ color: "var(--neon-purple)" }} />
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs text-xs leading-snug">{p.description}</TooltipContent>
                            </Tooltip>
                          </div>
                          <button
                            type="button"
                            onClick={() => setArg(p.key, on ? "false" : "true")}
                            className="shrink-0 flex items-center"
                            aria-label={on ? "Disable" : "Enable"}
                          >
                            {on
                              ? <ToggleRight className="w-7 h-7" style={{ color: "var(--neon-purple)" }} />
                              : <ToggleLeft className="w-7 h-7" style={{ color: "var(--text-subtle)" }} />}
                          </button>
                        </div>
                      );
                    }

                    return (
                      <div key={p.key} className="space-y-1">
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs font-medium font-mono" style={{ color: "var(--text-primary)" }}>{p.flag}</p>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <HelpCircle className="w-3 h-3 cursor-help shrink-0" style={{ color: "var(--neon-purple)" }} />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs text-xs leading-snug">{p.description}</TooltipContent>
                          </Tooltip>
                        </div>
                        <Input
                          value={val}
                          placeholder={String(p.defaultValue ?? "") || "(empty = disabled)"}
                          onChange={(e) => setArg(p.key, e.target.value)}
                          className="h-7 text-xs font-mono"
                          style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Automation Step
// ---------------------------------------------------------------------------

function AutomationStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const patchServerTier = (tier: WizTier, patch: { enabled?: boolean; keep?: number }) =>
    onChange({ serverBackupTiers: { ...data.serverBackupTiers, [tier]: { ...data.serverBackupTiers[tier], ...patch } } });
  const patchPlayerTier = (tier: WizTier, patch: { enabled?: boolean; keep?: number }) =>
    onChange({ playerBackupTiers: { ...data.playerBackupTiers, [tier]: { ...data.playerBackupTiers[tier], ...patch } } });

  return (
    <div className="space-y-4">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Configure automation schedules. All times are in your local timezone.
      </p>

      {/* ── Backup Schedules ─────────────────────────────────────── */}
      <div className="glass-card rounded-xl p-4 space-y-5"
        style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "rgba(var(--neon-purple-rgb),0.08)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
            <HardDrive className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
          </div>
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Backup Schedules</p>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              TimeShift — each tier keeps its own independent rotation
            </p>
          </div>
        </div>

        <div className="space-y-5 border-t pt-4" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.08)" }}>
          {/* Server Backups */}
          <div className="space-y-2">
            <p className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Server Backups</p>
            {WIZ_TIER_ORDER.map((tier) => (
              <WizTierRow key={tier} tier={tier} state={data.serverBackupTiers[tier]} onChange={(p) => patchServerTier(tier, p)} />
            ))}
          </div>

          <div className="border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }} />

          {/* Player Backups */}
          <div className="space-y-2">
            <p className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Player Backups</p>
            {WIZ_TIER_ORDER.map((tier) => (
              <WizTierRow key={tier} tier={tier} state={data.playerBackupTiers[tier]} onChange={(p) => patchPlayerTier(tier, p)} />
            ))}
          </div>

          {/* Login backup keep */}
          <div
            className="flex items-center gap-3 px-3 py-2 rounded-lg"
            style={{
              background: "rgba(255,255,255,0.02)",
              border: `1px solid ${data.loginBackupEnabled ? "rgba(var(--neon-purple-rgb),0.3)" : "rgba(255,255,255,0.05)"}`,
            }}
          >
            <Input type="number" min={1} max={999} value={data.loginBackupKeep}
              onChange={(e) => onChange({ loginBackupKeep: Math.max(1, parseInt(e.target.value, 10) || 1) })}
              className="w-16 h-8 text-sm text-center shrink-0"
              style={{
                background: "var(--surface)",
                border: `1px solid ${data.loginBackupEnabled ? "rgba(var(--neon-purple-rgb),0.35)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
                color: "var(--text-primary)",
              }} />
            <div className="flex-1 min-w-0">
              <span className="text-sm" style={{ color: "var(--text-muted)" }}>login backups to keep</span>
              <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)", opacity: 0.6 }}>
                Triggered when a player connects. Independent rotation.
              </p>
            </div>
            <button type="button" onClick={() => onChange({ loginBackupEnabled: !data.loginBackupEnabled })} className="cursor-pointer shrink-0">
              {data.loginBackupEnabled
                ? <ToggleRight className="w-6 h-6" style={{ color: "var(--neon-purple)" }} />
                : <ToggleLeft  className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
              }
            </button>
          </div>

          {/* Manual backup keep */}
          <div
            className="flex items-center gap-3 px-3 py-2 rounded-lg"
            style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}
          >
            <Input type="number" min={1} max={999} value={data.manualBackupKeep}
              onChange={(e) => onChange({ manualBackupKeep: Math.max(1, parseInt(e.target.value, 10) || 1) })}
              className="w-16 h-8 text-sm text-center shrink-0"
              style={{ background: "var(--surface)", border: "1px solid rgba(var(--neon-purple-rgb),0.35)", color: "var(--text-primary)" }} />
            <div className="flex-1 min-w-0">
              <span className="text-sm" style={{ color: "var(--text-muted)" }}>manual backups to keep</span>
              <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)", opacity: 0.6 }}>
                Applies to on-demand backups triggered by the Backup Now buttons.
              </p>
            </div>
          </div>

          <div className="border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }} />

          {/* Full backup */}
          <div className="space-y-2">
            <p className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Full Backups</p>
            <div
              className="flex items-center gap-3 px-3 py-2 rounded-lg"
              style={{
                background: "rgba(255,255,255,0.02)",
                border: `1px solid ${data.fullBackupEnabled ? "rgba(var(--neon-purple-rgb),0.3)" : "rgba(255,255,255,0.05)"}`,
              }}
            >
              <Input type="number" min={1} max={20} value={data.fullBackupKeep}
                onChange={(e) => onChange({ fullBackupKeep: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                className="w-16 h-8 text-sm text-center shrink-0"
                style={{
                  background: "var(--surface)",
                  border: `1px solid ${data.fullBackupEnabled ? "rgba(var(--neon-purple-rgb),0.35)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
                  color: "var(--text-primary)",
                }} />
              <span className="flex-1 text-sm" style={{ color: "var(--text-muted)" }}>full backups to keep</span>
              <button type="button" onClick={() => onChange({ fullBackupEnabled: !data.fullBackupEnabled })} className="cursor-pointer shrink-0">
                {data.fullBackupEnabled
                  ? <ToggleRight className="w-6 h-6" style={{ color: "var(--neon-purple)" }} />
                  : <ToggleLeft  className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
                }
              </button>
            </div>
            <p className="text-xs px-1" style={{ color: "var(--text-muted)" }}>
              Zips the entire install folder — runs monthly on the 1st at 3am.
            </p>
          </div>
        </div>
      </div>

      {/* ── Pre-backup message ──────────────────────────────────── */}
      <div className="glass-card rounded-xl p-4 space-y-3"
        style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}>
        <div className="flex items-center gap-2">
          <MessageSquare className="w-3.5 h-3.5" style={{ color: "var(--neon-purple)" }} />
          <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Pre-Backup In-Game Message</p>
        </div>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Broadcast this message via RCON before each scheduled backup begins.
        </p>
        <Input
          value={data.backupBroadcastMessage}
          onChange={(e) => onChange({ backupBroadcastMessage: e.target.value })}
          placeholder="Backup in progress — lag may occur."
          className="text-xs"
          style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-primary)" }}
        />
      </div>

      {/* ── Auto-Restart ─────────────────────────────────────────── */}
      <div className="glass-card rounded-xl p-4 space-y-3"
        style={{ border: `1px solid ${data.autoRestart ? "rgba(var(--neon-purple-rgb),0.3)" : "rgba(var(--neon-purple-rgb),0.12)"}` }}>
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: data.autoRestart ? "rgba(var(--neon-purple-rgb),0.1)" : "rgba(255,255,255,0.04)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
            <RotateCcw className="w-4 h-4" style={{ color: data.autoRestart ? "var(--neon-purple)" : "var(--text-muted)" }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Auto-Restart</p>
              <button type="button" onClick={() => onChange({ autoRestart: !data.autoRestart })} className="cursor-pointer shrink-0">
                {data.autoRestart
                  ? <ToggleRight className="w-6 h-6" style={{ color: "var(--neon-purple)" }} />
                  : <ToggleLeft  className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
                }
              </button>
            </div>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              Gracefully restart the server on a schedule with optional in-game warnings.
            </p>
          </div>
        </div>
        {data.autoRestart && (
          <div className="space-y-3 pt-1 border-t" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.1)" }}>
            <CronSelect value={data.autoRestartCron} onChange={(v) => onChange({ autoRestartCron: v })} />
            {/* Warn players toggle */}
            <div className="flex items-center justify-between px-1 py-2 rounded-lg gap-3"
              style={{ background: "rgba(var(--neon-purple-rgb),0.04)", border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}>
              <div className="flex items-center gap-1.5">
                <span className="text-sm" style={{ color: "var(--text-primary)" }}>Warn Players Before Restart</span>
                <TooltipProvider><Tooltip><TooltipTrigger asChild>
                  <HelpCircle className="w-3 h-3 cursor-help shrink-0" style={{ color: "var(--neon-purple)" }} />
                </TooltipTrigger><TooltipContent className="max-w-xs text-xs">Broadcasts an in-game RCON message to all players before the restart happens.</TooltipContent></Tooltip></TooltipProvider>
              </div>
              <button type="button" onClick={() => onChange({ autoRestartWarnPlayers: !data.autoRestartWarnPlayers })} className="cursor-pointer shrink-0">
                {data.autoRestartWarnPlayers
                  ? <ToggleRight className="w-7 h-7" style={{ color: "var(--neon-purple)" }} />
                  : <ToggleLeft  className="w-7 h-7" style={{ color: "var(--text-subtle)" }} />}
              </button>
            </div>
            {data.autoRestartWarnPlayers && (
              <>
                {/* Warning minutes */}
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>Warn</span>
                    <TooltipProvider><Tooltip><TooltipTrigger asChild>
                      <HelpCircle className="w-3 h-3 cursor-help" style={{ color: "var(--neon-purple)" }} />
                    </TooltipTrigger><TooltipContent className="max-w-xs text-xs">How many minutes before the restart the warning message is broadcast.</TooltipContent></Tooltip></TooltipProvider>
                  </div>
                  <div className="w-24">
                    <NumberField value={data.autoRestartWarnMinutes} onChange={(v) => onChange({ autoRestartWarnMinutes: v })} min={1} max={60} step={1} defaultValue={15} />
                  </div>
                  <span className="text-xs shrink-0" style={{ color: "var(--text-muted)" }}>minutes before restart</span>
                </div>
                {/* Warning message */}
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>Warning Message</span>
                    <TooltipProvider><Tooltip><TooltipTrigger asChild>
                      <HelpCircle className="w-3 h-3 cursor-help" style={{ color: "var(--neon-purple)" }} />
                    </TooltipTrigger><TooltipContent className="max-w-xs text-xs">Use {"{minutes}"} as a placeholder for the countdown value in the message.</TooltipContent></Tooltip></TooltipProvider>
                  </div>
                  <Input
                    value={data.autoRestartMessage}
                    onChange={(e) => onChange({ autoRestartMessage: e.target.value })}
                    placeholder="Server restarting in {minutes} minutes…"
                    className="text-xs"
                    style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-primary)" }}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Wild Dino Wipe ───────────────────────────────────────── */}
      <div className="glass-card rounded-xl p-4 space-y-3"
        style={{ border: `1px solid ${data.wipeDinosEnabled ? "rgba(var(--neon-purple-rgb),0.3)" : "rgba(var(--neon-purple-rgb),0.12)"}` }}>
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: data.wipeDinosEnabled ? "rgba(var(--neon-purple-rgb),0.1)" : "rgba(255,255,255,0.04)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
            <Skull className="w-4 h-4" style={{ color: data.wipeDinosEnabled ? "var(--neon-purple)" : "var(--text-muted)" }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Wild Dino Wipe</p>
              <button type="button" onClick={() => onChange({ wipeDinosEnabled: !data.wipeDinosEnabled })} className="cursor-pointer shrink-0">
                {data.wipeDinosEnabled
                  ? <ToggleRight className="w-6 h-6" style={{ color: "var(--neon-purple)" }} />
                  : <ToggleLeft  className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
                }
              </button>
            </div>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              Broadcast a chat warning then destroy all wild dinos via RCON on a schedule.
            </p>
          </div>
        </div>
        {data.wipeDinosEnabled && (
          <div className="pt-1 border-t" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.1)" }}>
            <CronSelect value={data.wipeDinosCron} onChange={(v) => onChange({ wipeDinosCron: v })} />
          </div>
        )}
      </div>

      {/* ── Auto-Update note ─────────────────────────────────────── */}
      <div className="flex gap-2.5 rounded-lg px-3 py-2.5"
        style={{ background: "rgba(var(--neon-purple-rgb),0.04)", border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}>
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "var(--neon-purple)" }} />
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          <strong style={{ color: "var(--text-primary)" }}>Auto-Update</strong> is configured per-server in the Automation tab after setup.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mods Step
// ---------------------------------------------------------------------------

function ModsStep({ data, onChange }: { data: WizardData; onChange: (patch: Partial<WizardData>) => void }) {
  const allMaps = useAllMaps();
  const [input, setInput] = useState("");
  // Shared ["servers"] cache — see GameModeStep for why this isn't its own effect.
  const { data: existingServers = [] } = useQuery({ queryKey: ["servers"], queryFn: getServers });
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const copyMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOut(e: MouseEvent) {
      if (copyMenuRef.current && !copyMenuRef.current.contains(e.target as Node)) {
        setCopyMenuOpen(false);
      }
    }
    if (copyMenuOpen) document.addEventListener("mousedown", onClickOut);
    return () => document.removeEventListener("mousedown", onClickOut);
  }, [copyMenuOpen]);

  const modBrowserOpen      = useAppStore((s) => s.modBrowserOpen);
  const setModBrowserOpen   = useAppStore((s) => s.setModBrowserOpen);
  const setModBrowserParams = useAppStore((s) => s.setModBrowserParams);
  const modBrowserJustClosed    = useAppStore((s) => s.modBrowserJustClosed);
  const setModBrowserJustClosed = useAppStore((s) => s.setModBrowserJustClosed);

  // Listen for mod browser "add" events. ModBrowserEventHandler skips DB writes
  // for serverId="wizard-temp", so we handle wizard state directly here.
  useTauriEvent<unknown>("mod://add-to-server", (raw) => {
    try {
      const event = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        serverId: string;
        modId: string;
        modName: string;
        source?: string;
      };
      if (event.serverId !== "wizard-temp") return;
      const id = event.modId?.trim();
      if (!id || data.modIds.includes(id)) return;
      onChange({
        modIds: [...data.modIds, id],
        modNames: { ...data.modNames, [id]: event.modName?.trim() || "Unknown Mod" },
      });
    } catch { /* malformed payload — ignore */ }
  });

  useEffect(() => {
    if (modBrowserJustClosed) setModBrowserJustClosed(false);
  }, [modBrowserJustClosed, setModBrowserJustClosed]);

  const handleOpenBrowser = async () => {
    if (modBrowserOpen) {
      try { await tauriCmd.closeModBrowser(); } catch { /* not in Tauri */ }
      return;
    }
    setModBrowserParams({
      serverId: "wizard-temp",
      serverName: "New Server (Wizard)",
      addedModIds: data.modIds,
    });
    try {
      await tauriCmd.openModBrowser("wizard-temp", "New Server (Wizard)", data.modIds);
      setModBrowserOpen(true);
    } catch (e) {
      console.error("Failed to open mod browser", e);
      setModBrowserParams(null);
    }
  };

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

  const selectedMap = allMaps.find((m) => m.id === data.mapId);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Add mods by ID or browse CurseForge.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          {existingServers.length > 0 && (
            <div className="relative" ref={copyMenuRef}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5"
                style={{ borderColor: "rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)", background: "rgba(var(--neon-purple-rgb),0.05)" }}
                onClick={() => setCopyMenuOpen((v) => !v)}
              >
                <Plus className="w-3.5 h-3.5" />
                Copy Mods from Server
              </Button>
              {copyMenuOpen && (
                <div
                  className="absolute right-0 top-full mt-1 z-50 rounded-lg overflow-hidden min-w-[200px]"
                  style={{ background: "var(--popover)", border: "1px solid rgba(var(--neon-purple-rgb),0.3)", boxShadow: "0 8px 32px rgba(0,0,0,0.7)" }}
                >
                  <div className="py-1">
                    {existingServers.map((s) => (
                      <button
                        key={s.id}
                        onClick={async () => {
                          const srcMods = await getServerMods(s.id);
                          const newIds = srcMods.map((m) => m.mod_id).filter((id) => !data.modIds.includes(id));
                          const newNames = { ...data.modNames };
                          for (const m of srcMods) newNames[m.mod_id] = m.mod_name;
                          onChange({ modIds: [...data.modIds, ...newIds], modNames: newNames });
                          setCopyMenuOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[rgba(var(--neon-purple-rgb),0.08)]"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            style={{ borderColor: "rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)", background: "rgba(var(--neon-purple-rgb),0.05)" }}
            onClick={handleOpenBrowser}
          >
            <Globe className="w-3.5 h-3.5" />
            {modBrowserOpen ? "Close Browser" : "Browse Mods"}
          </Button>
        </div>
      </div>

      {selectedMap?.isMod && selectedMap.requiredModId && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs" style={{ background: "rgba(var(--neon-purple-rgb),0.06)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
          <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--neon-purple)" }} />
          <p style={{ color: "var(--neon-purple)" }}>
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
          style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-primary)" }}
        />
        <Button
          onClick={addMod}
          variant="outline"
          size="sm"
          className="gap-1 shrink-0"
          style={{ borderColor: "rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)", background: "rgba(var(--neon-purple-rgb),0.05)" }}
        >
          <Plus className="w-4 h-4" /> Add
        </Button>
      </div>

      {data.modIds.length === 0 ? (
        <div className="rounded-lg p-4 text-center" style={{ background: "rgba(var(--neon-purple-rgb),0.04)", border: "1px dashed rgba(var(--neon-purple-rgb),0.2)" }}>
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
                  background: locked ? "rgba(var(--neon-purple-rgb),0.05)" : "rgba(10,10,30,0.6)",
                  border: `1px solid ${locked ? "rgba(var(--neon-purple-rgb),0.2)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: "var(--text-subtle)" }}>#{i + 1}</span>
                  {locked && <Lock className="w-3 h-3" style={{ color: "var(--neon-cyan)" }} />}
                  <span className="text-sm font-mono" style={{ color: locked ? "var(--neon-cyan)" : "var(--text-primary)" }}>{id}</span>
                  {locked && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(var(--neon-purple-rgb),0.1)", color: "var(--neon-cyan)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>Map Mod</span>}
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
  onInstallComplete,
  onGoToDashboard,
  onStatusChange,
  onCleanupReady,
  onBackgroundReady,
}: {
  data: WizardData;
  serverId: string;
  onInstallComplete: () => void;
  onGoToDashboard: () => void;
  onStatusChange: (status: string) => void;
  onCleanupReady: (fn: () => Promise<void>) => void;
  /** Exposes a way for the parent (top-bar close button) to trigger the same
   *  "continue in background" behavior as the in-panel button, so closing
   *  mid-install can offer that as an explicit, confirmed choice instead of
   *  silently doing it. */
  onBackgroundReady: (fn: () => void) => void;
}) {
  const allMaps = useAllMaps();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"idle" | "installing" | "done" | "error">("idle");
  const [canceled, setCanceled] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const dbSavedRef = useRef(false);
  const installPathRef = useRef("");
  const steamcmdPathRef = useRef("");
  const cacheDirRef = useRef("");
  const baseDirRef = useRef("");
  const terminalRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const backgroundRef = useRef(false);
  const queryClientRef = useRef(queryClient);

  const scrollToBottom = useCallback(() => {
    sentinelRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  useEffect(() => { onStatusChange(status); }, [status, onStatusChange]);
  useEffect(() => { onBackgroundReady(() => { backgroundRef.current = true; }); }, [onBackgroundReady]);
  useEffect(() => { if (status !== "idle") setTimeout(scrollToBottom, 100); }, [status, scrollToBottom]);
  useEffect(() => {
    if (!terminalRef.current) return;
    const ro = new ResizeObserver(scrollToBottom);
    ro.observe(terminalRef.current);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  const selectedMap = allMaps.find((m) => m.id === data.mapId);
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
    { label: "Auto-Restart",     value: data.autoRestart ? humanCron(data.autoRestartCron) : "Disabled" },
    { label: "Server Backups",   value: WIZ_TIER_ORDER.some((t) => data.serverBackupTiers[t].enabled) ? WIZ_TIER_ORDER.filter((t) => data.serverBackupTiers[t].enabled).map((t) => WIZ_TIER_LABEL[t]).join(", ") : "Disabled" },
    { label: "Player Backups",   value: WIZ_TIER_ORDER.some((t) => data.playerBackupTiers[t].enabled) ? WIZ_TIER_ORDER.filter((t) => data.playerBackupTiers[t].enabled).map((t) => WIZ_TIER_LABEL[t]).join(", ") : "Disabled" },
    { label: "Dino Wipe",        value: data.wipeDinosEnabled ? humanCron(data.wipeDinosCron) : "Disabled" },
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
      if (data.motdMessage.trim()) {
        result.MessageOfTheDay = { Message: data.motdMessage.trim(), Duration: String(data.motdDuration) };
      } else {
        delete result.MessageOfTheDay;
      }
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
        ResourcesRespawnPeriodMultiplier: r.resourceRespawnMultiplier,
        PlayerDamageMultiplier: r.playerDamageMultiplier,
        NightTimeSpeedScale: r.nightSpeedMultiplier,
        OverrideOfficialDifficulty: r.wildDinoMaxLevel / 30,
        DifficultyOffset: 1.0,
      };
    }

    // PvE flag applied to preset config base
    if (data.gameMode === "pve") {
      config = { ...config, AllowFlyerCarryPvE: data.flyerCarryPvE };
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

    const isNamedPreset = !["guided_custom", "full_custom"].includes(data.presetStyle);

    // ── Settings shared across all named presets ──────────────────────────────
    if (isNamedPreset) {
      serverSettings.DinoCountMultiplier = "1.0";
      serverSettings.MaxTamedDinos = "5000";
    }

    // ── PvE mode additions ────────────────────────────────────────────────────
    if (data.gameMode === "pve") {
      serverSettings.ServerPVE = "True";
    }

    // ── Official preset ───────────────────────────────────────────────────────
    if (data.presetStyle === "official") {
      serverSettings.MaxPersonalTamedDinos = data.gameMode === "pvp" ? "300" : "500";
      serverSettings.NPCNetworkStasisRangeScalePlayerCountStart = "24";
      serverSettings.NPCNetworkStasisRangeScalePlayerCountEnd = "70";
      serverSettings.NPCNetworkStasisRangeScalePercentEnd = "0.5";
      serverSettings.BanListURL = "http://arkdedicated.com/banlist.txt";
      if (data.gameMode === "pve") {
        serverSettings.OnlyAutoDestroyCoreStructures = "True";
        serverSettings.AutoDestroyDecayedDinos = "True";
      }
    }

    // ── Casual preset ─────────────────────────────────────────────────────────
    if (data.presetStyle === "casual") {
      serverSettings.MaxPersonalTamedDinos = "500";
      serverSettings.AllowFlyingStaminaRecovery = "True";
      serverSettings.HarvestHealthMultiplier = "2.0";
      if (data.gameMode === "pve") {
        serverSettings.DisableStructureDecayPvE = "True";
        serverSettings.DisableDinoDecayPvE = "True";
        serverSettings.AutoDestroyDecayedDinos = "False";
        serverSettings.GlobalSpoilingTimeMultiplier = "2.0"; // PvE wants 2.0; PvP stays at 1.5 from preset
      }
    }

    // ── Boosted preset ────────────────────────────────────────────────────────
    if (data.presetStyle === "boosted") {
      // Taming rate differs by mode — PRESET_STYLES has a generic 10× which we override here
      serverSettings.TamingSpeedMultiplier = data.gameMode === "pvp" ? "15.0" : "25.0";
      serverSettings.MaxPersonalTamedDinos = "500";
      serverSettings.AllowFlyingStaminaRecovery = "True";
      serverSettings.HarvestHealthMultiplier = "2.0";
      serverSettings.GlobalItemDecompositionTimeMultiplier = data.gameMode === "pve" ? "3.0" : "2.0";
      if (data.gameMode === "pve") {
        serverSettings.DisableStructureDecayPvE = "True";
        serverSettings.DisableDinoDecayPvE = "True";
        serverSettings.AutoDestroyDecayedDinos = "False";
        serverSettings.GlobalSpoilingTimeMultiplier = "3.0"; // PvE wants 3.0; PvP stays at 2.0 from preset
      }
    }

    // ── Guided custom — all settings applied directly to serverSettings ────────
    if (data.presetStyle === "guided_custom") {
      const r = data.guidedRates;
      serverSettings.HarvestHealthMultiplier          = String(r.harvestHealthMultiplier);
      serverSettings.PlayerResistanceMultiplier        = String(r.playerResistanceMultiplier);
      serverSettings.DinoCountMultiplier               = "1.0";
      serverSettings.DinoDamageMultiplier              = String(r.dinoDamageMultiplier);
      serverSettings.DinoResistanceMultiplier          = String(r.dinoResistanceMultiplier);
      serverSettings.TamedDinoDamageMultiplier         = String(r.tamedDinoDamageMultiplier);
      serverSettings.TamedDinoResistanceMultiplier     = String(r.tamedDinoResistanceMultiplier);
      serverSettings.StructureDamageMultiplier         = String(r.structureDamageMultiplier);
      serverSettings.StructureResistanceMultiplier     = String(r.structureResistanceMultiplier);
      serverSettings.MaxTamedDinos                     = "5000";
      serverSettings.MaxPersonalTamedDinos             = "500";
      serverSettings.GlobalSpoilingTimeMultiplier      = String(r.globalSpoilingTimeMultiplier);
      serverSettings.GlobalItemDecompositionTimeMultiplier = String(r.globalItemDecompMultiplier);
      serverSettings.AllowFlyingStaminaRecovery        = r.allowFlyingStaminaRecovery ? "True" : "False";
      serverSettings.AutoSavePeriodMinutes             = "15.0";

      if (data.gameMode === "pve") {
        serverSettings.ServerPVE = "True";
      }
    }

    // ── Game Mode general settings override (applied last for all non-full_custom presets) ──
    serverSettings.AdminLogging                       = data.adminLogging ? "True" : "False";
    serverSettings.ServerCrosshair                   = data.serverCrosshair ? "True" : "False";
    serverSettings.ShowFloatingDamageText             = data.showDamageNumbers ? "True" : "False";
    serverSettings.ShowMapPlayerLocation              = data.showPlayerLocation ? "True" : "False";
    serverSettings.ForceAllStructureLocking           = data.forceAllStructureLocking ? "True" : "False";
    serverSettings.AlwaysAllowStructurePickup         = data.alwaysAllowStructurePickup ? "True" : "False";
    serverSettings.DisableStructurePlacementCollision = data.disableStructurePlacementCollision ? "True" : "False";

    if (data.gameMode === "pve") {
      serverSettings.AllowFlyerCarryPvE              = data.flyerCarryPvE ? "True" : "False";
      serverSettings.AllowCaveBuildingPvE            = data.allowCaveBuildingPvE ? "True" : "False";
      serverSettings.PvEAllowStructuresAtSupplyDrops = data.pveAllowStructuresAtSupplyDrops ? "True" : "False";
      serverSettings.AllowCrateSpawnsOnTopOfStructures = data.allowCrateSpawnsOnTopOfStructures ? "True" : "False";
      serverSettings.DisableStructureDecayPvE        = data.disableStructureDecayPvE ? "True" : "False";
      serverSettings.DisableDinoDecayPvE             = data.disableDinoDecayPvE ? "True" : "False";
      // Auto-destroy decayed dinos only makes sense when decay is enabled
      serverSettings.AutoDestroyDecayedDinos         = data.disableStructureDecayPvE ? "False" : "True";
    }

    if (data.gameMode === "pvp") {
      serverSettings.PreventOfflinePvP = data.preventOfflinePvP ? "True" : "False";
      if (data.preventOfflinePvP) {
        serverSettings.PreventOfflinePvPInterval = String(data.preventOfflinePvPInterval);
      }
    }

    const result: Record<string, Record<string, string>> = {
      SessionSettings: sessionSettings,
      ServerSettings: serverSettings,
      // ASA reads MaxPlayers from this UE section, not [ServerSettings]
      "/Script/Engine.GameSession": { MaxPlayers: String(data.maxPlayers) },
    };
    if (data.motdMessage.trim()) {
      result.MessageOfTheDay = { Message: data.motdMessage.trim(), Duration: String(data.motdDuration) };
    }
    return result;
  };

  /** Build the Game.ini section map from wizard data */
  const buildGameIniJson = (): Record<string, Record<string, string>> => {
    const shooterMode: Record<string, string> = {};
    const isNamedPreset = !["guided_custom", "full_custom"].includes(data.presetStyle);

    // ── Friendly fire ─────────────────────────────────────────────────────────
    if (data.gameMode === "pve") {
      shooterMode.bDisableFriendlyFire = "True";
      shooterMode.bPvEDisableFriendlyFire = "True";
    } else if (!data.pvpFriendlyFire) {
      shooterMode.bDisableFriendlyFire = "True";
    }

    if (isNamedPreset) {
      // ── PvP-specific ────────────────────────────────────────────────────────
      if (data.gameMode === "pvp") {
        // Repeat-kill respawn penalty (all PvP named presets)
        shooterMode.bIncreasePvPRespawnInterval = "True";
        shooterMode.IncreasePvPRespawnIntervalBaseAmount = "60.0";
        shooterMode.IncreasePvPRespawnIntervalCheckPeriod = "300.0";
        shooterMode.IncreasePvPRespawnIntervalMultiplier = "2.0";
      }

      // ── PvE-specific ────────────────────────────────────────────────────────
      if (data.gameMode === "pve") {
        shooterMode.bPvEAllowTribeWar = "True";
      }

      // ── Turret limits (all named presets) ───────────────────────────────────
      shooterMode.bLimitTurretsInRange = "True";
      shooterMode.bHardLimitTurretsInRange = "True";
      shooterMode.LimitTurretsNum = "100";
      shooterMode.LimitTurretsRange = "10000";

      // ── Official: drop limits ───────────────────────────────────────────────
      if (data.presetStyle === "official") {
        shooterMode.LimitNonPlayerDroppedItemsCount = "600";
        shooterMode.LimitNonPlayerDroppedItemsRange = "1600";
      }

      // ── Boosted: speed leveling + unlimited respecs ─────────────────────────
      if (data.presetStyle === "boosted") {
        shooterMode.bAllowFlyerSpeedLeveling = "True";
        shooterMode.bAllowSpeedLeveling = "True";
        shooterMode.bAllowUnlimitedRespecs = "True";
      }

      // ── PvE casual: unlimited respecs ──────────────────────────────────────
      if (data.gameMode === "pve" && data.presetStyle === "casual") {
        shooterMode.bAllowUnlimitedRespecs = "True";
      }

      // ── PvE boosted: extra quality-of-life ────────────────────────────────
      if (data.gameMode === "pve" && data.presetStyle === "boosted") {
        shooterMode.bAllowPlatformSaddleMultiFloors = "True";
        shooterMode.LayEggIntervalMultiplier = "0.5";
        shooterMode.FuelConsumptionIntervalMultiplier = "2.0";
      }

      // ── Breeding by preset + mode ──────────────────────────────────────────
      const BREEDING: Record<string, Record<string, Record<string, string>>> = {
        casual: {
          pvp: {
            BabyMatureSpeedMultiplier: "5.0",
            EggHatchSpeedMultiplier: "5.0",
            BabyFoodConsumptionSpeedMultiplier: "5.0",
            BabyCuddleIntervalMultiplier: "0.5",
            BabyCuddleGracePeriodMultiplier: "2.0",
            MatingIntervalMultiplier: "0.5",
          },
          pve: {
            BabyMatureSpeedMultiplier: "10.0",
            EggHatchSpeedMultiplier: "10.0",
            BabyFoodConsumptionSpeedMultiplier: "5.0",
            BabyCuddleIntervalMultiplier: "0.3",
            BabyCuddleGracePeriodMultiplier: "2.0",
            BabyImprintAmountMultiplier: "2.0",
            MatingIntervalMultiplier: "0.25",
            MatingSpeedMultiplier: "2.0",
            GlobalCorpseDecompositionTimeMultiplier: "2.0",
          },
        },
        boosted: {
          pvp: {
            BabyMatureSpeedMultiplier: "30.0",
            EggHatchSpeedMultiplier: "30.0",
            BabyFoodConsumptionSpeedMultiplier: "1.0",
            BabyCuddleIntervalMultiplier: "0.1",
            BabyCuddleGracePeriodMultiplier: "2.0",
            MatingIntervalMultiplier: "0.1",
            MatingSpeedMultiplier: "2.0",
          },
          pve: {
            BabyMatureSpeedMultiplier: "50.0",
            EggHatchSpeedMultiplier: "50.0",
            BabyFoodConsumptionSpeedMultiplier: "0.5",
            BabyCuddleIntervalMultiplier: "0.1",
            BabyCuddleGracePeriodMultiplier: "5.0",
            BabyImprintAmountMultiplier: "4.0",
            MatingIntervalMultiplier: "0.05",
            MatingSpeedMultiplier: "2.0",
            GlobalCorpseDecompositionTimeMultiplier: "3.0",
          },
        },
      };
      const breedingEntry = BREEDING[data.presetStyle]?.[data.gameMode];
      if (breedingEntry) Object.assign(shooterMode, breedingEntry);

    } else if (data.presetStyle === "guided_custom") {
      const r = data.guidedRates;

      // Friendly fire (already set above for all PvE; guided PvP uses the toggle from page 2)
      // PvE tribe war
      if (data.gameMode === "pve") {
        shooterMode.bPvEAllowTribeWar = "True";
        shooterMode.GlobalCorpseDecompositionTimeMultiplier = String(r.globalCorpseDecompMultiplier);
      }

      // Breeding — all written to Game.ini where ASA actually reads them
      shooterMode.BabyMatureSpeedMultiplier            = String(r.matureSpeedMultiplier);
      shooterMode.EggHatchSpeedMultiplier              = String(r.hatchSpeedMultiplier);
      shooterMode.BabyFoodConsumptionSpeedMultiplier   = String(r.foodConsumptionMultiplier);
      shooterMode.MatingIntervalMultiplier             = String(r.matingIntervalMultiplier);
      shooterMode.MatingSpeedMultiplier                = String(r.matingSpeedMultiplier);
      shooterMode.BabyCuddleIntervalMultiplier         = String(r.cuddleIntervalMultiplier);
      shooterMode.BabyCuddleGracePeriodMultiplier      = String(r.cuddleGraceMultiplier);
      if (r.imprintAmountMultiplier !== 1.0) {
        shooterMode.BabyImprintAmountMultiplier = String(r.imprintAmountMultiplier);
      }

      // Speed leveling / respecs
      if (r.allowSpeedLeveling)      shooterMode.bAllowSpeedLeveling      = "True";
      if (r.allowFlyerSpeedLeveling) shooterMode.bAllowFlyerSpeedLeveling = "True";
      if (r.allowUnlimitedRespecs)   shooterMode.bAllowUnlimitedRespecs   = "True";

      // PvP respawn penalty
      if (data.gameMode === "pvp" && r.enableRespawnPenalty) {
        shooterMode.bIncreasePvPRespawnInterval              = "True";
        shooterMode.IncreasePvPRespawnIntervalBaseAmount     = "60.0";
        shooterMode.IncreasePvPRespawnIntervalCheckPeriod    = "300.0";
        shooterMode.IncreasePvPRespawnIntervalMultiplier     = "2.0";
      }

      // Turret limits
      if (r.enableTurretLimits) {
        shooterMode.bLimitTurretsInRange   = "True";
        shooterMode.bHardLimitTurretsInRange = "True";
        shooterMode.LimitTurretsNum        = "100";
        shooterMode.LimitTurretsRange      = "10000";
      }
    }

    return { "/script/shootergame.shootergamemode": shooterMode };
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
        installPath = `${baseDir}${sep}servers${sep}${serverId}`;
        steamcmdPath = scmdPath;
        cacheDirRef.current = `${baseDir}${sep}lokiasam${sep}cache${sep}asa-server`;

        // Determine combined preset ID for storage
        const presetId = (data.presetStyle === "guided_custom" || data.presetStyle === "full_custom")
          ? data.presetStyle
          : `${data.gameMode}_${data.presetStyle}`;

        baseDirRef.current = baseDir;

        await createServer({
          id: serverId,
          name: data.name,
          mapId: data.mapId,
          installPath,
          port: data.port,
          queryPort: data.queryPort,
          rconPort: data.rconPort,
          maxPlayers: data.maxPlayers,
          serverPassword: data.serverPassword || undefined,
          adminPassword: data.adminPassword,
          clusterId: data.clusterId || undefined,
          presetId,
        });
        await updateServerStatus(serverId, "installing", null);
        await saveServerConfig(serverId, "{}", "{}", "{}");

        // Write mods to DB. Map mod is locked; all others are normal.
        // Belt-and-suspenders: re-derive the selected map's required mod
        // here rather than trusting data.modIds/lockedModIds blindly — an
        // earlier step (e.g. "copy mods from server") could otherwise have
        // dropped it from wizard state before we ever get here.
        const selectedMap = allMaps.find((m) => m.id === data.mapId);
        const modIds = new Set(data.modIds);
        const lockedModIds = new Set(data.lockedModIds);
        if (selectedMap?.isMod && selectedMap.requiredModId) {
          modIds.add(selectedMap.requiredModId);
          lockedModIds.add(selectedMap.requiredModId);
        }
        for (const modId of modIds) {
          await addServerMod(
            serverId,
            modId,
            data.modNames[modId] || "Unknown Mod",
          );
          if (lockedModIds.has(modId)) {
            const { setModMapLock } = await import("@/lib/db");
            await setModMapLock(serverId, modId, true);
          }
        }

        if (data.activeEventId) {
          await setServerActiveEvent(serverId, data.activeEventId);
        }

        if (data.autoRestart) {
          const id = generateUUID();
          const restartCfg = JSON.stringify({
            broadcastWarning: data.autoRestartWarnPlayers,
            warningMinutes: data.autoRestartWarnMinutes,
            message: data.autoRestartMessage,
          });
          await createSchedule({ id, serverId, scheduleType: "restart", cronExpression: data.autoRestartCron, enabled: true, configJson: restartCfg });
          const nextIso = getNextCronDate(data.autoRestartCron)?.toISOString() ?? new Date().toISOString();
          await updateScheduleConfig(id, data.autoRestartCron, restartCfg, nextIso);
        }

        const buildTierConfig = (tiers: WizardData["serverBackupTiers"]) =>
          JSON.stringify({ hourly: tiers.H, daily: tiers.D, weekly: tiers.W, monthly: tiers.M });

        const serverAny = WIZ_TIER_ORDER.some((t) => data.serverBackupTiers[t].enabled);
        if (serverAny) {
          const cron = wizBackupEffectiveCron(data.serverBackupTiers);
          const cfg  = buildTierConfig(data.serverBackupTiers);
          const id   = generateUUID();
          await createSchedule({ id, serverId, scheduleType: "backup_server", cronExpression: cron, enabled: true, configJson: cfg });
          const nextIso = getNextCronDate(cron)?.toISOString() ?? new Date().toISOString();
          await updateScheduleConfig(id, cron, cfg, nextIso);
        }

        const playerAny = WIZ_TIER_ORDER.some((t) => data.playerBackupTiers[t].enabled);
        if (playerAny) {
          const cron = wizBackupEffectiveCron(data.playerBackupTiers);
          const cfg  = buildTierConfig(data.playerBackupTiers);
          const id   = generateUUID();
          await createSchedule({ id, serverId, scheduleType: "backup_player", cronExpression: cron, enabled: true, configJson: cfg });
          const nextIso = getNextCronDate(cron)?.toISOString() ?? new Date().toISOString();
          await updateScheduleConfig(id, cron, cfg, nextIso);
        }

        if (data.fullBackupEnabled) {
          const cron = "0 3 1 * *";
          const cfg  = JSON.stringify({ keep: data.fullBackupKeep });
          const id   = generateUUID();
          await createSchedule({ id, serverId, scheduleType: "backup_full", cronExpression: cron, enabled: true, configJson: cfg });
          const nextIso = getNextCronDate(cron)?.toISOString() ?? new Date().toISOString();
          await updateScheduleConfig(id, cron, cfg, nextIso);
        }

        if (data.loginBackupEnabled) {
          await setAppSetting(`login_backup_keep_${serverId}`, String(data.loginBackupKeep));
        }
        await setAppSetting(`manual_backup_keep_${serverId}`, String(data.manualBackupKeep));

        if (data.backupBroadcastMessage) {
          await updateBackupBroadcastMessage(serverId, data.backupBroadcastMessage);
        }

        if (data.wipeDinosEnabled) {
          const id = generateUUID();
          await createSchedule({ id, serverId, scheduleType: "wipe_dinos", cronExpression: data.wipeDinosCron, enabled: true, configJson: "{}" });
          const nextIso = getNextCronDate(data.wipeDinosCron)?.toISOString() ?? new Date().toISOString();
          await updateScheduleConfig(id, data.wipeDinosCron, "{}", nextIso);
        }

        installPathRef.current = installPath;
        steamcmdPathRef.current = steamcmdPath;
        dbSavedRef.current = true;

        queryClientRef.current.invalidateQueries({ queryKey: ["servers"] });

        onCleanupReady(async () => {
          if (dbSavedRef.current) {
            await deleteServerRecord(serverId).catch(() => {});
            dbSavedRef.current = false;
            useAppStore.getState().clearNoRetryServer(serverId);
            useAppStore.getState().setCountdown(serverId, null);
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
      const gameIniJson = buildGameIniJson();

      await tauriCmd.writeServerConfig(installPath, {
        gameUserSettings: gusJson,
        gameIni: gameIniJson,
        launchArgs: data.launchArgs,
      });

      await saveServerConfig(serverId, JSON.stringify(gusJson), JSON.stringify(gameIniJson), JSON.stringify(data.launchArgs));
      await updateServerStatus(serverId, "stopped", null);

      // Create SavedArks symlink/junction pointing to managed Saves/{serverId}/SavedArks/
      if (baseDirRef.current) {
        const { ensureMapsCacheLoaded, findMapById } = await import("@/lib/maps");
        await ensureMapsCacheLoaded().catch(() => {});
        const mapPath = findMapById(data.mapId)?.mapPath ?? "TheIsland_WP";

        await tauriCmd.createSaveLink(installPath, serverId, baseDirRef.current).catch((e) => {
          console.warn("createSaveLink failed (non-fatal):", e);
        });
        await tauriCmd.createModsSavesLink(installPath, serverId, baseDirRef.current, mapPath).catch((e) => {
          console.warn("createModsSavesLink failed (non-fatal):", e);
        });
      }

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
        // Without this, the server's DB row stays at status "installing"
        // indefinitely — the separate "Cancel Server Setup?" dialog's own
        // cleanup path does clean this up, but the in-panel Cancel Install
        // button (which lands here) previously didn't, leaving a phantom
        // "installing" row until the user also closed the wizard.
        await updateServerStatus(serverId, "install_failed", null).catch(() => {});
        queryClientRef.current.invalidateQueries({ queryKey: ["servers"] });
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
            <div key={label} className="flex items-center justify-between px-3 py-1.5 rounded" style={{ background: "var(--surface)", border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}>
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
          style={{ background: "rgba(var(--neon-purple-rgb),0.15)", border: "1px solid rgba(var(--neon-purple-rgb),0.5)", color: "var(--neon-purple)", boxShadow: "0 0 20px rgba(var(--neon-purple-rgb),0.15)" }}
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
            <Button onClick={() => { backgroundRef.current = true; onGoToDashboard(); }} size="sm" variant="ghost" className="gap-1.5 h-7 text-xs" style={{ color: "var(--neon-purple)", border: "1px solid rgba(var(--neon-purple-rgb),0.4)", background: "rgba(var(--neon-purple-rgb),0.08)" }}>
              <ArrowRight className="w-3 h-3" /> Continue in Background
            </Button>
            <Button onClick={async () => { await tauriCmd.abortOperation(`server_${serverId}`); }} size="sm" variant="ghost" className="gap-1.5 h-7 text-xs hover:brightness-110" style={{ color: "var(--neon-red)", border: "1px solid rgba(255,0,85,0.5)", background: "rgba(255,0,85,0.12)" }}>
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
          <Button onClick={startInstall} variant="outline" size="sm" className="gap-1" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)" }}>
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
  const [showBackgroundConfirm, setShowBackgroundConfirm] = useState(false);
  const cleanupFnRef = useRef<(() => Promise<void>) | null>(null);
  const backgroundSignalRef = useRef<(() => void) | null>(null);

  const steps = useMemo(() => computeSteps(data.presetStyle, data.copyFromServerId), [data.presetStyle, data.copyFromServerId]);

  // Clamp step to the new step count if presetStyle/copyFromServerId changed
  // and shrank the steps array — adjusted during render (React's documented
  // "adjust state during render" pattern) rather than in an effect.
  if (step >= steps.length) {
    setStep(steps.length - 1);
  }

  const currentStepDef = steps[step];
  const isInstallStep = currentStepDef?.id === "install";

  const onChange = useCallback((patch: Partial<WizardData>) => {
    setData((prev) => {
      const next = { ...prev, ...patch };
      // If presetStyle changes away from guided/full, reset to first available step after style
      return next;
    });
  }, []);

  const canAdvance = (): boolean => {
    if (!currentStepDef) return false;
    switch (currentStepDef.id) {
      case "basic": {
        const adminOk = !!data.adminPassword.trim() && data.adminPassword === data.adminPasswordConfirm;
        const serverOk = !data.serverPassword || data.serverPassword === data.serverPasswordConfirm;
        return !!data.name.trim() && adminOk && serverOk && nameValid;
      }
      case "gamemode": return !!data.gameMode;
      case "style":    return !!data.presetStyle;
      default:         return true;
    }
  };

  const next = () => { setDirection(1); setStep((s) => Math.min(s + 1, steps.length - 1)); };
  const prev = () => { setDirection(-1); setStep((s) => Math.max(s - 1, 0)); };

  const handleClose = () => {
    if (isInstallStep && installStatus === "error") { setShowCancelConfirm(true); return; }
    // Install is actively running — ask whether to keep it going in the
    // background or cancel it, rather than silently doing one of those
    // (this used to behave like "Continue in Background" unconditionally,
    // with no confirmation and no indication to the user that it was
    // still running).
    if (isInstallStep && installStatus === "installing") { setShowBackgroundConfirm(true); return; }
    onClose();
  };

  const handleConfirmCancel = async () => {
    setShowCancelConfirm(false);
    await cleanupFnRef.current?.().catch(() => {});
    onClose();
  };

  const handleContinueInBackground = () => {
    setShowBackgroundConfirm(false);
    backgroundSignalRef.current?.();
    onClose();
  };

  const handleCancelFromBackgroundPrompt = async () => {
    setShowBackgroundConfirm(false);
    await cleanupFnRef.current?.().catch(() => {});
    onClose();
  };

  const renderStep = () => {
    if (!currentStepDef) return null;
    switch (currentStepDef.id) {
      case "basic":      return <BasicInfoStep data={data} onChange={onChange} onNameValidated={setNameValid} />;
      case "gamemode":   return <GameModeStep data={data} onChange={onChange} />;
      case "style":      return <StyleStep data={data} onChange={onChange} />;
      case "guided_rates":    return <GuidedRatesStep    data={data} onChange={onChange} />;
      case "guided_breeding": return <GuidedBreedingStep data={data} onChange={onChange} />;
      case "guided_combat":   return <GuidedCombatStep   data={data} onChange={onChange} />;
      case "guided_behavior": return <GuidedBehaviorStep data={data} onChange={onChange} />;
      case "full_ini":   return <FullIniStep data={data} onChange={onChange} />;
      case "network":    return <NetworkStep data={data} onChange={onChange} />;
      case "firewall":   return <FirewallStep data={data} />;
      case "cluster":    return <ClusterStep data={data} onChange={onChange} />;
      case "automation": return <AutomationStep data={data} onChange={onChange} />;
      case "launch":     return <LaunchParamsStep data={data} onChange={onChange} />;
      case "mods":       return <ModsStep data={data} onChange={onChange} />;
      case "install":    return (
        <InstallStep
          data={data}
          serverId={serverId}
          onInstallComplete={onClose}
          onGoToDashboard={onClose}
          onStatusChange={setInstallStatus}
          onCleanupReady={(fn) => { cleanupFnRef.current = fn; }}
          onBackgroundReady={(fn) => { backgroundSignalRef.current = fn; }}
        />
      );
      default: return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "var(--background)" }}>
      {/* Background gradient */}
      <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: "radial-gradient(ellipse 80% 50% at 50% -20%, rgba(var(--neon-purple-rgb),0.08) 0%, transparent 60%)" }} />

      {/* Top bar */}
      <div className="relative z-10 flex items-center justify-between px-6 py-3 border-b shrink-0" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)", background: "var(--surface-elevated)" }}>
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
            style={{ background: "var(--glass-bg)", border: "1px solid rgba(var(--neon-purple-rgb),0.15)", backdropFilter: "blur(12px)" }}
          >
            <p className="text-xs font-semibold mb-3 px-1" style={{ color: "var(--text-muted)" }}>NEW SERVER</p>
            {steps.map((s, i) => {
              const done = i < step;
              const active = i === step;
              return (
                <div
                  key={s.id}
                  className={cn("flex items-center gap-3 px-3 py-2 rounded-lg transition-all", active && "bg-[rgba(var(--neon-purple-rgb),0.1)]", done && "opacity-70")}
                  style={{ border: active ? "1px solid rgba(var(--neon-purple-rgb),0.4)" : "1px solid transparent" }}
                >
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                    style={{
                      background: done ? "rgba(0,255,136,0.15)" : active ? "rgba(var(--neon-purple-rgb),0.2)" : "rgba(var(--neon-purple-rgb),0.05)",
                      border: `1px solid ${done ? "rgba(0,255,136,0.4)" : active ? "rgba(var(--neon-purple-rgb),0.5)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
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
              style={{ background: "var(--glass-bg)", border: "1px solid rgba(var(--neon-purple-rgb),0.15)", backdropFilter: "blur(12px)" }}
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
                <Button
                  onClick={prev}
                  disabled={step === 0}
                  className="gap-2"
                  style={{
                    background: step === 0 ? "rgba(var(--neon-purple-rgb),0.05)" : "rgba(var(--neon-purple-rgb),0.15)",
                    border: "1px solid rgba(var(--neon-purple-rgb),0.4)",
                    color: step === 0 ? "var(--text-muted)" : "var(--neon-purple)",
                  }}
                >
                  <ArrowLeft className="w-4 h-4" /> Back
                </Button>
                <Button
                  onClick={next}
                  disabled={!canAdvance()}
                  className="gap-2"
                  style={{
                    background: canAdvance() ? "rgba(var(--neon-purple-rgb),0.15)" : "rgba(var(--neon-purple-rgb),0.05)",
                    border: "1px solid rgba(var(--neon-purple-rgb),0.4)",
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
          <div className="rounded-xl p-6 max-w-sm w-full mx-4 flex flex-col gap-4" style={{ background: "var(--popover)", border: "1px solid rgba(255,0,85,0.35)", boxShadow: "0 8px 32px rgba(0,0,0,0.7)" }}>
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
              <Button onClick={() => setShowCancelConfirm(false)} className="flex-1 text-sm" style={{ background: "rgba(var(--neon-purple-rgb),0.08)", border: "1px solid rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}>
                Keep Going
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Close-mid-install overlay — install is still running */}
      {showBackgroundConfirm && (
        <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)" }}>
          <div className="rounded-xl p-6 max-w-sm w-full mx-4 flex flex-col gap-4" style={{ background: "var(--popover)", border: "1px solid rgba(var(--neon-purple-rgb),0.35)", boxShadow: "0 8px 32px rgba(0,0,0,0.7)" }}>
            <div className="flex items-start gap-3">
              <Info className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "var(--neon-purple)" }} />
              <div>
                <p className="text-sm font-semibold mb-1" style={{ color: "var(--text-primary)" }}>Installation Still Running</p>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>You can close this and let it keep installing in the background, or cancel it now.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <Button onClick={handleContinueInBackground} className="flex-1 text-sm" style={{ background: "rgba(var(--neon-purple-rgb),0.1)", border: "1px solid rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)" }}>
                Continue in Background
              </Button>
              <Button onClick={handleCancelFromBackgroundPrompt} className="flex-1 text-sm" style={{ background: "rgba(255,0,85,0.08)", border: "1px solid rgba(255,0,85,0.35)", color: "var(--neon-red)" }}>
                Cancel Install
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
