"use client";

import { Providers } from "@/components/layout/Providers";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { SetupGuard } from "@/components/layout/SetupGuard";
import { DisableContextMenu } from "@/components/layout/DisableContextMenu";
import { ModBrowserEventHandler } from "@/components/layout/ModBrowserEventHandler";
import { SchedulerManager } from "@/components/layout/SchedulerManager";
import { NotificationManager } from "@/components/layout/NotificationManager";
import { UpdateManager } from "@/components/layout/UpdateManager";
import { CloseWarningManager } from "@/components/layout/CloseWarningManager";
import { RconManager } from "@/components/layout/RconManager";
import { Toaster } from "sonner";

const toasterOptions = {
  style: {
    background: "rgba(10,10,30,0.95)",
    border: "1px solid rgba(191,0,255,0.25)",
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
        <RconManager />
        <Toaster position="bottom-right" toastOptions={toasterOptions} />
        <div className="flex h-full">
          <Sidebar />
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            <TopBar />
            <main id="main-content" className="flex-1 overflow-y-auto p-6">
              {children}
            </main>
          </div>
        </div>
      </SetupGuard>
    </Providers>
  );
}
