# LokiASAM

**Loki Ark Survival Ascended Server Manager** — a desktop app for managing dedicated ASA servers on Linux and Windows.

Built with Tauri v2, Next.js, and Rust. No web browser required, no monthly subscription, no cloud dependency.

---

## Features

- **Server management** — create, start, stop, restart, clone, and delete dedicated ASA servers
- **SteamCMD integration** — automated install, update, and validation with a shared cache to speed up multi-server setups
- **Server configuration** — edit `GameUserSettings.ini` and `Game.ini` with a structured section editor or raw textarea
- **RCON console** — live terminal with command history, presets, and broadcast support
- **Live log viewer** — tail server logs in real time with filtering and auto-scroll
- **Mod management** — install mods by ID, reorder, toggle, and browse CurseForge from within the app
- **Scheduled automation** — cron-based schedules for backups, updates, restarts, and RCON broadcasts
- **Backup and restore** — create, restore, and prune ZIP backups per server with retention settings
- **Cluster support** — group servers into clusters with a shared directory
- **Notifications** — Discord webhooks, email (SMTP), and desktop notifications for server events
- **Proton-GE** — automatic detection and download on Linux for running the Windows server binary
- **System tray** — minimizes to tray; server processes keep running while the window is hidden
- **Auto-update** — checks for app updates and installs them in the background

---

## Download

Pre-built installers are on the [Releases](https://github.com/LokiRothbrook/LokiASAM/releases) page.

**Linux:** Download the `.AppImage`, make it executable, and run it.
```bash
chmod +x LokiASAM_*.AppImage
./LokiASAM_*.AppImage
```

**Windows:** Run the `LokiASAM_*_x64-setup.exe` installer.

---

## Building from Source

**Requirements**

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 9+
- Linux: `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`
- Windows: WebView2 (ships with Windows 11; installer available for Windows 10)

**Steps**

```bash
git clone https://github.com/LokiRothbrook/LokiASAM.git
cd LokiASAM
pnpm install
pnpm tauri dev        # development mode
pnpm tauri build      # production build
```

---

## First Run

On first launch you will be guided through a one-time setup wizard to choose a base directory and configure SteamCMD. After that you can create your first server.

---

## License

LokiASAM is free software licensed under the [GNU General Public License v3.0](LICENSE).
