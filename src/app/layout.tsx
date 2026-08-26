import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AppShell } from "@/components/layout/AppShell";

const geistSans = localFont({
  src: [
    { path: "./fonts/geist-latin.woff2",     weight: "100 900" },
    { path: "./fonts/geist-latin-ext.woff2", weight: "100 900" },
  ],
  variable: "--font-geist-sans",
  display: "swap",
});

const geistMono = localFont({
  src: [
    { path: "./fonts/geist-mono-latin.woff2",     weight: "100 900" },
    { path: "./fonts/geist-mono-latin-ext.woff2", weight: "100 900" },
  ],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "LokiASAM — Ark Survival Ascended Server Manager",
  description: "Manage your Ark Survival Ascended dedicated servers with ease.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="h-full bg-[var(--background)] text-[var(--text-primary)]">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
