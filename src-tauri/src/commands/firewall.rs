use serde::{Deserialize, Serialize};
use tokio::process::Command;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortDef {
    pub port: u16,
    pub protocol: String, // "tcp" | "udp"
}

#[derive(Debug, Serialize)]
pub struct PortStatus {
    pub port: u16,
    pub protocol: String,
    pub covered: bool,
}

#[derive(Debug, Serialize)]
pub struct FirewallStatus {
    /// "none" | "ufw" | "firewalld" | "iptables" | "nftables" | "windows"
    pub firewall_type: String,
    /// false means no active firewall — no rules needed
    pub active: bool,
    pub ports: Vec<PortStatus>,
}

// ---------------------------------------------------------------------------
// Platform: Windows
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;

    fn rule_name(port: u16, protocol: &str) -> String {
        format!("LokiASAM-{port}-{protocol}")
    }

    pub async fn check_ports(ports: &[PortDef]) -> FirewallStatus {
        let mut statuses = Vec::new();
        for p in ports {
            let name = rule_name(p.port, &p.protocol);
            let covered = Command::new("netsh")
                .args(["advfirewall", "firewall", "show", "rule", &format!("name={name}"), "dir=in"])
                .output()
                .await
                .map(|o| o.status.success())
                .unwrap_or(false);
            statuses.push(PortStatus { port: p.port, protocol: p.protocol.clone(), covered });
        }
        FirewallStatus { firewall_type: "windows".into(), active: true, ports: statuses }
    }

    pub async fn add_rules(ports: &[PortDef]) -> Result<(), String> {
        for p in ports {
            let name = rule_name(p.port, &p.protocol);
            let proto = p.protocol.to_uppercase();
            let port_str = p.port.to_string();

            // Check first — skip if already present
            let exists = Command::new("netsh")
                .args(["advfirewall", "firewall", "show", "rule", &format!("name={name}"), "dir=in"])
                .output()
                .await
                .map(|o| o.status.success())
                .unwrap_or(false);

            if exists {
                continue;
            }

            let status = runas::Command::new("netsh")
                .args(&[
                    "advfirewall", "firewall", "add", "rule",
                    &format!("name={name}"),
                    "dir=in", "action=allow",
                    &format!("protocol={proto}"),
                    &format!("localport={port_str}"),
                ])
                .status()
                .map_err(|e| format!("Failed to run elevated netsh for port {}: {e}", p.port))?;

            if !status.success() {
                return Err(format!(
                    "netsh exited with code {} for port {}",
                    status.code().unwrap_or(-1),
                    p.port
                ));
            }
        }
        Ok(())
    }

    pub async fn remove_rules(ports: &[PortDef]) -> Result<(), String> {
        for p in ports {
            let name = rule_name(p.port, &p.protocol);
            let status = runas::Command::new("netsh")
                .args(&[
                    "advfirewall", "firewall", "delete", "rule",
                    &format!("name={name}"),
                ])
                .status()
                .map_err(|e| format!("Failed to run elevated netsh delete for port {}: {e}", p.port))?;

            if !status.success() {
                // Non-fatal: rule may already be gone
                log::warn!("netsh delete exited {} for port {}", status.code().unwrap_or(-1), p.port);
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Platform: Linux
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod linux_impl {
    use super::*;
    use std::path::Path;

    // ── Firewall detection ───────────────────────────────────────────────────

    pub enum FirewallKind {
        Ufw,
        Firewalld,
        Iptables,
        None,
    }

    pub async fn detect() -> FirewallKind {
        // Check firewalld first (most specific D-Bus interface)
        if which("firewall-cmd").await && service_active("firewalld").await {
            return FirewallKind::Firewalld;
        }
        // Then ufw
        if which("ufw").await {
            // ufw can be installed but inactive; we handle both cases in check_ports
            return FirewallKind::Ufw;
        }
        // Fall back to iptables
        if which("iptables").await {
            return FirewallKind::Iptables;
        }
        FirewallKind::None
    }

    async fn which(cmd: &str) -> bool {
        Command::new("which")
            .arg(cmd)
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    async fn service_active(name: &str) -> bool {
        Command::new("systemctl")
            .args(["is-active", "--quiet", name])
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false)
    }

    async fn ufw_is_active() -> bool {
        // Try reading ufw status without root; ufw status itself requires root,
        // but we can check if the profile file was written by us (world-readable).
        // For the "is active" question we spawn ufw with pkexec only when needed.
        // Cheap heuristic: profile file exists → we set it up → treat as active.
        Path::new("/etc/ufw/applications.d/lokiasam").exists()
            || service_active("ufw").await
    }

    // ── UFW ─────────────────────────────────────────────────────────────────

    const UFW_PROFILE_PATH: &str = "/etc/ufw/applications.d/lokiasam";
    const UFW_APP_NAME: &str = "lokiasam";

    /// Parse the ports line from the lokiasam ufw profile.
    /// Returns a set of "port/proto" strings like {"7777/udp", "27020/tcp"}.
    pub fn parse_ufw_profile() -> std::collections::HashSet<String> {
        let Ok(content) = std::fs::read_to_string(UFW_PROFILE_PATH) else {
            return Default::default();
        };
        let mut set = std::collections::HashSet::new();
        for line in content.lines() {
            let line = line.trim();
            if !line.starts_with("ports=") {
                continue;
            }
            // Format: ports=7777,7778/udp|27015/udp|27020/tcp
            // Each segment is either "port/proto" or "p1,p2/proto"
            let segments = line.trim_start_matches("ports=");
            for segment in segments.split('|') {
                let segment = segment.trim();
                if let Some(slash) = segment.rfind('/') {
                    let proto = &segment[slash + 1..];
                    let ports_part = &segment[..slash];
                    for p in ports_part.split(',') {
                        set.insert(format!("{}/{}", p.trim(), proto));
                    }
                }
            }
        }
        set
    }

    /// Build the ports= line for the ufw profile from a list of PortDef.
    /// Each port is its own `|`-separated segment (e.g. `27020/tcp|7777/udp|27015/udp`).
    /// Comma-grouping (`7777,27015/udp`) is avoided because some UFW versions silently
    /// drop segments that follow a comma-grouped entry when mixed protocols are present.
    /// TCP entries come first to match the convention used by other application profiles.
    fn build_ufw_ports_line(ports: &[PortDef]) -> String {
        let mut udp: Vec<u16> = ports.iter().filter(|p| p.protocol == "udp").map(|p| p.port).collect();
        let mut tcp: Vec<u16> = ports.iter().filter(|p| p.protocol == "tcp").map(|p| p.port).collect();
        udp.sort_unstable();
        udp.dedup();
        tcp.sort_unstable();
        tcp.dedup();

        let mut segments: Vec<String> = Vec::new();
        for p in &udp { segments.push(format!("{p}/udp")); }
        for p in &tcp { segments.push(format!("{p}/tcp")); }
        segments.join("|")
    }

    fn build_ufw_profile(ports: &[PortDef]) -> String {
        let ports_line = build_ufw_ports_line(ports);
        format!(
            "[{UFW_APP_NAME}]\ntitle=LokiASAM ARK Server\ndescription=ARK Survival Ascended Server Ports\nports={ports_line}\n"
        )
    }

    pub async fn check_ufw(ports: &[PortDef]) -> FirewallStatus {
        let active = ufw_is_active().await;
        if !active {
            let statuses = ports.iter().map(|p| PortStatus {
                port: p.port, protocol: p.protocol.clone(), covered: false,
            }).collect();
            return FirewallStatus { firewall_type: "ufw".into(), active: false, ports: statuses };
        }

        let covered_set = parse_ufw_profile();
        let statuses = ports.iter().map(|p| {
            let key = format!("{}/{}", p.port, p.protocol);
            PortStatus { port: p.port, protocol: p.protocol.clone(), covered: covered_set.contains(&key) }
        }).collect();
        FirewallStatus { firewall_type: "ufw".into(), active: true, ports: statuses }
    }

    /// Set the UFW application profile to exactly `desired_ports` and apply it.
    /// Writes a fresh profile (TCP entries first, one port per `|` segment) then does
    /// delete → re-allow so UFW picks up the new profile cleanly.
    /// If `desired_ports` is empty, deletes the rule and the profile file entirely.
    pub async fn apply_ufw_state(desired_ports: &[PortDef]) -> Result<(), String> {
        if desired_ports.is_empty() {
            let cmd = format!("ufw delete allow '{UFW_APP_NAME}' ; rm -f '{UFW_PROFILE_PATH}'");
            let status = Command::new("pkexec")
                .args(["sh", "-c", &cmd])
                .status()
                .await
                .map_err(|e| format!("pkexec ufw delete failed: {e}"))?;
            if !status.success() {
                return Err(format!("pkexec ufw delete exited {}", status.code().unwrap_or(-1)));
            }
            return Ok(());
        }

        let tmp_path = std::env::temp_dir().join("lokiasam_ufw_profile");
        std::fs::write(&tmp_path, build_ufw_profile(desired_ports))
            .map_err(|e| format!("Failed to write UFW temp profile: {e}"))?;

        let tmp_str = tmp_path.to_string_lossy();
        // Copy profile first (`&&` ensures allow only runs if cp succeeded), then
        // delete the old rule (`;` so allow still runs even if no rule existed yet),
        // then re-allow from the updated profile.
        let cmd = format!(
            "cp '{tmp_str}' '{UFW_PROFILE_PATH}' && ufw delete allow '{UFW_APP_NAME}' ; ufw allow '{UFW_APP_NAME}'"
        );
        let status = Command::new("pkexec")
            .args(["sh", "-c", &cmd])
            .status()
            .await
            .map_err(|e| format!("pkexec ufw apply failed: {e}"))?;

        let _ = std::fs::remove_file(&tmp_path);

        if !status.success() {
            return Err(format!("pkexec ufw apply exited {}", status.code().unwrap_or(-1)));
        }
        Ok(())
    }

    // ── firewalld ────────────────────────────────────────────────────────────

    pub async fn check_firewalld(ports: &[PortDef]) -> FirewallStatus {
        let mut statuses = Vec::new();
        for p in ports {
            let arg = format!("{}/{}", p.port, p.protocol);
            let covered = Command::new("firewall-cmd")
                .args(["--query-port", &arg])
                .status()
                .await
                .map(|s| s.success())
                .unwrap_or(false);
            statuses.push(PortStatus { port: p.port, protocol: p.protocol.clone(), covered });
        }
        FirewallStatus { firewall_type: "firewalld".into(), active: true, ports: statuses }
    }

    pub async fn add_firewalld(ports: &[PortDef]) -> Result<(), String> {
        // Check which ports aren't already open (no elevation needed for --query-port)
        let mut to_add = Vec::new();
        for p in ports {
            let arg = format!("{}/{}", p.port, p.protocol);
            let already = Command::new("firewall-cmd")
                .args(["--query-port", &arg])
                .status().await
                .map(|s| s.success()).unwrap_or(false);
            if !already { to_add.push(arg); }
        }
        if to_add.is_empty() { return Ok(()); }

        // Batch all --add-port flags + --reload into a single pkexec sh call
        let add_flags = to_add.iter().map(|a| format!("--add-port={a}")).collect::<Vec<_>>().join(" ");
        let cmd = format!("firewall-cmd --permanent {add_flags} && firewall-cmd --reload");
        let s = Command::new("pkexec")
            .args(["sh", "-c", &cmd])
            .status().await
            .map_err(|e| format!("pkexec firewall-cmd failed: {e}"))?;
        if !s.success() {
            return Err(format!("firewall-cmd add/reload exited {}", s.code().unwrap_or(-1)));
        }
        Ok(())
    }

    /// Remove firewall rules for ports NOT in `remaining_ports`.
    /// Queries `firewall-cmd --list-ports` (no elevation) to find what is currently
    /// open, then removes only the excess — never touches ports still in use.
    pub async fn remove_firewalld(remaining_ports: &[PortDef]) -> Result<(), String> {
        let remaining_set: std::collections::HashSet<String> = remaining_ports
            .iter().map(|p| format!("{}/{}", p.port, p.protocol)).collect();

        // Query current open ports without elevation
        let text = match Command::new("firewall-cmd").args(["--list-ports"]).output().await {
            Ok(o) => String::from_utf8_lossy(&o.stdout).into_owned(),
            Err(_) => return Ok(()), // can't query current state — skip rather than error
        };

        let to_remove: Vec<String> = text
            .split_whitespace()
            .filter(|s| !remaining_set.contains(*s))
            .map(|s| s.to_string())
            .collect();

        if to_remove.is_empty() { return Ok(()); }

        let remove_flags = to_remove.iter()
            .map(|s| format!("--remove-port={s}"))
            .collect::<Vec<_>>().join(" ");
        let cmd = format!("firewall-cmd --permanent {remove_flags} && firewall-cmd --reload");
        let status = Command::new("pkexec")
            .args(["sh", "-c", &cmd])
            .status()
            .await
            .map_err(|e| format!("pkexec firewall-cmd remove failed: {e}"))?;
        if !status.success() {
            return Err(format!("firewall-cmd remove/reload exited {}", status.code().unwrap_or(-1)));
        }
        Ok(())
    }

    // ── iptables (DB-backed fallback) ────────────────────────────────────────

    pub async fn add_iptables(ports: &[PortDef]) -> Result<(), String> {
        if ports.is_empty() { return Ok(()); }
        let cmds = ports.iter()
            .map(|p| format!("iptables -A INPUT -p {} --dport {} -j ACCEPT", p.protocol, p.port))
            .collect::<Vec<_>>().join(" && ");
        let s = Command::new("pkexec")
            .args(["sh", "-c", &cmds])
            .status().await
            .map_err(|e| format!("pkexec iptables failed: {e}"))?;
        if !s.success() {
            return Err(format!("iptables add exited {}", s.code().unwrap_or(-1)));
        }
        Ok(())
    }

    /// Remove iptables rules for ports NOT in `remaining_ports`.
    /// Parses `iptables -S INPUT` (no elevation) to find current ACCEPT rules,
    /// then removes only the ones that are no longer needed.
    pub async fn remove_iptables(remaining_ports: &[PortDef]) -> Result<(), String> {
        let remaining_set: std::collections::HashSet<String> = remaining_ports
            .iter().map(|p| format!("{}/{}", p.protocol, p.port)).collect();

        let text = match Command::new("iptables").args(["-S", "INPUT"]).output().await {
            Ok(o) => String::from_utf8_lossy(&o.stdout).into_owned(),
            Err(_) => return Ok(()), // can't query current state — skip rather than error
        };

        // Match lines like: -A INPUT -p udp --dport 7777 -j ACCEPT
        let mut to_remove: Vec<String> = Vec::new();
        for line in text.lines() {
            if !line.contains("-j ACCEPT") { continue; }
            let proto = ["udp", "tcp"].iter().find(|&&pr| line.contains(&format!("-p {pr} ")));
            let dport = line.split("--dport ").nth(1).and_then(|s| s.split_whitespace().next());
            if let (Some(proto), Some(port)) = (proto, dport) {
                if !remaining_set.contains(&format!("{proto}/{port}")) {
                    to_remove.push(format!("iptables -D INPUT -p {proto} --dport {port} -j ACCEPT"));
                }
            }
        }

        if to_remove.is_empty() { return Ok(()); }
        // Use ; so a missing rule doesn't abort removal of the remaining ones
        let cmds = to_remove.join(" ; ");
        let status = Command::new("pkexec")
            .args(["sh", "-c", &cmds])
            .status()
            .await
            .map_err(|e| format!("pkexec iptables remove failed: {e}"))?;
        if !status.success() {
            return Err(format!("iptables remove exited {}", status.code().unwrap_or(-1)));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Check firewall status for the given ports. Non-elevated on all platforms.
#[tauri::command]
pub async fn check_firewall_ports(ports: Vec<PortDef>) -> Result<FirewallStatus, String> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::check_ports(&ports).await)
    }

    #[cfg(target_os = "linux")]
    {
        use linux_impl::*;
        match detect().await {
            FirewallKind::Ufw      => Ok(check_ufw(&ports).await),
            FirewallKind::Firewalld => Ok(check_firewalld(&ports).await),
            FirewallKind::Iptables | FirewallKind::None => {
                // For iptables we rely on DB state (checked by the frontend).
                // Return active:false so the frontend falls back to DB.
                let statuses = ports.iter().map(|p| PortStatus {
                    port: p.port, protocol: p.protocol.clone(), covered: false,
                }).collect();
                Ok(FirewallStatus {
                    firewall_type: if matches!(detect().await, FirewallKind::Iptables) {
                        "iptables".into()
                    } else {
                        "none".into()
                    },
                    active: false,
                    ports: statuses,
                })
            }
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let statuses = ports.iter().map(|p| PortStatus {
            port: p.port, protocol: p.protocol.clone(), covered: false,
        }).collect();
        Ok(FirewallStatus { firewall_type: "none".into(), active: false, ports: statuses })
    }
}

/// Add (or sync) firewall rules.
/// `ports` must be the COMPLETE desired set — every port that should be open
/// across ALL servers, not just the new one being added. The backend writes this
/// list as the authoritative state so stale entries from deleted servers are removed.
#[tauri::command]
pub async fn add_firewall_rules(ports: Vec<PortDef>, _proton_path: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::add_rules(&ports).await
    }

    #[cfg(target_os = "linux")]
    {
        use linux_impl::*;
        match detect().await {
            FirewallKind::Ufw       => apply_ufw_state(&ports).await,
            FirewallKind::Firewalld => add_firewalld(&ports).await,
            FirewallKind::Iptables  => add_iptables(&ports).await,
            FirewallKind::None      => Ok(()),
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        Ok(())
    }
}

/// Remove firewall rules for ports no longer needed.
/// `ports` must be the COMPLETE set of ports that should stay open —
/// every port across ALL remaining servers after the deletion. Ports not in this
/// list are removed; ports that are still needed are left untouched.
#[tauri::command]
pub async fn remove_firewall_rules(ports: Vec<PortDef>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // On Windows, remove_rules takes ports-to-remove, so we can't use the
        // remaining-ports model directly. For now keep existing per-rule deletion.
        windows_impl::remove_rules(&ports).await
    }

    #[cfg(target_os = "linux")]
    {
        use linux_impl::*;
        match detect().await {
            FirewallKind::Ufw       => apply_ufw_state(&ports).await,
            FirewallKind::Firewalld => remove_firewalld(&ports).await,
            FirewallKind::Iptables  => remove_iptables(&ports).await,
            FirewallKind::None      => Ok(()),
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        Ok(())
    }
}

/// Returns currently tracked UFW profile ports (world-readable on Linux).
/// On Windows returns the same list derived from netsh (non-elevated).
/// Used to compute exclusive ports when deleting a server.
#[tauri::command]
pub async fn get_all_firewall_ports() -> Result<Vec<PortDef>, String> {
    #[cfg(target_os = "windows")]
    {
        // Parse netsh output to find LokiASAM-* rules
        let output = Command::new("netsh")
            .args(["advfirewall", "firewall", "show", "rule", "name=all", "dir=in"])
            .output()
            .await
            .map_err(|e| format!("netsh failed: {e}"))?;

        let text = String::from_utf8_lossy(&output.stdout);
        let mut ports = Vec::new();
        let mut current_name = String::new();
        let mut current_proto = String::new();

        for line in text.lines() {
            let line = line.trim();
            if line.starts_with("Rule Name:") {
                current_name = line.trim_start_matches("Rule Name:").trim().to_string();
                current_proto.clear();
            } else if line.starts_with("Protocol:") {
                current_proto = line.trim_start_matches("Protocol:").trim().to_lowercase();
            } else if line.starts_with("LocalPort:") && current_name.starts_with("LokiASAM-") {
                let port_str = line.trim_start_matches("LocalPort:").trim();
                if let Ok(port) = port_str.parse::<u16>() {
                    if current_proto == "tcp" || current_proto == "udp" {
                        ports.push(PortDef { port, protocol: current_proto.clone() });
                    }
                }
            }
        }
        Ok(ports)
    }

    #[cfg(target_os = "linux")]
    {
        use linux_impl::parse_ufw_profile;
        let set = parse_ufw_profile();
        let ports = set.iter()
            .filter_map(|entry| {
                let slash = entry.rfind('/')?;
                let p = entry[..slash].parse::<u16>().ok()?;
                Some(PortDef { port: p, protocol: entry[slash + 1..].to_string() })
            })
            .collect();
        Ok(ports)
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        Ok(vec![])
    }
}
