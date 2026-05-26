"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useUnreadNotificationCount, useNotificationList } from "@/hooks/useNotifications";
import { markAllNotificationsRead } from "@/lib/db";
import { useAppStore } from "@/store/useAppStore";
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

function severityDot(severity: string) {
  return (
    <span
      className="w-2 h-2 rounded-full shrink-0 mt-1"
      style={{ background: severityColor(severity) }}
    />
  );
}

// ---------------------------------------------------------------------------
// Notification item (mini)
// ---------------------------------------------------------------------------

function NotificationItemMini({ n }: { n: InAppNotificationRow }) {
  const ts = new Date(n.created_at);
  const ago = formatRelative(ts);

  return (
    <div
      className="flex items-start gap-2.5 px-4 py-3 border-b last:border-0 transition-colors"
      style={{
        borderColor: "var(--border)",
        background: n.read ? "transparent" : "rgba(191,0,255,0.04)",
      }}
    >
      {severityDot(n.severity)}
      <div className="flex-1 min-w-0">
        <p
          className="text-xs font-medium truncate"
          style={{ color: n.read ? "var(--text-muted)" : "var(--text-primary)" }}
        >
          {n.title}
        </p>
        <p className="text-xs mt-0.5 truncate" style={{ color: "var(--text-subtle)" }}>
          {ago}
        </p>
      </div>
    </div>
  );
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
// NotificationBell
// ---------------------------------------------------------------------------

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const resetUnreadBump = useAppStore((s) => s.resetUnreadBump);

  const { data: unreadCount = 0 } = useUnreadNotificationCount();
  const { data: recent = [] } = useNotificationList({ limit: 10 });

  async function handleOpen(value: boolean) {
    setOpen(value);
    if (value && unreadCount > 0) {
      // Mark all read when the user opens the bell
      await markAllNotificationsRead();
      resetUnreadBump();
    }
  }

  const handleViewAll = () => {
    setOpen(false);
    router.push("/notifications");
  };

  return (
    <Popover open={open} onOpenChange={handleOpen}>
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
            Notifications
          </span>
          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                {unreadCount} unread
              </span>
            )}
          </div>
        </div>

        {/* List */}
        {recent.length === 0 ? (
          <div className="py-8 flex flex-col items-center justify-center gap-2">
            <Bell className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              No notifications yet
            </p>
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            {recent.map((n) => (
              <NotificationItemMini key={n.id} n={n} />
            ))}
          </div>
        )}

        {/* Footer */}
        <div
          className="border-t px-4 py-2 flex items-center justify-between"
          style={{ borderColor: "var(--border)" }}
        >
          <button
            onClick={handleViewAll}
            className="text-xs transition-colors hover:underline"
            style={{ color: "var(--neon-purple)" }}
          >
            View all →
          </button>
          {recent.some((n) => !n.read) && (
            <button
              onClick={async () => {
                await markAllNotificationsRead();
                resetUnreadBump();
              }}
              className="text-xs flex items-center gap-1 hover:opacity-80 transition-opacity"
              style={{ color: "var(--text-muted)" }}
            >
              <CheckCheck className="w-3 h-3" />
              Mark all read
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
