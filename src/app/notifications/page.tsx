import { Bell } from "lucide-react";

/** Full notification center — implemented in Phase 8. */
export default function NotificationsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-glow-purple" style={{ color: "var(--neon-purple)" }}>
          Notifications
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
          All server events and alerts.
        </p>
      </div>
      <div className="glass-card flex flex-col items-center justify-center gap-4 py-24 text-center">
        <Bell className="w-10 h-10" style={{ color: "var(--text-subtle)" }} />
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Notification center — coming in Phase 8.
        </p>
      </div>
    </div>
  );
}
