"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "@/store/useAppStore";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Network,
  ScrollText,
  Archive,
  Bell,
  Settings,
  HelpCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TourModal } from "@/components/shared/TourModal";

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
              ? "text-(--neon-purple)"
              : "text-text-muted hover:bg-[rgba(var(--neon-purple-rgb),0.07)]"
          )}
          style={
            active
              ? {
                  background: "rgba(var(--neon-purple-rgb),0.12)",
                }
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
  const [tourOpen, setTourOpen] = useState(false);
  const pendingTour   = useAppStore((s) => s.pendingTour);
  const setPendingTour = useAppStore((s) => s.setPendingTour);

  useEffect(() => {
    if (pendingTour) {
      setPendingTour(false);
      setTourOpen(true);
    }
  }, [pendingTour, setPendingTour]);

  return (
    <>
    <aside
      className="flex flex-col items-center w-16 h-full py-4 gap-2 border-r shrink-0"
      style={{
        background: "var(--glass-bg)",
        backdropFilter: "blur(var(--glass-blur))",
        WebkitBackdropFilter: "blur(var(--glass-blur))",
        borderColor: "var(--border)",
      }}
    >
      {/* Top nav items */}
      <div className="flex flex-col gap-1 w-full px-2">
        {TOP_NAV.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Quick Start Guide help button */}
      <div className="w-full px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setTourOpen(true)}
              className="flex items-center justify-center w-full h-10 rounded-lg transition-all duration-150 text-text-muted hover:bg-[rgba(var(--neon-purple-rgb),0.07)]"
              style={{ color: "var(--text-muted)" }}
              aria-label="Quick Start Guide"
            >
              <HelpCircle className="w-5 h-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">Quick Start Guide</TooltipContent>
        </Tooltip>
      </div>

      {/* Bottom nav items (Notifications + Settings pinned to bottom) */}
      <div className="flex flex-col gap-1 w-full px-2">
        {BOTTOM_NAV.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} />
        ))}
      </div>

    </aside>

    {tourOpen && createPortal(
      <TourModal onClose={() => setTourOpen(false)} />,
      document.body
    )}
    </>
  );
}
