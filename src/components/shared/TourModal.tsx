"use client";

import { useState } from "react";
import {
  X, ArrowLeft, ArrowRight, CheckCircle2,
  LayoutDashboard, Activity, SlidersHorizontal,
  CalendarClock, Archive, Network, Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const TOUR_SLIDES = [
  {
    Icon: LayoutDashboard,
    title: "Dashboard",
    description: "Your mission control — see the state of every server at a glance and act in one place.",
    imagePlaceholder: "Screenshot: Main Dashboard showing server cards with status, player count, and CPU/memory stats",
    bullets: [
      "Server cards show live status, player count, CPU and memory at a glance",
      "Start, stop, or restart any server directly from the dashboard",
      "\"Check for Updates\" scans Steam for new ASA builds across all servers",
      "Click any server card to open its full detail view",
      "Use the + button in the sidebar to add your first server",
    ],
  },
  {
    Icon: Activity,
    title: "Server Overview & Controls",
    description: "Live stats, full controls, and everything you need to know about a running server.",
    imagePlaceholder: "Screenshot: Overview tab on a running server — stat chart, control buttons (Start/Stop/Restart), server info panel",
    bullets: [
      "Live stat charts: CPU %, memory, player count — zoom from 1 hour to 1 year of history",
      "Start, Stop, Restart, and Force Update with a single click",
      "Enable Auto-Start to launch the server automatically when LokiASAM opens",
      "See current map, ports, last backup time, and next scheduled restart at a glance",
    ],
  },
  {
    Icon: SlidersHorizontal,
    title: "Config, Mods & RCON",
    description: "Deep control over every aspect of your server.",
    imagePlaceholder: "Screenshot: Config tab showing game settings fields (server name, max players, passwords, INI editor)",
    bullets: [
      "Config: edit all game settings — INI files, server name, passwords, max players, and launch arguments",
      "Mods: add, remove, and reorder mods with built-in CurseForge integration",
      "RCON: send commands to your live server — kick players, broadcast messages, save the world, and more",
    ],
  },
  {
    Icon: CalendarClock,
    title: "Automation & Scheduling",
    description: "Set it and forget it — LokiASAM handles restarts, backups, and broadcasts on your schedule.",
    imagePlaceholder: "Screenshot: Automation tab showing backup schedule tiers and a restart schedule with warning settings",
    bullets: [
      "Schedule automatic backups: hourly, daily, weekly, and monthly tiers with configurable retention",
      "Schedule restarts at specific times with in-game countdown warnings sent to players",
      "Set up recurring in-game broadcast messages on any cron schedule",
      "Per-server update automation: apply updates immediately when found, or at a specific time of day",
    ],
  },
  {
    Icon: Archive,
    title: "Logs & Backups",
    description: "Full history of what happened and a safety net for when things go wrong.",
    imagePlaceholder: "Screenshot: Backups sidebar page showing a list of backup entries with map, size, and date",
    bullets: [
      "Logs page (sidebar): browse real-time and archived server logs across all servers in one place",
      "Backups page (sidebar): every backup catalogued — map, player count, size, and when it was taken",
      "Restore any backup to a server with a single click",
      "Backups are stored as 7z archives in the backup directory you chose during setup",
    ],
  },
  {
    Icon: Network,
    title: "Clusters, Notifications & Settings",
    description: "The finishing touches that tie your whole setup together.",
    imagePlaceholder: "Screenshot: Clusters page showing a cluster with linked servers, or the Settings page showing the Updates tab",
    bullets: [
      "Clusters: group servers together for cross-server travel and shared tribe data",
      "Notifications page: browse all in-app alerts — filter by type and severity, see full event history",
      "Settings → Updates: adjust auto-update intervals for ASA, the app, and Proton-GE at any time",
      "Settings → General: change your theme, manage install paths, and configure notification channels",
    ],
  },
  {
    Icon: Globe,
    title: "Connecting from Outside Your Home Network",
    description: "For players outside your local network to join, your server ports need to be reachable from the internet.",
    imagePlaceholder: "Diagram: Internet → Router/VPN → Port Forward → LokiASAM Server",
    bullets: [
      "Forward two ports on your router: Game Port (UDP) and Query Port (UDP). RCON (TCP) only needs to be open if you use remote console tools.",
      "No router access? VPN port-forwarding services let you forward ports without touching your router — ideal for apartments, shared networks, or ISP restrictions",
      // TODO: Add affiliate links here for TorGuard / Mullvad / AirVPN — these let users support
      //       LokiASAM at no extra cost while solving their port forwarding needs.
      "TorGuard is one popular option — forward ports through their VPN without exposing your home IP",
      "RCON port (TCP) only needs to be forwarded if you want remote admin access from outside your home",
      "LokiASAM opens the required firewall ports automatically during server creation — the Firewall step shows you exactly which ports to forward",
    ],
  },
];

export function TourModal({ onClose }: { onClose: () => void }) {
  const [slide, setSlide] = useState(0);
  const current = TOUR_SLIDES[slide];
  const { Icon } = current;

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center p-6 text-left"
      style={{ background: "rgba(0,0,0,0.8)", backdropFilter: "blur(8px)" }}
    >
      <div
        className="relative w-full max-w-xl rounded-2xl flex flex-col overflow-hidden"
        style={{
          background: "var(--surface-elevated)",
          border: "1px solid rgba(var(--neon-purple-rgb),0.3)",
          boxShadow: "0 0 60px rgba(var(--neon-purple-rgb),0.15)",
          maxHeight: "90vh",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 pt-5 pb-4"
          style={{ borderBottom: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "rgba(var(--neon-purple-rgb),0.12)" }}>
              <Icon className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
            </div>
            <div>
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                Quick Start Guide · {slide + 1} of {TOUR_SLIDES.length}
              </p>
              <p className="text-base font-bold leading-tight" style={{ color: "var(--text-primary)" }}>
                {current.title}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 transition-colors"
            style={{ color: "var(--text-muted)" }}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {/* Placeholder image */}
          <div
            className="w-full rounded-xl flex flex-col items-center justify-center gap-2.5"
            style={{
              height: "160px",
              background: "rgba(var(--neon-purple-rgb),0.04)",
              border: "1px dashed rgba(var(--neon-purple-rgb),0.2)",
            }}
          >
            <Icon className="w-10 h-10" style={{ color: "rgba(var(--neon-purple-rgb),0.25)" }} />
            <p className="text-[10px] text-center px-6" style={{ color: "var(--text-subtle)" }}>
              {current.imagePlaceholder}
            </p>
          </div>

          <p className="text-sm" style={{ color: "var(--text-muted)" }}>{current.description}</p>

          <ul className="space-y-2">
            {current.bullets.map((b, i) => (
              <li
                key={i}
                className="text-xs"
                style={{ color: "var(--text-primary)", paddingLeft: "14px", textIndent: "-14px" }}
              >
                <span
                  className="inline-block rounded-full"
                  style={{ width: "6px", height: "6px", marginRight: "8px", verticalAlign: "0.1em", background: "var(--neon-purple)" }}
                />
                {b}
              </li>
            ))}
          </ul>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-6 py-4"
          style={{ borderTop: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}
        >
          {/* Dot indicators */}
          <div className="flex gap-1.5 items-center">
            {TOUR_SLIDES.map((_, i) => (
              <button
                key={i}
                onClick={() => setSlide(i)}
                className="rounded-full transition-all"
                style={{
                  width: i === slide ? "20px" : "8px",
                  height: "8px",
                  background: i === slide ? "var(--neon-purple)" : "rgba(var(--neon-purple-rgb),0.2)",
                }}
                aria-label={`Slide ${i + 1}`}
              />
            ))}
          </div>

          <div className="flex gap-2">
            {slide > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setSlide((s) => s - 1)}
                className="gap-1.5" style={{ color: "var(--text-muted)" }}>
                <ArrowLeft className="w-3.5 h-3.5" /> Back
              </Button>
            )}
            {slide < TOUR_SLIDES.length - 1 ? (
              <Button size="sm" onClick={() => setSlide((s) => s + 1)} className="gap-1.5"
                style={{
                  background: "rgba(var(--neon-purple-rgb),0.15)",
                  border: "1px solid rgba(var(--neon-purple-rgb),0.4)",
                  color: "var(--neon-purple)",
                }}>
                Next <ArrowRight className="w-3.5 h-3.5" />
              </Button>
            ) : (
              <Button size="sm" onClick={onClose} className="gap-1.5"
                style={{
                  background: "rgba(0,255,136,0.12)",
                  border: "1px solid rgba(0,255,136,0.4)",
                  color: "var(--neon-green)",
                }}>
                Done <CheckCircle2 className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
