# LokiASAM

**Loki ARK Survival Ascended Server Manager** — a desktop app for managing dedicated ASA servers on Linux and Windows.

Built with Tauri v2, Next.js, and Rust. No web browser required, no monthly subscription, no cloud dependency.

---

## Features

- **Server management** — create, start, stop, restart, clone, and delete dedicated ASA servers
- **SteamCMD integration** — automated install, update, and validation with a shared cache to speed up multi-server setups
- **Server configuration** — edit `GameUserSettings.ini` and `Game.ini` with a structured section editor or raw textarea
- **RCON console** — live terminal with command history, presets, and broadcast support
- **Live log viewer** — tail server logs in real time with filtering and auto-scroll; archives and crash logs accessible from a sidebar
- **Mod management** — install mods by ID, reorder, toggle, and browse CurseForge from within the app
- **Scheduled automation** — cron-based schedules for backups, updates, restarts, and RCON broadcasts; runs fully in the background even when the window is hidden
- **TimeShift backups** — server, player, and full-install backups with hourly/daily/weekly/monthly retention tiers, automatic pruning, and restore support
- **Player connection tracking** — log player logins with optional per-login player backups
- **Cluster support** — group servers into clusters with a shared directory
- **Notifications** — Discord webhooks, email (SMTP), desktop OS notifications, and in-app toasts for server events including backups, crashes, updates, and more
- **Proton-GE** — automatic detection and download on Linux for running the Windows server binary
- **System tray** — minimizes to tray; server processes and scheduled tasks keep running while the window is hidden
- **Auto-update** — checks for app updates and installs them in the background (AppImage, `.deb`, and `.rpm` builds); PKGBUILD users are notified to rebuild manually
- **Firewall management** — optional firewall rule helpers for server ports
- **Graceful restart** — countdown restart with configurable warning broadcasts to online players

---

## Download

Pre-built installers are on the [Releases](https://github.com/LokiRothbrook/LokiASAM/releases) page.

### Debian / Ubuntu / Linux Mint

Download and install the `.deb` package:

```bash
sudo dpkg -i LokiASAM_*_amd64.deb
sudo apt-get install -f   # pull in any missing dependencies
```

### Fedora / openSUSE / RHEL-based

Download and install the `.rpm` package:

```bash
sudo rpm -i LokiASAM_*_x86_64.rpm
# or with dnf:
sudo dnf install ./LokiASAM_*_x86_64.rpm
```

### Arch Linux / CachyOS / Manjaro

AppImage and pre-built binaries do not work reliably on rolling-release distros due to bundled library conflicts. Build from source instead:

```bash
git clone https://github.com/LokiRothbrook/LokiASAM.git
cd LokiASAM/packaging/arch
makepkg -si
```

`makepkg -si` builds the app using your system's native libraries and installs it via pacman — icons, the `.desktop` entry, and shell integration all work correctly out of the box.

To uninstall:

```bash
sudo pacman -R lokiasam
```

To update, pull the latest source and rebuild:

```bash
cd LokiASAM
git pull
cd packaging/arch
makepkg -si
```

### Generic Linux (AppImage)

> **Note:** AppImage does not work on Arch-based systems (Arch, CachyOS, Manjaro). Use the PKGBUILD method above instead.

```bash
chmod +x LokiASAM_*.AppImage
./LokiASAM_*.AppImage
```

On first run you will be prompted to register the app in your application menu. Accepting writes the `.desktop` file and icon to `~/.local/share/` so the launcher and taskbar icon work correctly.

### Windows

Run the `LokiASAM_*_x64-setup.exe` installer.

---

## Building from Source

**Requirements**

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 9+
- Linux: `webkit2gtk-4.1`, `libappindicator-gtk3`, `librsvg`, `patchelf`
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
