import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/layout/Providers";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { SetupGuard } from "@/components/layout/SetupGuard";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
          {/*
            SetupGuard checks SQLite on mount. While checking it shows a loading
            spinner. If setup is not complete it renders the SetupWizard overlay
            on top of everything. Once setup completes it clears the overlay.
          */}
          <SetupGuard>
            <div className="flex h-full">
              <Sidebar />
              <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
                <TopBar />
                <main className="flex-1 overflow-y-auto p-6">
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
