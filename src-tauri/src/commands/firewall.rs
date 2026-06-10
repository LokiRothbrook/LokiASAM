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
    const UFW_APP_NAME: &str = "LokiASAM";

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
    fn build_ufw_ports_line(ports: &[PortDef]) -> String {
        // Group by protocol
        let mut udp: Vec<u16> = ports.iter().filter(|p| p.protocol == "udp").map(|p| p.port).collect();
        let mut tcp: Vec<u16> = ports.iter().filter(|p| p.protocol == "tcp").map(|p| p.port).collect();
        udp.sort_unstable();
        udp.dedup();
        tcp.sort_unstable();
        tcp.dedup();

        let mut segments = Vec::new();
        if !udp.is_empty() {
            let ports_str = udp.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
            segments.push(format!("{ports_str}/udp"));
        }
        if !tcp.is_empty() {
            let ports_str = tcp.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
            segments.push(format!("{ports_str}/tcp"));
        }
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

    pub async fn add_ufw(new_ports: &[PortDef], existing_covered: &std::collections::HashSet<String>) -> Result<(), String> {
        // Read current profile ports, merge with new ones
        let current = parse_ufw_profile();
        let mut all_ports: Vec<PortDef> = Vec::new();

        // Keep existing covered ports that are already in the profile
        for entry in &current {
            if let Some(slash) = entry.rfind('/') {
                if let Ok(p) = entry[..slash].parse::<u16>() {
                    let proto = entry[slash + 1..].to_string();
                    all_ports.push(PortDef { port: p, protocol: proto });
                }
            }
        }
        // Add new ports (dedup handled by build)
        for p in new_ports {
            let key = format!("{}/{}", p.port, p.protocol);
            if !existing_covered.contains(&key) {
                all_ports.push(p.clone());
            }
        }
        // Also include uncovered ones from the original new_ports list
        for p in new_ports {
            if !all_ports.iter().any(|e| e.port == p.port && e.protocol == p.protocol) {
                all_ports.push(p.clone());
            }
        }

        let profile_content = build_ufw_profile(&all_ports);

        // Write profile with pkexec tee
        let mut child = Command::new("pkexec")
            .args(["tee", UFW_PROFILE_PATH])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to spawn pkexec tee: {e}"))?;

        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            stdin.write_all(profile_content.as_bytes()).await
                .map_err(|e| format!("Failed to write profile: {e}"))?;
        }

        let output = child.wait_with_output().await
            .map_err(|e| format!("pkexec tee failed: {e}"))?;

        if !output.status.success() {
            return Err(format!("pkexec tee exited {}", output.status.code().unwrap_or(-1)));
        }

        // Activate the rule
        let allow_status = Command::new("pkexec")
            .args(["ufw", "allow", UFW_APP_NAME])
            .status()
            .await
            .map_err(|e| format!("Failed to run pkexec ufw allow: {e}"))?;

        if !allow_status.success() {
            return Err(format!("pkexec ufw allow exited {}", allow_status.code().unwrap_or(-1)));
        }
        Ok(())
    }

    pub async fn remove_ufw(ports_to_remove: &[PortDef]) -> Result<(), String> {
        let current = parse_ufw_profile();
        let remove_set: std::collections::HashSet<String> = ports_to_remove
            .iter().map(|p| format!("{}/{}", p.port, p.protocol)).collect();

        let remaining: Vec<PortDef> = current.iter()
            .filter(|k| !remove_set.contains(*k))
            .filter_map(|entry| {
                let slash = entry.rfind('/')?;
                let p = entry[..slash].parse::<u16>().ok()?;
                Some(PortDef { port: p, protocol: entry[slash + 1..].to_string() })
            })
            .collect();

        let profile_content = if remaining.is_empty() {
            // Delete the profile and the rule
            let _ = Command::new("pkexec")
                .args(["ufw", "delete", "allow", UFW_APP_NAME])
                .status().await;
            let _ = Command::new("pkexec")
                .args(["rm", "-f", UFW_PROFILE_PATH])
                .status().await;
            return Ok(());
        } else {
            build_ufw_profile(&remaining)
        };

        // Rewrite profile
        let mut child = Command::new("pkexec")
            .args(["tee", UFW_PROFILE_PATH])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to spawn pkexec tee: {e}"))?;

        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            stdin.write_all(profile_content.as_bytes()).await
                .map_err(|e| format!("Failed to write profile: {e}"))?;
        }
        let out = child.wait_with_output().await
            .map_err(|e| format!("pkexec tee failed: {e}"))?;
        if !out.status.success() {
            return Err(format!("pkexec tee exited {}", out.status.code().unwrap_or(-1)));
        }

        // Re-apply
        let _ = Command::new("pkexec")
            .args(["ufw", "allow", UFW_APP_NAME])
            .status().await;
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
        for p in ports {
            let arg = format!("{}/{}", p.port, p.protocol);
            let already = Command::new("firewall-cmd")
                .args(["--query-port", &arg])
                .status().await
                .map(|s| s.success()).unwrap_or(false);
            if already { continue; }

            let s = Command::new("pkexec")
                .args(["firewall-cmd", "--permanent", &format!("--add-port={arg}")])
                .status().await
                .map_err(|e| format!("pkexec firewall-cmd failed: {e}"))?;
            if !s.success() {
                return Err(format!("firewall-cmd --add-port exited {}", s.code().unwrap_or(-1)));
            }
        }
        // Reload once after all ports added
        let _ = Command::new("pkexec")
            .args(["firewall-cmd", "--reload"])
            .status().await;
        Ok(())
    }

    pub async fn remove_firewalld(ports: &[PortDef]) -> Result<(), String> {
        for p in ports {
            let arg = format!("{}/{}", p.port, p.protocol);
            let _ = Command::new("pkexec")
                .args(["firewall-cmd", "--permanent", &format!("--remove-port={arg}")])
                .status().await;
        }
        let _ = Command::new("pkexec")
            .args(["firewall-cmd", "--reload"])
            .status().await;
        Ok(())
    }

    // ── iptables (DB-backed fallback) ────────────────────────────────────────

    pub async fn add_iptables(ports: &[PortDef]) -> Result<(), String> {
        for p in ports {
            let proto = &p.protocol;
            let port_str = p.port.to_string();
            let s = Command::new("pkexec")
                .args(["iptables", "-A", "INPUT", "-p", proto, "--dport", &port_str, "-j", "ACCEPT"])
                .status().await
                .map_err(|e| format!("pkexec iptables failed: {e}"))?;
            if !s.success() {
                return Err(format!("iptables -A exited {} for port {}", s.code().unwrap_or(-1), p.port));
            }
        }
        Ok(())
    }

    pub async fn remove_iptables(ports: &[PortDef]) -> Result<(), String> {
        for p in ports {
            let proto = &p.protocol;
            let port_str = p.port.to_string();
            let _ = Command::new("pkexec")
                .args(["iptables", "-D", "INPUT", "-p", proto, "--dport", &port_str, "-j", "ACCEPT"])
                .status().await;
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

/// Add firewall rules for the given ports. Triggers elevation (UAC / pkexec).
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
            FirewallKind::Ufw => {
                let current = parse_ufw_profile();
                add_ufw(&ports, &current).await
            }
            FirewallKind::Firewalld => add_firewalld(&ports).await,
            FirewallKind::Iptables  => add_iptables(&ports).await,
            FirewallKind::None => Ok(()), // nothing to do
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        Ok(())
    }
}

/// Remove firewall rules. Called only when the user opts in during server deletion.
#[tauri::command]
pub async fn remove_firewall_rules(ports: Vec<PortDef>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::remove_rules(&ports).await
    }

    #[cfg(target_os = "linux")]
    {
        use linux_impl::*;
        match detect().await {
            FirewallKind::Ufw       => remove_ufw(&ports).await,
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
