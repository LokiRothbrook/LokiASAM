-- Migration 002: Cluster management enhancements
-- Adds a cluster_settings column for cluster-wide flag overrides.

PRAGMA foreign_keys=ON;

ALTER TABLE clusters ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';
