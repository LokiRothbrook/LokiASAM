import { Settings } from "lucide-react";

/** Global settings page — implemented in Phase 9. */
export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
          Settings
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
          Global application settings.
        </p>
      </div>
      <div className="glass-card flex flex-col items-center justify-center gap-4 py-24 text-center">
        <Settings className="w-10 h-10" style={{ color: "var(--text-subtle)" }} />
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Settings page — coming in Phase 9.
        </p>
      </div>
    </div>
  );
}
