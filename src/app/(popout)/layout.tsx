import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "../globals.css";
import { Providers } from "@/components/layout/Providers";
import { DisableContextMenu } from "@/components/layout/DisableContextMenu";
import { Toaster } from "sonner";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"], display: "swap" });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "LokiASAM — RCON",
};

export default function PopoutLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}>
      <body className="h-full bg-[var(--background)] text-[var(--text-primary)]">
        <Providers>
          <DisableContextMenu />
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
          {children}
        </Providers>
      </body>
    </html>
  );
}
