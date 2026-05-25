"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Server,
  LayoutDashboard,
  Network,
  Bell,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LokiIcon } from "@/components/shared/LokiIcon";

interface NavItem {
  href: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  label: string;
  exact?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/",             icon: LayoutDashboard, label: "Dashboard",      exact: true },
  { href: "/clusters",     icon: Network,         label: "Clusters" },
  { href: "/notifications",icon: Bell,            label: "Notifications" },
  { href: "/settings",     icon: Settings,        label: "Settings" },
];

export function Sidebar() {
  const pathname = usePathname();

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

      {/* Server status indicator strip — populated in Phase 3 */}
      <div className="flex flex-col gap-1 px-2 w-full mb-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center justify-center w-full h-8">
              <Server className="w-4 h-4" style={{ color: "var(--text-subtle)" }} />
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            Server status (Phase 3)
          </TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
