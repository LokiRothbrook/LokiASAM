"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Network,
  ScrollText,
  Archive,
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

const TOP_NAV: NavItem[] = [
  { href: "/",         icon: LayoutDashboard, label: "Dashboard", exact: true },
  { href: "/clusters", icon: Network,         label: "Clusters" },
  { href: "/logs",     icon: ScrollText,      label: "Logs" },
  { href: "/backups",  icon: Archive,         label: "Backups" },
];

const BOTTOM_NAV: NavItem[] = [
  { href: "/notifications", icon: Bell,     label: "Notifications" },
  { href: "/settings",      icon: Settings, label: "Settings" },
];

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
  return (
    <Tooltip>
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
}

export function Sidebar() {
  const pathname = usePathname();

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

      {/* Top nav items */}
      <div className="flex flex-col gap-1 w-full px-2">
        {TOP_NAV.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bottom nav items (Notifications + Settings pinned to bottom) */}
      <div className="flex flex-col gap-1 w-full px-2">
        {BOTTOM_NAV.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}
      </div>
    </aside>
  );
}
