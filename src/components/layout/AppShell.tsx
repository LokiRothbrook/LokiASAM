"use client";

import { Providers } from "@/components/layout/Providers";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { LokiIcon } from "@/components/shared/LokiIcon";
import { SetupGuard } from "@/components/layout/SetupGuard";
import { DisableContextMenu } from "@/components/layout/DisableContextMenu";
import { ModBrowserEventHandler } from "@/components/layout/ModBrowserEventHandler";
import { SchedulerManager } from "@/components/layout/SchedulerManager";
import { NotificationManager } from "@/components/layout/NotificationManager";
import { UpdateManager } from "@/components/layout/UpdateManager";
import { CloseWarningManager } from "@/components/layout/CloseWarningManager";
import { RconManager } from "@/components/layout/RconManager";
import { LogWatcherManager } from "@/components/layout/LogWatcherManager";
import { StartupReconciliationManager } from "@/components/layout/StartupReconciliationManager";
import { StartupQueueManager } from "@/components/layout/StartupQueueManager";
import { StartupRecoveryManager } from "@/components/layout/StartupRecoveryManager";
import { CfcoreRetryManager } from "@/components/layout/CfcoreRetryManager";
import { ServerStatsRecorderProvider } from "@/providers/ServerStatsRecorderProvider";
import { Toaster } from "sonner";

const toasterOptions = {
  style: {
    background: "rgba(10,10,30,0.95)",
    border: "1px solid rgba(var(--neon-purple-rgb),0.25)",
    color: "var(--text-primary)",
  },
};

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <DisableContextMenu />
      <SetupGuard>
        <ModBrowserEventHandler />
        <SchedulerManager />
        <NotificationManager />
        <UpdateManager />
        <CloseWarningManager />
        <CfcoreRetryManager />
        <RconManager />
        <LogWatcherManager />
        <StartupReconciliationManager />
        <StartupQueueManager />
        <StartupRecoveryManager />
        <ServerStatsRecorderProvider />
        <Toaster position="bottom-right" toastOptions={toasterOptions} />
        <div className="flex flex-col h-full">
          {/* Top strip: corner logo box + top bar — no border-right on corner so no seam */}
          <div className="flex h-14 shrink-0">
            <div
              className="w-16 shrink-0 flex items-center justify-center"
              style={{
                background: "var(--glass-bg)",
                backdropFilter: "blur(var(--glass-blur))",
                WebkitBackdropFilter: "blur(var(--glass-blur))",
              }}
            >
              <LokiIcon size={36} style={{ filter: "drop-shadow(0 0 6px var(--neon-purple))" }} />
            </div>
            <TopBar />
          </div>
          {/* Main area: sidebar (border-r starts here, below the logo) + content */}
          <div className="flex flex-1 min-h-0">
            <Sidebar />
            <main id="main-content" className="flex-1 overflow-y-auto p-6">
              {children}
            </main>
          </div>
        </div>
      </SetupGuard>
    </Providers>
  );
}
