"use client";

/**
 * useSetupStore — ephemeral state for the first-time setup wizard.
 *
 * Tracks the current step and all user-entered values across all wizard steps.
 * Not persisted to storage — the actual values are saved to SQLite only when
 * the wizard is completed.
 */

import { create } from "zustand";

export type SteamCmdMode = "auto" | "manual";
export type ProtonMode = "managed" | "existing";

interface SetupState {
  step: number;
  // Whether the user chose to import a previous install (skips most steps)
  importMode: boolean;
  importDir: string;
  importValid: boolean; // DB found in importDir

  // Step 2 — Base install directory
  baseDir: string;
  baseDirWritable: boolean;

  // Step 3 — Backup directory
  backupDir: string;
  backupDirWritable: boolean;

  // Step 4 — SteamCMD
  steamcmdMode: SteamCmdMode;
  steamcmdPath: string;
  steamcmdValidated: boolean;

  // Step 4 (Linux only) — Proton-GE
  protonMode: ProtonMode;
  protonPath: string;
  protonValidated: boolean;

  // Certificate step (both platforms)
  certInstalled: boolean;
  certSkipped: boolean;

  // Notifications step — Discord
  discordWebhook: string;

  // Notifications step — SMTP (all optional)
  smtpHost: string;
  smtpPort: string;
  smtpUsername: string;
  smtpPassword: string;
  smtpUseTls: boolean;
  smtpFrom: string;
  smtpTo: string;

  // Tray step
  closeToTray: boolean;

  // Auto-update step
  asaAutoCheckHours: string;    // "disabled"|"startup"|"startup_hourly"
  appUpdateCheckMode: string;   // "startup"|"periodic"|"off"
  protonCheckMode: string;      // "disabled"|"startup"|"startup_hourly"

  // Theme step
  themePreset: string;
  themeAccent: string;

  // Internal: whether a long-running operation is in progress
  isLoading: boolean;
  loadingMessage: string;

  // Actions
  setStep: (step: number) => void;
  nextStep: () => void;
  prevStep: () => void;
  setImportMode: (mode: boolean) => void;
  setImportDir: (dir: string) => void;
  setImportValid: (valid: boolean) => void;
  setBaseDir: (dir: string) => void;
  setBaseDirWritable: (ok: boolean) => void;
  setBackupDir: (dir: string) => void;
  setBackupDirWritable: (ok: boolean) => void;
  setSteamcmdMode: (mode: SteamCmdMode) => void;
  setSteamcmdPath: (path: string) => void;
  setSteamcmdValidated: (ok: boolean) => void;
  setProtonMode: (mode: ProtonMode) => void;
  setProtonPath: (path: string) => void;
  setProtonValidated: (ok: boolean) => void;
  setCertInstalled: (ok: boolean) => void;
  setCertSkipped: (ok: boolean) => void;
  setDiscordWebhook: (url: string) => void;
  setSmtpHost: (v: string) => void;
  setSmtpPort: (v: string) => void;
  setSmtpUsername: (v: string) => void;
  setSmtpPassword: (v: string) => void;
  setSmtpUseTls: (v: boolean) => void;
  setSmtpFrom: (v: string) => void;
  setSmtpTo: (v: string) => void;
  setCloseToTray: (v: boolean) => void;
  setAsaAutoCheckHours: (v: string) => void;
  setAppUpdateCheckMode: (v: string) => void;
  setProtonCheckMode: (v: string) => void;
  setThemePreset: (v: string) => void;
  setThemeAccent: (v: string) => void;
  setLoading: (loading: boolean, message?: string) => void;
  reset: () => void;
}

const initialState = {
  step: 0,
  importMode: false,
  importDir: "",
  importValid: false,
  baseDir: "",
  baseDirWritable: false,
  backupDir: "",
  backupDirWritable: false,
  steamcmdMode: "auto" as SteamCmdMode,
  steamcmdPath: "",
  steamcmdValidated: false,
  protonMode: "managed" as ProtonMode,
  protonPath: "",
  protonValidated: false,
  certInstalled: false,
  certSkipped: false,
  discordWebhook: "",
  smtpHost: "",
  smtpPort: "587",
  smtpUsername: "",
  smtpPassword: "",
  smtpUseTls: true,
  smtpFrom: "",
  smtpTo: "",
  closeToTray: true,
  asaAutoCheckHours: "startup",
  appUpdateCheckMode: "startup",
  protonCheckMode: "startup",
  themePreset: "storm",
  themeAccent: "blue",
  isLoading: false,
  loadingMessage: "",
};

export const useSetupStore = create<SetupState>((set, get) => ({
  ...initialState,

  setStep: (step) => set({ step }),
  nextStep: () => set({ step: get().step + 1 }),
  prevStep: () => set({ step: Math.max(0, get().step - 1) }),
  setImportMode: (importMode) => set({ importMode }),
  setImportDir: (importDir) => set({ importDir }),
  setImportValid: (importValid) => set({ importValid }),
  // Resetting steamcmdValidated/protonValidated here (not just in BaseDirStep)
  // means every caller that changes baseDir is automatically covered — going
  // back and picking a different base directory after already validating
  // SteamCMD/Proton for the old one used to leave both steps showing "Ready"
  // (their validated flags didn't know they applied to a now-stale path),
  // letting Finish write install paths that were never actually checked.
  setBaseDir: (baseDir) => set((s) => (
    baseDir === s.baseDir ? { baseDir } : { baseDir, steamcmdValidated: false, protonValidated: false }
  )),
  setBaseDirWritable: (baseDirWritable) => set({ baseDirWritable }),
  setBackupDir: (backupDir) => set({ backupDir }),
  setBackupDirWritable: (backupDirWritable) => set({ backupDirWritable }),
  setSteamcmdMode: (steamcmdMode) => set({ steamcmdMode }),
  setSteamcmdPath: (steamcmdPath) => set({ steamcmdPath }),
  setSteamcmdValidated: (steamcmdValidated) => set({ steamcmdValidated }),
  setProtonMode: (protonMode) => set({ protonMode }),
  setProtonPath: (protonPath) => set({ protonPath }),
  setProtonValidated: (protonValidated) => set({ protonValidated }),
  setCertInstalled: (certInstalled) => set({ certInstalled }),
  setCertSkipped: (certSkipped) => set({ certSkipped }),
  setDiscordWebhook: (discordWebhook) => set({ discordWebhook }),
  setSmtpHost: (smtpHost) => set({ smtpHost }),
  setSmtpPort: (smtpPort) => set({ smtpPort }),
  setSmtpUsername: (smtpUsername) => set({ smtpUsername }),
  setSmtpPassword: (smtpPassword) => set({ smtpPassword }),
  setSmtpUseTls: (smtpUseTls) => set({ smtpUseTls }),
  setSmtpFrom: (smtpFrom) => set({ smtpFrom }),
  setSmtpTo: (smtpTo) => set({ smtpTo }),
  setCloseToTray: (closeToTray) => set({ closeToTray }),
  setAsaAutoCheckHours: (asaAutoCheckHours) => set({ asaAutoCheckHours }),
  setAppUpdateCheckMode: (appUpdateCheckMode) => set({ appUpdateCheckMode }),
  setProtonCheckMode: (protonCheckMode) => set({ protonCheckMode }),
  setThemePreset: (themePreset) => set({ themePreset }),
  setThemeAccent: (themeAccent) => set({ themeAccent }),
  setLoading: (isLoading, message = "") =>
    set({ isLoading, loadingMessage: message }),
  reset: () => set(initialState),
}));
