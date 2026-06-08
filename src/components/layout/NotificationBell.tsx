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
import { useUnreadNotificationCount, useNotificationList } from "@/hooks/useNotifications";
import { markAllNotificationsRead, parseDbDate } from "@/lib/db";
import { useAppStore } from "@/store/useAppStore";
import { useQueryClient } from "@tanstack/react-query";
import type { InAppNotificationRow } from "@/lib/db";

// ---------------------------------------------------------------------------
// Severity → neon color
// ---------------------------------------------------------------------------

function severityColor(severity: string): string {
  switch (severity) {
    case "success": return "var(--neon-green)";
    case "warning": return "var(--neon-cyan)";
    case "error":   return "var(--neon-red)";
    default:        return "var(--text-muted)";
  }
}

function formatRelative(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

// ---------------------------------------------------------------------------
// Notification item (mini) — clickable
// ---------------------------------------------------------------------------

function NotificationItemMini({
  n,
  onClick,
}: {
  n: InAppNotificationRow;
  onClick: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className="w-full text-left flex items-start gap-2.5 px-4 py-3 border-b last:border-0 transition-colors hover:bg-white/5"
      style={{ borderColor: "var(--border)" }}
      onClick={() => onClick(n.id)}
    >
      <span
        className="w-2 h-2 rounded-full shrink-0 mt-1.5"
        style={{ background: severityColor(n.severity) }}
      />
      <div className="flex-1 min-w-0">
        <p
          className="text-xs font-medium truncate"
          style={{ color: "var(--text-primary)" }}
        >
          {n.title}
        </p>
        <p className="text-xs mt-0.5 truncate" style={{ color: "var(--text-subtle)" }}>
          {formatRelative(parseDbDate(n.created_at))}
        </p>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// NotificationBell
// ---------------------------------------------------------------------------

export function NotificationBell() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const resetUnreadBump = useAppStore((s) => s.resetUnreadBump);

  const { data: unreadCount = 0 } = useUnreadNotificationCount();
  // Show only unread notifications in the bell, newest first, capped at 10
  const { data: unread = [] } = useNotificationList({ unreadOnly: true, limit: 10 });

  async function handleOpenChange(value: boolean) {
    setOpen(value);
    if (!value && unreadCount > 0) {
      // Mark all as read when bell closes
      await markAllNotificationsRead();
      resetUnreadBump();
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    }
  }

  function handleItemClick(id: string) {
    setOpen(false);
    router.push(`/notifications?highlight=${id}`);
  }

  function handleViewAll() {
    setOpen(false);
    router.push("/notifications");
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
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
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b"
          style={{ borderColor: "var(--border)" }}
        >
          <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Unread Notifications
          </span>
          {unreadCount > 0 && (
            <span
              className="text-xs px-1.5 py-0.5 rounded-full font-bold"
              style={{ background: "var(--neon-red)", color: "#000" }}
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </div>

        {/* List */}
        {unread.length === 0 ? (
          <div className="py-8 flex flex-col items-center justify-center gap-2">
            <Bell className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              All caught up
            </p>
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            {unread.map((n) => (
              <NotificationItemMini key={n.id} n={n} onClick={handleItemClick} />
            ))}
          </div>
        )}

        {/* Footer */}
        <div
          className="border-t px-4 py-2"
          style={{ borderColor: "var(--border)" }}
        >
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
