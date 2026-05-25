"use client";

/**
 * useSetupStore — ephemeral state for the first-time setup wizard.
 *
 * Tracks the current step and all user-entered values across the 6 wizard steps.
 * Not persisted to storage — the actual values are saved to SQLite only when
 * the wizard is completed.
 */

import { create } from "zustand";

export type SteamCmdMode = "auto" | "manual";

interface SetupState {
  step: number;

  // Step 2 — Base install directory
  baseDir: string;
  baseDirWritable: boolean;

  // Step 3 — Backup directory
  backupDir: string;
  backupDirWritable: boolean;

  // Step 4 — SteamCMD
  steamcmdMode: SteamCmdMode;
  steamcmdPath: string;       // resolved path to steamcmd exe after install/manual selection
  steamcmdValidated: boolean; // true after validate_steamcmd returns true

  // Step 5 — Notification defaults (all optional)
  discordWebhook: string;

  // Internal: whether a long-running operation is in progress
  isLoading: boolean;
  loadingMessage: string;

  // Actions
  setStep: (step: number) => void;
  nextStep: () => void;
  prevStep: () => void;
  setBaseDir: (dir: string) => void;
  setBaseDirWritable: (ok: boolean) => void;
  setBackupDir: (dir: string) => void;
  setBackupDirWritable: (ok: boolean) => void;
  setSteamcmdMode: (mode: SteamCmdMode) => void;
  setSteamcmdPath: (path: string) => void;
  setSteamcmdValidated: (ok: boolean) => void;
  setDiscordWebhook: (url: string) => void;
  setLoading: (loading: boolean, message?: string) => void;
  reset: () => void;
}

const initialState = {
  step: 0,
  baseDir: "",
  baseDirWritable: false,
  backupDir: "",
  backupDirWritable: false,
  steamcmdMode: "auto" as SteamCmdMode,
  steamcmdPath: "",
  steamcmdValidated: false,
  discordWebhook: "",
  isLoading: false,
  loadingMessage: "",
};

export const useSetupStore = create<SetupState>((set, get) => ({
  ...initialState,

  setStep: (step) => set({ step }),
  nextStep: () => set({ step: get().step + 1 }),
  prevStep: () => set({ step: Math.max(0, get().step - 1) }),
  setBaseDir: (baseDir) => set({ baseDir }),
  setBaseDirWritable: (baseDirWritable) => set({ baseDirWritable }),
  setBackupDir: (backupDir) => set({ backupDir }),
  setBackupDirWritable: (backupDirWritable) => set({ backupDirWritable }),
  setSteamcmdMode: (steamcmdMode) => set({ steamcmdMode }),
  setSteamcmdPath: (steamcmdPath) => set({ steamcmdPath }),
  setSteamcmdValidated: (steamcmdValidated) => set({ steamcmdValidated }),
  setDiscordWebhook: (discordWebhook) => set({ discordWebhook }),
  setLoading: (isLoading, message = "") =>
    set({ isLoading, loadingMessage: message }),
  reset: () => set(initialState),
}));
