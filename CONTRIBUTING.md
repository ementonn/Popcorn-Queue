# Contributing

Use [docs/development.md](docs/development.md) as the detailed development
reference.

## Local Setup

```bash
npm install
npm run configure
npm run dev:api
npm run dev:web
```

Run API and Web in separate shells.

## Before Commit

```bash
npm test
npm run typecheck
npm run audit:public
```

Do not run `npm test` and `npm run typecheck` at the same time in the same
workspace because package build outputs can race.

## Safety

Never commit `.env`, cookies, tracker passkeys, announce URLs, databases,
torrents, logs, downloaded media, or generated local userscripts. See
[docs/security.md](docs/security.md) for the full list and incident response.

## Documentation

When behavior changes, update the relevant doc:

- Configuration or settings: [docs/configuration.md](docs/configuration.md)
- Job flow or retry behavior: [docs/jobs-and-phases.md](docs/jobs-and-phases.md)
- External services or tools: [docs/integrations.md](docs/integrations.md)
- Runtime handling: [docs/operations.md](docs/operations.md)
- Known failure modes: [docs/troubleshooting.md](docs/troubleshooting.md)
