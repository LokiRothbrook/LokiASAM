#!/usr/bin/env bash
set -euo pipefail

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

case "$FAMILY" in
    arch)
        sudo pacman -R lokiasam
        ;;
    deb)
        sudo apt remove -y lokiasam 2>/dev/null || sudo dpkg -r lokiasam
        ;;
    rpm)
        if command -v dnf &>/dev/null; then
            sudo dnf remove -y lokiasam
        elif command -v zypper &>/dev/null; then
            sudo zypper remove -y lokiasam
        else
            sudo rpm -e lokiasam
        fi
        ;;
    *)
        echo "ERROR: Could not detect a supported Linux distribution."
        echo "Remove manually: the binary is at /usr/bin/lokiasam"
        exit 1
        ;;
esac

echo "==> LokiASAM uninstalled."
