/**
 * Server creation wizard — implemented in Phase 2.
 * Multi-step wizard for creating and installing a new ASA server.
 */
export default function NewServerPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
      <h1 className="text-2xl font-bold" style={{ color: "var(--neon-cyan)" }}>
        Create New Server
      </h1>
      <p style={{ color: "var(--text-muted)" }}>
        Server creation wizard — coming in Phase 2.
      </p>
    </div>
  );
}
