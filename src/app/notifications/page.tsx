"use client";

import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Bell, Filter, Trash2, X } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useNotificationList } from "@/hooks/useNotifications";
import {
  markAllNotificationsRead,
  deleteNotification,
  pruneNotificationsWithFilter,
  parseDbDate,
  type InAppNotificationRow,
} from "@/lib/db";
import { useAppStore } from "@/store/useAppStore";
import { NOTIFICATION_EVENT_LABELS, NOTIFICATION_EVENTS } from "@/data/game-data";
import { useQueryClient } from "@tanstack/react-query";

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
  highlighted,
  onDelete,
}: {
  n: InAppNotificationRow;
  highlighted: boolean;
  onDelete: (id: string) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const label =
    NOTIFICATION_EVENT_LABELS[n.event_type as keyof typeof NOTIFICATION_EVENT_LABELS] ??
    n.event_type;

  useEffect(() => {
    if (highlighted && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlighted]);

  return (
    <div
      ref={rowRef}
      id={`notif-${n.id}`}
      className="flex items-start gap-3 px-5 py-4 border-b last:border-0 transition-all group"
      style={{
        borderColor: "var(--border)",
        background: highlighted
          ? "rgba(var(--neon-purple-rgb),0.12)"
          : "transparent",
        outline: highlighted ? "1px solid rgba(var(--neon-purple-rgb),0.4)" : "none",
      }}
    >
      <SeverityDot severity={n.severity} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className="text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            {n.title}
          </span>
          <span
            className="text-xs shrink-0"
            style={{ color: "var(--text-subtle)" }}
          >
            {parseDbDate(n.created_at).toLocaleString()}
          </span>
        </div>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
          {n.body}
        </p>
        <div className="mt-1.5">
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
        </div>
      </div>
      <button
        onClick={() => onDelete(n.id)}
        className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5 p-1 rounded hover:bg-white/10"
        style={{ color: "var(--text-subtle)" }}
        title="Delete notification"
      >
        <X className="w-3.5 h-3.5" />
      </button>
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

const EVENT_TYPE_OPTIONS = [
  { value: "all", label: "All Types" },
  ...Object.values(NOTIFICATION_EVENTS).map((v) => ({
    value: v,
    label: NOTIFICATION_EVENT_LABELS[v as keyof typeof NOTIFICATION_EVENT_LABELS] ?? v,
  })),
];

function NotificationsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const highlightId = searchParams.get("highlight");

  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [eventTypeFilter, setEventTypeFilter] = useState("all");
  const [highlighted, setHighlighted] = useState<string | null>(highlightId);
  const resetUnreadBump = useAppStore((s) => s.resetUnreadBump);

  const { data: notifications = [], refetch } = useNotificationList({ limit: 500 });

  // Mark all as read and clear the highlight param on page load
  useEffect(() => {
    markAllNotificationsRead().then(() => {
      resetUnreadBump();
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    });
    if (highlightId) {
      // Clear the URL param after a moment without re-fetching
      const timeout = setTimeout(() => {
        setHighlighted(null);
        router.replace("/notifications", { scroll: false });
      }, 3000);
      return () => clearTimeout(timeout);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = notifications.filter((n) => {
    if (severityFilter !== "all" && n.severity !== severityFilter) return false;
    if (eventTypeFilter !== "all" && n.event_type !== eventTypeFilter) return false;
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

  const handleDelete = useCallback(async (id: string) => {
    await deleteNotification(id);
    refetch();
  }, [refetch]);

  const handleBulkDelete = useCallback(async (days?: number) => {
    const daysLabel = days ? `older than ${days} day${days === 1 ? "" : "s"}` : "all";
    await pruneNotificationsWithFilter({
      days,
      severity: severityFilter !== "all" ? severityFilter : undefined,
      eventType: eventTypeFilter !== "all" ? eventTypeFilter : undefined,
    });
    refetch();
    toast.success(`Deleted ${daysLabel} notifications${severityFilter !== "all" || eventTypeFilter !== "all" ? " matching current filter" : ""}.`);
  }, [refetch, severityFilter, eventTypeFilter]);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-3">
            <Bell className="w-6 h-6 shrink-0" style={{ color: "var(--neon-purple)" }} />
            <h1
              className="text-2xl font-bold"
              style={{ color: "var(--neon-purple)", textShadow: "var(--glow-purple)" }}
            >
              Notifications
            </h1>
          </div>
          <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
            Event log for all managed servers.
          </p>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs gap-1.5"
              style={{ color: "var(--text-muted)", border: "1px solid var(--border)" }}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete…
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            style={{ background: "var(--surface-elevated)", border: "1px solid var(--border)" }}
          >
            <DropdownMenuItem
              onClick={() => handleBulkDelete(1)}
              style={{ color: "var(--text-primary)" }}
            >
              Older than 1 day
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleBulkDelete(7)}
              style={{ color: "var(--text-primary)" }}
            >
              Older than 7 days
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleBulkDelete(30)}
              style={{ color: "var(--text-primary)" }}
            >
              Older than 30 days
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => handleBulkDelete(undefined)}
              style={{ color: "var(--neon-red)" }}
            >
              Delete all{severityFilter !== "all" || eventTypeFilter !== "all" ? " (filtered)" : ""}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
        <Select value={eventTypeFilter} onValueChange={setEventTypeFilter}>
          <SelectTrigger
            className="h-8 text-xs w-48"
            style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent style={{ background: "var(--surface-elevated)", borderColor: "var(--border)" }}>
            {EVENT_TYPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
            <NotificationRow
              key={n.id}
              n={n}
              highlighted={highlighted === n.id}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page export — wraps with Suspense for useSearchParams
// ---------------------------------------------------------------------------

export default function NotificationsPage() {
  return (
    <Suspense fallback={<div className="flex flex-col gap-4"><div className="h-8 w-48 rounded animate-pulse" style={{ background: "var(--surface)" }} /></div>}>
      <NotificationsContent />
    </Suspense>
  );
}
