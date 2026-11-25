/**
 * tours.ts — every guided-tour step in the app, in one place.
 *
 * `target` is a `data-tour` marker on the real element (omit it for a
 * centered card). Steps whose target isn't on screen when the tour starts are
 * skipped, so a tour can mention things that only some users have (e.g. the
 * bulk server buttons only appear once servers exist).
 *
 * When adding a feature, add a step here and a `data-tour="…"` marker on its
 * element. Bump a tour's `version` when its content changes enough that
 * people who already saw it should see it again.
 */

export interface TourStep {
  target?: string;
  title: string;
  body: string;
  side?: "top" | "right" | "bottom" | "left";
}

export interface TourDef {
  id: string;
  version: number;
  steps: TourStep[];
}

/** The app-wide tour, shown once after first-time setup. */
export const MAIN_TOUR: TourDef = {
  id: "main",
  version: 1,
  steps: [
    {
      title: "Welcome to LokiASAM",
      body: "A quick look around — about a minute. You can leave any time with Esc, and replay this later from the ? button in the sidebar.",
    },
    { target: "nav-dashboard", side: "right", title: "Dashboard", body: "Every server at a glance: live status, players, CPU and RAM. Click a server to manage it." },
    { target: "dash-new-server", side: "bottom", title: "Create a server", body: "Walks you through map, game mode, rates, ports, mods and automation, then installs everything for you." },
    { target: "dash-import", side: "bottom", title: "Import an existing server", body: "Already have an ASA server installed? Point LokiASAM at its folder and it picks up the existing settings." },
    { target: "dash-actions", side: "bottom", title: "Act on every server at once", body: "Start, stop or restart all servers together. While a stop or restart is waiting, click again to force it." },
    { target: "dash-check-updates", side: "bottom", title: "Game updates", body: "Checks Steam for a new ASA build. Servers that need it are flagged, and each can update on its own schedule (Automation tab)." },
    { target: "topbar-stats", side: "bottom", title: "Totals across servers", body: "Servers, running count, players online, and combined CPU and RAM — always visible." },
    { target: "topbar-bell", side: "bottom", title: "Notifications", body: "Crashes, backups, updates and restarts land here. Choose which ones show (and which go to Discord, email or the desktop) in Settings → Notifications." },
    { target: "nav-clusters", side: "right", title: "Clusters", body: "Link servers so players can transfer characters, dinos and items between maps." },
    { target: "nav-logs", side: "right", title: "Logs", body: "Live and archived logs for every server — including crashes and chat." },
    { target: "nav-backups", side: "right", title: "Backups", body: "Every backup across all servers. Restore one with a click." },
    { target: "nav-mod-maps", side: "right", title: "Mod maps", body: "Add custom mod maps so they show up when choosing a server's map." },
    { target: "nav-settings", side: "right", title: "Settings", body: "Theme, folders, Proton, update checks, notifications and the system tray." },
    { target: "nav-help", side: "right", title: "Need a refresher?", body: "Replay this tour any time. Each server page also has its own short tour — look for the ? next to its tabs." },
    {
      target: "dash-new-server",
      side: "bottom",
      title: "Ready when you are",
      body: "Create your first server to get started. Each server page will show you around the first time you open it.",
    },
  ],
};

