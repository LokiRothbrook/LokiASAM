-- Migration 004: firewall port rule tracking
-- Used as fallback state for Linux iptables/nftables where non-root
-- reads of live firewall state are not available. For ufw and firewalld,
-- state is derived directly from the system (ufw profile file / firewall-cmd).

CREATE TABLE IF NOT EXISTS firewall_rules (
  port     INTEGER NOT NULL,
  protocol TEXT    NOT NULL CHECK(protocol IN ('tcp', 'udp')),
  added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (port, protocol)
);
