#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# ---------------------------------------------------------------------------
# Distro detection
# ---------------------------------------------------------------------------
detect_family() {
    if [[ ! -f /etc/os-release ]]; then
        echo "unknown"
        return
    fi
    local id id_like
    id=$(grep -E '^ID=' /etc/os-release | cut -d= -f2 | tr -d '"')
    id_like=$(grep -E '^ID_LIKE=' /etc/os-release | cut -d= -f2 | tr -d '"' || true)

    if [[ "$id" == "arch" || "$id_like" == *"arch"* ]]; then
        echo "arch"
    elif [[ "$id" == "debian" || "$id_like" == *"debian"* ]]; then
        echo "deb"
    elif [[ "$id" == "fedora" || "$id" == "rhel" || "$id" == "centos" || \
            "$id" == opensuse* || "$id_like" == *"fedora"* || \
            "$id_like" == *"rhel"* || "$id_like" == *"suse"* ]]; then
        echo "rpm"
    else
        echo "unknown"
    fi
}

FAMILY=$(detect_family)

if [[ "$FAMILY" == "unknown" ]]; then
    echo "ERROR: Could not detect a supported Linux distribution."
    echo "Supported: Arch/CachyOS/Manjaro, Debian/Ubuntu/Mint, Fedora/openSUSE/RHEL"
    exit 1
fi

echo "==> Detected package family: $FAMILY"

# ---------------------------------------------------------------------------
# Install JS dependencies (all distros)
# ---------------------------------------------------------------------------
echo "==> Installing JS dependencies..."
pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Build and install
# ---------------------------------------------------------------------------
case "$FAMILY" in
    arch)
        echo "==> Building LokiASAM (no bundle)..."
        pnpm tauri build --no-bundle

        echo "==> Installing via pacman..."
        cd packaging/arch
        makepkg -si
        ;;

    deb)
        echo "==> Building LokiASAM .deb package..."
        pnpm tauri build --bundles deb

        DEB=$(find src-tauri/target/release/bundle/deb -name "*.deb" | head -1)
        if [[ -z "$DEB" ]]; then
            echo "ERROR: .deb package not found after build."
            exit 1
        fi

        echo "==> Installing $DEB..."
        sudo dpkg -i "$DEB"
        sudo apt-get install -f -y
        ;;

    rpm)
        echo "==> Building LokiASAM .rpm package..."
        pnpm tauri build --bundles rpm

        RPM=$(find src-tauri/target/release/bundle/rpm -name "*.rpm" | head -1)
        if [[ -z "$RPM" ]]; then
            echo "ERROR: .rpm package not found after build."
            exit 1
        fi

        echo "==> Installing $RPM..."
        if command -v dnf &>/dev/null; then
            sudo dnf install -y "$RPM"
        elif command -v zypper &>/dev/null; then
            sudo zypper install -y "$RPM"
        else
            sudo rpm -i "$RPM"
        fi
        ;;
esac

echo "==> LokiASAM installed successfully."
