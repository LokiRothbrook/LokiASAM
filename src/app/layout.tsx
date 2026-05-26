import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/layout/Providers";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { SetupGuard } from "@/components/layout/SetupGuard";
import { DisableContextMenu } from "@/components/layout/DisableContextMenu";
import { ModBrowserEventHandler } from "@/components/layout/ModBrowserEventHandler";
import { SchedulerManager } from "@/components/layout/SchedulerManager";
import { NotificationManager } from "@/components/layout/NotificationManager";
import { UpdateManager } from "@/components/layout/UpdateManager";
import { Toaster } from "sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "LokiASAM — Ark Survival Ascended Server Manager",
  description: "Manage your Ark Survival Ascended dedicated servers with ease.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="h-full bg-[var(--background)] text-[var(--text-primary)]">
        <Providers>
          <DisableContextMenu />
          {/*
            SetupGuard checks SQLite on mount. While checking it shows a loading
            spinner. If setup is not complete it renders the SetupWizard overlay
            on top of everything. Once setup completes it clears the overlay.
          */}
          <SetupGuard>
            <ModBrowserEventHandler />
            <SchedulerManager />
            <NotificationManager />
            <UpdateManager />
            <Toaster
              position="bottom-right"
              toastOptions={{
                style: {
                  background: "rgba(10,10,30,0.95)",
                  border: "1px solid rgba(191,0,255,0.25)",
                  color: "var(--text-primary)",
                },
              }}
            />
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
      </body>
    </html>
  );
}
