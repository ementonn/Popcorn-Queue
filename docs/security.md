# Security

Popcorn Queue touches private tracker credentials, cookies, announce URLs,
downloaded torrents, and local media paths. Treat the repository as public even
when pushing to a private remote.

## Never Commit

- `.env` or `.env.backup.*`
- cookies or PTP session files
- tracker passkeys or announce URLs
- PTP API keys and passwords
- qBittorrent credentials
- image-host API keys
- `.torrent` files
- SQLite databases
- `data/`, `logs/`, downloaded media, generated local userscripts

Run this before publishing or force-pushing cleanup work:

```bash
npm run audit:public
```

The audit checks tracked files and Git history for sensitive paths, obvious
secret assignments, and public IPv4 addresses.

## Browser Bridge

The userscript should only contain the local API/Web URL, supported source-site
connect permissions, and the browser token set through the userscript menu. It
must not contain PTP API credentials or announce URLs.

Because Tampermonkey `@connect` entries reveal hosts, generate local scripts
from `.env` and keep generated local userscripts ignored by Git.

## Logs

Logs are written to `logs/` and `data/jobs/<jobId>/logs/`. Redaction should
cover tokens, passwords, cookies, passkeys, announce URLs, and authorization
headers. Do not paste raw logs into issues or commits without checking them.

## Settings Page

The settings API exposes only selected hot-editable config keys. It should not
expose infrastructure settings such as `DATABASE_URL`, data root, ports, or
cookie configuration.

## Incident Response

If a secret or private host is committed:

1. Rotate the affected secret immediately.
2. Remove it from current files.
3. Rewrite Git history if the remote has already received it.
4. Force-push only after confirming collaborators understand the rewrite.
5. Run `npm run audit:public` again.
