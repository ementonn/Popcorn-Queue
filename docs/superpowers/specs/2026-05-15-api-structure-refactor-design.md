# API Structure Refactor Design

## Purpose

The first refactor phase will reduce `apps/api/src/server.ts` and
`apps/api/src/server.test.ts` without changing API behavior. The API entrypoint
currently mixes Fastify setup, runtime dependency wiring, route handlers,
diagnostics, browser multipart intake, upload actions, delete cleanup, and PTP
cache sync helpers. This makes small API changes harder to reason about and
harder to test safely.

This phase focuses only on the API package. Worker phase splitting and Web UI
component splitting are intentionally left for later specs.

## Scope

In scope:

- Split Fastify routes by API domain.
- Move route-specific business helpers out of `server.ts`.
- Split the large API server test file by domain.
- Keep test helpers shared through one API test utility module.
- Fix only obvious duplicate or typo-level issues discovered during extraction.

Out of scope:

- Changing API response schemas.
- Reworking job state machines.
- Rewriting worker phase execution.
- Moving Web UI components.
- Changing persistence behavior.
- Adding new features.

## Selected Approach

Use a route-module extraction. `server.ts` becomes the API composition root. It
creates the Fastify app, registers shared plugins and hooks, initializes runtime
dependencies, creates an API route context, registers route modules, and returns
the app.

This is preferred over only extracting services because it directly addresses the
main readability problem: route handlers for unrelated API surfaces are
currently packed into one file. It is also preferred over a broad API, worker,
and Web refactor because the combined scope would be too large to verify
comfortably in one implementation plan.

## API Context

Route modules should receive an explicit context instead of importing mutable
singletons. The context gives routes access to current runtime dependencies
while preserving hot settings reload.

The context should expose the current config through a getter because settings
can be saved and reloaded while the process remains alive.

Expected shape:

```ts
interface ApiRouteContext {
  config: () => ApiConfig;
  jobRepository: JobRepository;
  cache: CacheStore<NormalizedPtpResponse>;
  getPtpClient(): PtpClient;
  getBrowserChecks(): BrowserCheckService;
  getTorrentClient(): TorrentDownloadClient | null;
  getPreparation(): PreparationService;
  enqueuePreparation(jobId: string): void;
  applyRuntimeConfig(config: ApiConfig): void;
  options: BuildServerOptions;
  settingsEnvPath: string;
}
```

The final type may be adjusted during implementation if the existing code shows
a cleaner boundary, but it should preserve these responsibilities.

## Route Modules

Create domain route modules under `apps/api/src/routes/`:

- `auth.ts`: session, login, logout.
- `settings.ts`: settings read/save and hot config reload.
- `health.ts`: health and feature summaries.
- `diagnostics.ts`: diagnostics overview and targeted integration checks.
- `jobs.ts`: job listing, job details, logs, status, actions, delete, reseed,
  review gates, and plan refresh.
- `intake.ts`: manual media validation, PTP search/target resolve, and manual
  intake job creation.
- `browser.ts`: browser extension checks, cache invalidation, and browser job
  creation.
- `index.ts`: registers the route modules in one place.

Each route module should register routes on the provided Fastify instance and
use only the context plus local helper imports.

## Services and Helpers

Move route-specific helpers to focused service modules where doing so clarifies
ownership:

- `services/job-delete.ts`: delete modes, local path cleanup, qBittorrent
  download/seed cleanup.
- `services/job-upload.ts`: upload tail execution, retry, resume, skip, and
  reseed actions.
- `services/diagnostics.ts`: integration summaries, tool diagnostics, storage
  diagnostics, and queue diagnostics.
- `services/ptp-cache-sync.ts`: sync uploaded torrent data back into cached PTP
  movie data.
- `services/restore.ts`: restored-job missing-file checks if this code no
  longer belongs naturally in `jobs.ts`.

These modules should keep their dependencies explicit. They should not import
the Fastify app, and they should not own process-level config loading.

## Migration Order

Migrate in small steps:

1. Introduce the route context and route registration skeleton.
2. Extract low-risk route modules: auth, settings, health, diagnostics.
3. Extract intake and browser routes.
4. Extract job routes and job action services.
5. Split API server tests by domain.
6. Remove dead code and fix obvious duplicate or typo-level issues.

The implementation should keep behavior stable after each step. If a step grows
too large, split it before continuing.

## Test Structure

Keep tests beside source files using the existing `*.test.ts` convention.

Create `apps/api/src/server-test-utils.ts` or an equivalent helper module for:

- mocked `PrismaPersistence`;
- `testConfig`;
- `withServer`;
- `withConfiguredServer`;
- `multipartBody`;
- `waitForJob`;
- `pathExists`.

Split the current API server tests into domain files, for example:

- `server.cache.test.ts`;
- `server.diagnostics.test.ts`;
- `server.settings.test.ts`;
- `server.jobs-delete.test.ts`;
- `server.browser.test.ts`;
- `server.intake.test.ts`.

Move existing assertions rather than rewriting them. Delete the corresponding
sections from the original `server.test.ts` as they move so duplicate coverage
does not linger.

## Allowed Cleanup

This refactor may fix obvious local defects that are visible during extraction,
as long as they do not change public API behavior. Examples from the current
file include:

- removing the duplicated `return jobRepository.markUploadResult(...)`;
- removing the duplicated `id: "image-host-upload"` property in the feature
  response object.

Do not fold unrelated behavior changes into this refactor.

## Verification

During implementation:

- Run the focused API test file after each domain extraction.
- Run `npm test -- apps/api/src` after the route and test split is complete.
- Run `npm run typecheck` before the implementation is considered complete.
- Web e2e tests are not required for this API-only structure refactor unless a
  route response shape changes unexpectedly.

## Success Criteria

- `apps/api/src/server.ts` is reduced from about 1250 lines to roughly 300-450
  lines.
- The original `server.test.ts` is deleted or reduced to minimal smoke coverage.
- Route handlers are grouped by API domain.
- Job action and cleanup helpers can be tested or read without opening
  `server.ts`.
- Public API behavior remains compatible with existing tests.
- The work lands in several focused commits rather than one large commit.

## Risks

- Route extraction can accidentally capture stale config if modules receive a
  config value instead of a getter.
- Test mock setup can become duplicated if the shared test utility is not
  introduced early.
- Extracting job routes is higher risk than extracting health/settings because
  those handlers touch preparation, qBittorrent, PTP upload, and delete cleanup.

The migration order is designed to handle low-risk routes first and leave job
actions for the end.
