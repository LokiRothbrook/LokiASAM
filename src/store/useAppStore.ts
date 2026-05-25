"use client";

/**
 * useAppStore — global UI state shared across the application.
 *
 * Tracks whether the first-time setup is complete (checked from SQLite on mount).
 * Also holds ephemeral UI state like notification bell open state.
 */

import { create } from "zustand";

interface AppState {
  /** True once setup_complete has been confirmed in SQLite. */
  setupChecked: boolean;
  /** True when setup_complete = 'true' in app_settings. */
  setupComplete: boolean;
  /** Whether the notification bell dropdown is open. */
  notificationBellOpen: boolean;
  /** Whether the New Server creation wizard overlay is visible. */
  showNewServerWizard: boolean;

  setSetupChecked: (checked: boolean) => void;
  setSetupComplete: (complete: boolean) => void;
  setNotificationBellOpen: (open: boolean) => void;
  setShowNewServerWizard: (show: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  setupChecked: false,
  setupComplete: false,
  notificationBellOpen: false,
  showNewServerWizard: false,

  setSetupChecked: (checked) => set({ setupChecked: checked }),
  setSetupComplete: (complete) => set({ setupComplete: complete }),
  setNotificationBellOpen: (open) => set({ notificationBellOpen: open }),
  setShowNewServerWizard: (show) => set({ showNewServerWizard: show }),
}));
