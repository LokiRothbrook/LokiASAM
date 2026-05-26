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
  /** Whether the CurseForge mod browser overlay is currently open. */
  modBrowserOpen: boolean;
  /** Params passed to the mod-browser page so it knows which server to open for. */
  modBrowserParams: { serverId: string; serverName: string; addedModIds: string[] } | null;
  /** Set to true when the mod browser closes so ModsTab knows to reload its list. */
  modBrowserJustClosed: boolean;
  /** Increments each time a mod is added via the browser. ModsTab watches this for real-time list updates. */
  modAddedCount: number;
  /** True while a mod ID verification is running via the hidden WebviewWindow. */
  verifying: boolean;
  /** Total number of mod IDs being verified in the current batch. */
  verifyTotal: number;
  /** Number of mod IDs processed so far (success + fail + skip). */
  verifyProgress: number;
  /**
   * Bumped each time a new notification is logged. TanStack Query watches this
   * as a query key so the bell and notifications page re-fetch automatically.
   */
  unreadBump: number;

  setSetupChecked: (checked: boolean) => void;
  setSetupComplete: (complete: boolean) => void;
  setNotificationBellOpen: (open: boolean) => void;
  setShowNewServerWizard: (show: boolean) => void;
  setModBrowserOpen: (open: boolean) => void;
  setModBrowserParams: (p: { serverId: string; serverName: string; addedModIds: string[] } | null) => void;
  setModBrowserJustClosed: (v: boolean) => void;
  incrementModAddedCount: () => void;
  startVerifying: (total: number) => void;
  incrementVerifyProgress: () => void;
  stopVerifying: () => void;
  /** Called by dispatchNotification after logging a new notification. */
  incrementUnread: () => void;
  /** Called after the user views/clears notifications. */
  resetUnreadBump: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  setupChecked: false,
  setupComplete: false,
  notificationBellOpen: false,
  showNewServerWizard: false,
  modBrowserOpen: false,
  modBrowserParams: null,
  modBrowserJustClosed: false,
  modAddedCount: 0,
  verifying: false,
  verifyTotal: 0,
  verifyProgress: 0,
  unreadBump: 0,

  setSetupChecked: (checked) => set({ setupChecked: checked }),
  setSetupComplete: (complete) => set({ setupComplete: complete }),
  setNotificationBellOpen: (open) => set({ notificationBellOpen: open }),
  setShowNewServerWizard: (show) => set({ showNewServerWizard: show }),
  setModBrowserOpen: (open) => set({ modBrowserOpen: open }),
  setModBrowserParams: (p) => set({ modBrowserParams: p }),
  setModBrowserJustClosed: (v) => set({ modBrowserJustClosed: v }),
  incrementModAddedCount: () => set((s) => ({ modAddedCount: s.modAddedCount + 1 })),
  startVerifying: (total) => set({ verifying: true, verifyTotal: total, verifyProgress: 0 }),
  incrementVerifyProgress: () => set((s) => ({ verifyProgress: s.verifyProgress + 1 })),
  stopVerifying: () => set({ verifying: false, verifyTotal: 0, verifyProgress: 0 }),
  incrementUnread: () => set((s) => ({ unreadBump: s.unreadBump + 1 })),
  resetUnreadBump: () => set({ unreadBump: 0 }),
}));
