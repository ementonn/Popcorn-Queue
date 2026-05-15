# Documentation

This directory holds the operational and development documentation for Popcorn
Queue. Keep `README.md` at the repository root as the short entry point; put
long-lived details here.

## Start Here

- [Getting started](../README.md#quick-start-and-configuration): install,
  configure, and run the API plus Web UI.
- [Configuration](configuration.md): environment variables and which settings
  can be changed from the Web settings page.
- [Manual testing](manual-testing.md): end-to-end checks against local services
  and real integrations.
- [Troubleshooting](troubleshooting.md): common failures and where to look
  first.

## System Reference

- [Architecture](architecture.md): package boundaries, data directories, logs,
  and cache policy.
- [Jobs and phases](jobs-and-phases.md): queue states, worker phases, retry
  behavior, and artifacts.
- [API](api.md): browser bridge, queue, job, log, and diagnostics endpoints.
- [Browser bridge](browser-bridge.md): userscript responsibilities, setup, and
  usage.
- [Integrations](integrations.md): PTP, qBittorrent, image hosts, and worker
  tools.

## Maintainer Reference

- [Development](development.md): workspace layout, scripts, tests, and release
  checks.
- [Contributing](../CONTRIBUTING.md): local setup, pre-commit checks, and doc
  update rules.
- [Operations](operations.md): running services, logs, backups, restores, and
  maintenance.
- [Security](security.md): secrets, public release audit, and safe-to-commit
  rules.
- [Migration notes](migration.md): design context from earlier tools.

## Product Notes

- [UI direction](ui-direction.md): visual direction and UI references.
- [Upsies feature backlog](upsies-feature-backlog.md): candidate feature ideas
  and mapping notes.

Generated screenshots and preview images live in [assets](assets/).
