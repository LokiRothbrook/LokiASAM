import { tauriCmd, type PortDef } from "@/lib/tauri-commands";
import { type ServerRow } from "@/lib/db";
import { dispatchNotification } from "@/lib/notifications";
import { NOTIFICATION_EVENTS } from "@/data/game-data";

/** Returns the 4-port set required for an ARK SA server. */
export function getServerFirewallPorts(server: ServerRow): PortDef[] {
  return [
    { port: server.port,         protocol: "udp" },
    { port: server.port + 1,     protocol: "udp" }, // Steam P2P peer port
    { port: server.query_port,   protocol: "udp" },
    { port: server.rcon_port,    protocol: "tcp" },
  ];
}

/**
 * Non-blocking pre-start firewall check.
 * If all ports are covered → returns silently.
 * If the firewall is inactive → returns silently.
 * If any port is missing → dispatches a warning notification and returns.
 * Does NOT block the server start.
 */
export async function warnIfFirewallMissing(server: ServerRow): Promise<void> {
  try {
    const ports = getServerFirewallPorts(server);
    const result = await tauriCmd.checkFirewallPorts(ports);

    if (!result.active) return;

    const missing = result.ports.filter((p) => !p.covered);
    if (missing.length === 0) return;

    const portList = missing
      .map((p) => `${p.port}/${p.protocol.toUpperCase()}`)
      .join(", ");

    dispatchNotification({
      eventType: NOTIFICATION_EVENTS.SERVER_START_FAILED,
      serverId: server.id,
      serverName: server.name,
      title: "Firewall rules missing",
      body:
        `Ports ${portList} are not open in your firewall for "${server.name}". ` +
        "Players may not be able to connect. Go to Settings → General → Firewall to fix.",
      severity: "warning",
    });
  } catch {
    // Never block a server start due to a firewall check error
  }
}

/**
 * Returns ports used exclusively by `server` — i.e. no other server in
 * `allServers` (excluding `server` itself) uses the same port + protocol.
 * Used to offer targeted cleanup when deleting a server.
 */
export function getExclusivePorts(
  server: ServerRow,
  allServers: ServerRow[]
): PortDef[] {
  const others = allServers.filter((s) => s.id !== server.id);
  const otherPortKeys = new Set<string>();
  for (const s of others) {
    getServerFirewallPorts(s).forEach((p) =>
      otherPortKeys.add(`${p.port}/${p.protocol}`)
    );
  }

  return getServerFirewallPorts(server).filter(
    (p) => !otherPortKeys.has(`${p.port}/${p.protocol}`)
  );
}
