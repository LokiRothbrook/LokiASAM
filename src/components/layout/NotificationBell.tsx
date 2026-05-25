"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Unread count will come from Zustand / TanStack Query in Phase 8.
  const unreadCount = 0;

  const handleViewAll = () => {
    setOpen(false);
    router.push("/notifications");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          style={{ color: "var(--text-muted)" }}
          aria-label="Notifications"
        >
          <Bell className="w-5 h-5" />
          {unreadCount > 0 && (
            <span
              className="absolute top-1 right-1 flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold"
              style={{
                background: "var(--neon-red)",
                color: "#000",
                boxShadow: "var(--glow-red)",
              }}
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-0"
        style={{
          background: "var(--surface-elevated)",
          border: "1px solid var(--border)",
        }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: "var(--border)" }}>
          <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Notifications
          </span>
          {unreadCount > 0 && (
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {unreadCount} unread
            </span>
          )}
        </div>
        <div className="py-8 flex flex-col items-center justify-center gap-2">
          <Bell className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            No notifications yet
          </p>
        </div>
        <div className="border-t px-4 py-2" style={{ borderColor: "var(--border)" }}>
          <button
            onClick={handleViewAll}
            className="text-xs transition-colors hover:underline"
            style={{ color: "var(--neon-purple)" }}
          >
            View all notifications →
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
