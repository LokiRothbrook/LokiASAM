"use client";

/**
 * useAppStore — global UI state shared across the application.
 *
 * Tracks whether the first-time setup is complete (checked from SQLite on mount).
 * Also holds ephemeral UI state like notification bell open state.
 */

import { create } from "zustand";
import type { ChartPoint } from "@/lib/db";

const LIVE_BUFFER_SIZE = 120; // 10 min × 5 s = 120 points

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

  /** True while the startup process scan is running. All server action buttons
   *  are disabled and the status badge shows "Detecting..." during this window. */
  isServerScanPending: boolean;
  setIsServerScanPending: (v: boolean) => void;

  /**
   * Server statuses captured immediately before the startup scan runs.
   * Set by StartupReconciliationManager; read by StartupRecoveryManager to
   * detect which servers were running before a crash.  Null until the first scan.
   */
  preScanStatuses: Record<string, string> | null;
  setPreScanStatuses: (statuses: Record<string, string>) => void;

  /**
   * Wall-clock timestamp (ms since epoch) when each server process first started.
   * Keyed by server ID.  Set when the first "starting" event arrives; cleared on
   * "stopped" or "crashed".  Used to display uptime from process-start, not from
   * the "running" status change (which happens minutes later when RCON confirms).
   */
  serverStartTimes: Record<string, number>;
  setServerStartTime: (id: string, ts: number) => void;
  clearServerStartTime: (id: string) => void;

  /**
   * Server IDs where the last start-failed was due to a missing executable.
   * These servers hide the Retry button — only Reinstall makes sense.
   * Cleared when the user retries or reinstall completes.
   */
  noRetryServerIds: Record<string, true>;
  setNoRetryServer: (id: string) => void;
  clearNoRetryServer: (id: string) => void;

  /**
   * Ordered list of server IDs waiting to start sequentially.
   * StartupQueueManager processes this list one at a time — it starts the
   * next server only after the current one reaches "running" or "start-failed".
   * DB status for queued servers is set to "startup_queued" so the badge shows.
   */
  startupQueue: string[];
  enqueueStartup: (ids: string[]) => void;
  dequeueNextStartup: () => string | undefined;
  removeFromStartupQueue: (id: string) => void;
  clearStartupQueue: () => void;

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

  /** Set to true by the setup wizard "Quick Start Guide" button so the Sidebar
   *  opens the tour after navigating to the dashboard. Cleared once consumed. */
  pendingTour: boolean;
  setPendingTour: (v: boolean) => void;

  /**
   * Rolling 10-minute live stat buffers keyed by server ID.
   * Each array holds up to LIVE_BUFFER_SIZE (60) points at 10s resolution.
   */
  statsLiveBuffers: Record<string, ChartPoint[]>;
  addLiveSample: (serverId: string, point: ChartPoint) => void;
  clearLiveBuffer: (serverId: string) => void;

  /** Active countdown info keyed by server ID. Null means no countdown running. */
  countdowns: Record<string, { action: 'restart' | 'update'; remainingSecs: number; totalSecs: number } | null>;
  setCountdown: (serverId: string, entry: { action: 'restart' | 'update'; remainingSecs: number; totalSecs: number } | null) => void;

  /** Label shown in TopBar while an ASA cache op is running; null when idle. */
  asaCacheOpLabel: string | null;
  setAsaCacheOpLabel: (v: string | null) => void;
  /** @deprecated use asaCacheOpLabel !== null */
  asaCacheUpdateInProgress: boolean;
  setAsaCacheUpdateInProgress: (v: boolean) => void;

  /** Label shown in TopBar while a Proton-GE op is running; null when idle. */
  protonOpLabel: string | null;
  setProtonOpLabel: (v: string | null) => void;
  /** True after a Proton-GE op completes; cleared when the next op starts. */
  protonOpDone: boolean;
  setProtonOpDone: (v: boolean) => void;
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
  isServerScanPending: false,
  setIsServerScanPending: (v) => set({ isServerScanPending: v }),
  preScanStatuses: null,
  setPreScanStatuses: (statuses) => set({ preScanStatuses: statuses }),
  serverStartTimes: {},
  setServerStartTime: (id, ts) =>
    set((s) => ({ serverStartTimes: { ...s.serverStartTimes, [id]: ts } })),
  clearServerStartTime: (id) =>
    set((s) => {
      const next = { ...s.serverStartTimes };
      delete next[id];
      return { serverStartTimes: next };
    }),
  noRetryServerIds: {},
  setNoRetryServer: (id) =>
    set((s) => ({ noRetryServerIds: { ...s.noRetryServerIds, [id]: true } })),
  clearNoRetryServer: (id) =>
    set((s) => {
      const next = { ...s.noRetryServerIds };
      delete next[id];
      return { noRetryServerIds: next };
    }),

  startupQueue: [],
  enqueueStartup: (ids) =>
    set((s) => ({ startupQueue: [...s.startupQueue, ...ids.filter((id) => !s.startupQueue.includes(id))] })),
  dequeueNextStartup: () => {
    let dequeued: string | undefined;
    set((s) => {
      if (s.startupQueue.length === 0) return s;
      dequeued = s.startupQueue[0];
      return { startupQueue: s.startupQueue.slice(1) };
    });
    return dequeued;
  },
  removeFromStartupQueue: (id) =>
    set((s) => ({ startupQueue: s.startupQueue.filter((qId) => qId !== id) })),
  clearStartupQueue: () => set({ startupQueue: [] }),

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
  pendingTour: false,
  setPendingTour: (v) => set({ pendingTour: v }),

  statsLiveBuffers: {},
  addLiveSample: (serverId, point) =>
    set((s) => {
      const prev = s.statsLiveBuffers[serverId] ?? [];
      const next = [...prev, point];
      if (next.length > LIVE_BUFFER_SIZE) next.shift();
      return { statsLiveBuffers: { ...s.statsLiveBuffers, [serverId]: next } };
    }),
  clearLiveBuffer: (serverId) =>
    set((s) => {
      const next = { ...s.statsLiveBuffers };
      delete next[serverId];
      return { statsLiveBuffers: next };
    }),

  countdowns: {},
  setCountdown: (serverId, entry) =>
    set((s) => ({ countdowns: { ...s.countdowns, [serverId]: entry } })),

  asaCacheOpLabel: null,
  setAsaCacheOpLabel: (v) => set({ asaCacheOpLabel: v, asaCacheUpdateInProgress: v !== null }),
  asaCacheUpdateInProgress: false,
  setAsaCacheUpdateInProgress: (v) => set({ asaCacheUpdateInProgress: v }),

  protonOpLabel: null,
  setProtonOpLabel: (v) => set({ protonOpLabel: v }),
  protonOpDone: false,
  setProtonOpDone: (v) => set({ protonOpDone: v }),
}));