/** Per-tab tours on a server's page, shown the first time each tab opens. */
export const SERVER_TAB_TOURS: Record<string, TourDef> = {
  overview: {
    id: "server-overview",
    version: 1,
    steps: [
      { target: "server-tabs", side: "bottom", title: "Server tabs", body: "Everything for this server lives in these tabs. Each one shows a short tour the first time you open it." },
      { target: "ov-controls", side: "bottom", title: "Controls", body: "Start, stop and restart. Stop and Restart warn players in-game first (set the warning in Config → Warnings). While stopping, the button becomes Force Stop." },
      { target: "ov-charts", side: "top", title: "Live stats", body: "CPU, memory and players over time — pick a range up to a year. The first tile summarizes map, mods, backups and the next restart." },
      { target: "ov-active-config", side: "top", title: "Active configuration", body: "The key rates and rules at a glance, plus the exact launch command the server starts with." },
      { target: "ov-network", side: "top", title: "Network", body: "Ports and player cap. Edit → takes you to the Server Identity card." },
      { target: "ov-players", side: "top", title: "Online players", body: "Who's connected right now (via RCON)." },
    ],
  },
  config: {
    id: "server-config",
    version: 1,
    steps: [
      { target: "cfg-views", side: "bottom", title: "Ways to edit", body: "Settings (organized fields), Mod Settings (custom INI sections for mods), Advanced (launch flags, platform, hidden window, admin lists) and Raw INI." },
      { target: "cfg-identity", side: "bottom", title: "Server identity", body: "Name, passwords, ports and max players. Saved separately — straight to the game's files and the app — so they always stay in sync." },
      { target: "cfg-cluster", side: "bottom", title: "Cluster", body: "Join a cluster (or create one) so players can transfer between servers. Cluster backups live on the cluster's own page." },
      { target: "cfg-quick-setup", side: "bottom", title: "Quick Setup", body: "Re-apply a preset (PvE/PvP × Official/Casual/Boosted) — the same presets the creation wizard uses. Overlay keeps your other settings." },
      { target: "cfg-menu", side: "bottom", title: "Import & history", body: "Import an INI file or pasted text, copy another server's config, reload from disk — or open Config History to roll back to an earlier save." },
      { target: "cfg-save", side: "bottom", title: "Save", body: "Writes the INI files. A snapshot is taken first (see Config History), and you'll get a heads-up about anything that would break the server." },
    ],
  },
  mods: {
    id: "server-mods",
    version: 1,
    steps: [
      { target: "mods-list", side: "right", title: "Installed mods", body: "Load order matters — use the arrows to reorder. Toggle a mod off without removing it. The map's own mod is locked to the top." },
      { target: "mods-add", side: "top", title: "Add by ID", body: "Paste CurseForge mod IDs (comma-separated). Each is checked against CurseForge and added with its real name." },
      { target: "mods-browser", side: "left", title: "Browse CurseForge", body: "Opens CurseForge in its own window with an Add button on every mod page." },
    ],
  },
  automation: {
    id: "server-automation",
    version: 1,
    steps: [
      { target: "auto-start", side: "bottom", title: "Auto-start", body: "Start this server whenever LokiASAM opens. Pair it with Settings → Launch at Login to survive reboots." },
      { target: "auto-update", side: "bottom", title: "Auto-update", body: "Apply game updates as soon as they're found or at a set time, with the same player warning as a manual update." },
      { target: "auto-backups", side: "top", title: "Backup schedules", body: "Hourly, daily, weekly and monthly tiers, each with its own retention — plus login and full backups." },
      { target: "auto-restart", side: "top", title: "Scheduled restarts", body: "Restart on a schedule. Players get the restart warning from Config → Warnings." },
      { target: "auto-broadcast", side: "top", title: "Broadcasts", body: "Send recurring in-game messages." },
      { target: "auto-wipe_dinos", side: "top", title: "Wild dino wipe", body: "Warn players, then wipe wild dinos on a schedule." },
    ],
  },
  backups: {
    id: "server-backups",
    version: 1,
    steps: [
      { target: "backups-server", side: "top", title: "Backups", body: "World, player and full backups for this server. Restore or delete any of them; the INI snapshots below roll back config changes." },
    ],
  },
  logs: {
    id: "server-logs",
    version: 1,
    steps: [
      { target: "logs-views", side: "bottom", title: "Log views", body: "Live server log, archived logs from earlier runs, crash reports and chat history." },
    ],
  },
  rcon: {
    id: "server-rcon",
    version: 1,
    steps: [
      { target: "rcon-input", side: "top", title: "RCON console", body: "Send admin commands to the running server — ↑/↓ recall earlier commands. The bar above it broadcasts a message to everyone online." },
    ],
  },
  maintenance: {
    id: "server-maintenance",
    version: 1,
    steps: [
      { target: "maint-verify", side: "bottom", title: "Maintenance", body: "Verify or reinstall server files, wipe save data, or import saves from another server. The server must be stopped." },
    ],
  },
};
