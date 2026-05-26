"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Network,
  Bell,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LokiIcon } from "@/components/shared/LokiIcon";
import { useServers } from "@/hooks/useServers";

interface NavItem {
  href: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  label: string;
  exact?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/",              icon: LayoutDashboard, label: "Dashboard",     exact: true },
  { href: "/clusters",      icon: Network,         label: "Clusters" },
  { href: "/notifications", icon: Bell,            label: "Notifications" },
  { href: "/settings",      icon: Settings,        label: "Settings" },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data: servers = [] } = useServers();
  const runningCount = servers.filter((s) => s.status === "running").length;

  function isActive(item: NavItem): boolean {
    if (item.exact) return pathname === item.href;
    return pathname.startsWith(item.href);
  }

  return (
    <aside
      className="flex flex-col items-center w-16 h-full py-4 gap-2 border-r shrink-0"
      style={{
        background: "rgba(5, 5, 20, 0.95)",
        borderColor: "var(--border)",
      }}
    >
      {/* Logo */}
      <div className="mb-4 flex items-center justify-center w-10 h-10">
        <LokiIcon
          size={36}
          style={{ filter: "drop-shadow(0 0 6px var(--neon-purple))" }}
        />
      </div>

      <div className="flex flex-col gap-1 flex-1 w-full px-2">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item);
          return (
            <Tooltip key={item.href}>
              <TooltipTrigger asChild>
                <Link
                  href={item.href}
                  className={cn(
                    "flex items-center justify-center w-full h-10 rounded-lg transition-all duration-150",
                    active
                      ? "bg-[rgba(191,0,255,0.1)] text-[var(--neon-purple)]"
                      : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[rgba(255,255,255,0.05)]"
                  )}
                  style={
                    active
                      ? { boxShadow: "0 0 12px rgba(191,0,255,0.15)", borderLeft: "2px solid var(--neon-purple)" }
                      : {}
                  }
                >
                  <item.icon className="w-5 h-5" />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs">
                {item.label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      {/* Running server count badge */}
      <div className="px-2 w-full mb-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center justify-center w-full h-8 relative">
              <div
                className="w-2 h-2 rounded-full"
                style={{
                  background: runningCount > 0 ? "var(--neon-green)" : "var(--text-subtle)",
                  boxShadow: runningCount > 0 ? "var(--glow-green)" : "none",
                }}
              />
              {runningCount > 0 && (
                <span
                  className="absolute -top-0.5 -right-0.5 flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-bold"
                  style={{ background: "var(--neon-green)", color: "#000" }}
                >
                  {runningCount > 9 ? "9+" : runningCount}
                </span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            {runningCount > 0 ? `${runningCount} server${runningCount !== 1 ? "s" : ""} running` : "No servers running"}
          </TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
