/**
 * First-time setup wizard — implemented in Phase 2.
 * Automatically redirected to on first launch when setup_complete = false.
 */
export default function SetupPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
      <h1 className="text-2xl font-bold text-glow-cyan" style={{ color: "var(--neon-cyan)" }}>
        Welcome to LokiASAM
      </h1>
      <p style={{ color: "var(--text-muted)" }}>
        Setup wizard — coming in Phase 2.
      </p>
    </div>
  );
}
