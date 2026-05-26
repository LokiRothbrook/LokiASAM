"use client";

import { useState, useCallback } from "react";
import { Bell, CheckCheck, Filter, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNotificationList } from "@/hooks/useNotifications";
import {
  markAllNotificationsRead,
  markNotificationRead,
  pruneOldNotifications,
  type InAppNotificationRow,
} from "@/lib/db";
import { useAppStore } from "@/store/useAppStore";
import { NOTIFICATION_EVENT_LABELS } from "@/data/game-data";

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

function severityColor(severity: string): string {
  switch (severity) {
    case "success": return "var(--neon-green)";
    case "warning": return "var(--neon-cyan)";
    case "error":   return "var(--neon-red)";
    default:        return "var(--text-muted)";
  }
}

function SeverityDot({ severity }: { severity: string }) {
  return (
    <span
      className="w-2.5 h-2.5 rounded-full shrink-0 mt-1"
      style={{
        background: severityColor(severity),
        boxShadow: `0 0 6px ${severityColor(severity)}`,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Notification row
// ---------------------------------------------------------------------------

function NotificationRow({
  n,
  onMarkRead,
}: {
  n: InAppNotificationRow;
  onMarkRead: (id: string) => void;
}) {
  const ts = new Date(n.created_at);
  const label =
    NOTIFICATION_EVENT_LABELS[n.event_type as keyof typeof NOTIFICATION_EVENT_LABELS] ??
    n.event_type;

  return (
    <div
      className="flex items-start gap-3 px-5 py-4 border-b last:border-0 transition-colors group"
      style={{
        borderColor: "var(--border)",
        background: n.read ? "transparent" : "rgba(191,0,255,0.04)",
      }}
    >
      <SeverityDot severity={n.severity} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className="text-sm font-semibold"
            style={{ color: n.read ? "var(--text-muted)" : "var(--text-primary)" }}
          >
            {n.title}
          </span>
          <span
            className="text-xs shrink-0"
            style={{ color: "var(--text-subtle)" }}
          >
            {ts.toLocaleString()}
          </span>
        </div>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
          {n.body}
        </p>
        <div className="flex items-center gap-3 mt-1.5">
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-mono"
            style={{
              background: "rgba(255,255,255,0.05)",
              color: "var(--text-subtle)",
              border: "1px solid var(--border)",
            }}
          >
            {label}
          </span>
          {!n.read && (
            <button
              onClick={() => onMarkRead(n.id)}
              className="text-[10px] hover:underline opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ color: "var(--neon-purple)" }}
            >
              Mark read
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const SEVERITY_OPTIONS = [
  { value: "all",     label: "All Severities" },
  { value: "info",    label: "Info" },
  { value: "success", label: "Success" },
  { value: "warning", label: "Warning" },
  { value: "error",   label: "Error" },
];

export default function NotificationsPage() {
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const resetUnreadBump = useAppStore((s) => s.resetUnreadBump);
  const incrementUnread = useAppStore((s) => s.incrementUnread);

  const { data: notifications = [], refetch } = useNotificationList({ limit: 200 });

  const filtered = notifications.filter((n) => {
    if (severityFilter !== "all" && n.severity !== severityFilter) return false;
    if (unreadOnly && n.read) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        n.title.toLowerCase().includes(q) ||
        n.body.toLowerCase().includes(q) ||
        n.event_type.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const handleMarkRead = useCallback(async (id: string) => {
    await markNotificationRead(id);
    refetch();
  }, [refetch]);

  const handleMarkAllRead = useCallback(async () => {
    await markAllNotificationsRead();
    resetUnreadBump();
    refetch();
    toast.success("All notifications marked as read.");
  }, [refetch, resetUnreadBump]);

  const handlePrune = useCallback(async (days: number) => {
    await pruneOldNotifications(days);
    refetch();
    toast.success(`Notifications older than ${days} days deleted.`);
  }, [refetch]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1
            className="text-2xl font-bold"
            style={{ color: "var(--neon-purple)", textShadow: "var(--glow-purple)" }}
          >
            Notifications
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
            Event log for all managed servers.
            {unreadCount > 0 && (
              <span
                className="ml-2 font-semibold"
                style={{ color: "var(--neon-red)" }}
              >
                {unreadCount} unread
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleMarkAllRead}
              className="text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              <CheckCheck className="w-3.5 h-3.5 mr-1.5" />
              Mark all read
            </Button>
          )}
          <Select
            value="prune"
            onValueChange={(v) => {
              if (v === "7")  handlePrune(7);
              if (v === "30") handlePrune(30);
            }}
          >
            <SelectTrigger
              className="h-8 text-xs w-36"
              style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text-muted)" }}
            >
              <Trash2 className="w-3 h-3 mr-1.5" />
              <SelectValue placeholder="Prune…" />
            </SelectTrigger>
            <SelectContent style={{ background: "var(--surface-elevated)", borderColor: "var(--border)" }}>
              <SelectItem value="7">Delete older than 7d</SelectItem>
              <SelectItem value="30">Delete older than 30d</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Filters */}
      <div
        className="glass-card flex flex-wrap items-center gap-3 p-4 rounded-xl"
        style={{ border: "1px solid var(--border)" }}
      >
        <Filter className="w-4 h-4 shrink-0" style={{ color: "var(--text-subtle)" }} />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search notifications…"
          className="h-8 text-xs flex-1 min-w-36"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        />
        <Select value={severityFilter} onValueChange={setSeverityFilter}>
          <SelectTrigger
            className="h-8 text-xs w-40"
            style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent style={{ background: "var(--surface-elevated)", borderColor: "var(--border)" }}>
            {SEVERITY_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          onClick={() => setUnreadOnly((v) => !v)}
          className="text-xs px-3 py-1.5 rounded transition-all"
          style={{
            background: unreadOnly ? "rgba(191,0,255,0.15)" : "transparent",
            border: `1px solid ${unreadOnly ? "var(--neon-purple)" : "var(--border)"}`,
            color: unreadOnly ? "var(--neon-purple)" : "var(--text-muted)",
          }}
        >
          Unread only
        </button>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div
          className="glass-card flex flex-col items-center justify-center gap-4 py-24 text-center rounded-xl"
          style={{ border: "1px solid var(--border)" }}
        >
          <Bell className="w-10 h-10" style={{ color: "var(--text-subtle)" }} />
          <div>
            <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
              {notifications.length === 0 ? "No notifications yet" : "No matching notifications"}
            </p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              {notifications.length === 0
                ? "Events like server starts, stops, crashes, and backups will appear here."
                : "Try adjusting your filters."}
            </p>
          </div>
        </div>
      ) : (
        <div
          className="glass-card overflow-hidden rounded-xl"
          style={{ border: "1px solid var(--border)" }}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: "var(--border)" }}>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {filtered.length} notification{filtered.length !== 1 ? "s" : ""}
            </span>
          </div>
          {filtered.map((n) => (
            <NotificationRow key={n.id} n={n} onMarkRead={handleMarkRead} />
          ))}
        </div>
      )}
    </div>
  );
}
