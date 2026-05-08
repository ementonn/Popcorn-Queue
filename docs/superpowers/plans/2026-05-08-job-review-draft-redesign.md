# Job Review Draft Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make job review usable before final PTP upload: replace the narrow fixed review column with a draggable overlay drawer, store and display full text MediaInfo while keeping JSON for parsing, and rebuild the draft editor around the real PTP upload form fields.

**Architecture:** Keep preparation and submission data authoritative in the API/core packages. The worker emits dual MediaInfo artifacts and a PTP-ready description. The API persists artifacts and review drafts as job JSON. The web app renders an overlay drawer over the job table, edits the draft through the existing PATCH endpoint, and starts upload only after readiness checks pass.

**Tech Stack:** TypeScript, React, Vite, Vitest, Playwright, Fastify API, worker phase tests, existing PTP submitter integration.

---

## Approved Spec

Use the design spec at `docs/superpowers/specs/2026-05-08-job-review-draft-redesign.md`.

The approved choices are:

- Job detail opens as a right overlay drawer that covers part of the table and has a draggable left edge.
- MediaInfo is stored as both full text and JSON. PTP descriptions and draft review use full text.
- Draft editor shows required PTP fields by default and puts advanced PTP fields in a collapsible section.
- Readiness blocks upload when required evidence or required draft fields are missing.

## Current File Map

Frontend:

- `apps/web/src/App.tsx` owns selected job state and currently renders `ReviewPanel` as a fixed third grid column.
- `apps/web/src/components/QueueTable.tsx` renders the jobs table and selected row.
- `apps/web/src/components/ReviewPanel.tsx` renders blockers, warnings, duplicate result, download, screenshots, MediaInfo, upload draft, qB data, and logs in a narrow pane.
- `apps/web/src/styles.css` defines `.shell` as `226px minmax(0, 1fr) 370px` and `.review-pane` as the fixed right column.
- `apps/web/src/types.ts` defines `ReviewDraft` and `ApiJob.artifacts`.
- `apps/web/src/api.ts` sends review draft PATCH requests.

Core:

- `packages/core/src/review-draft.ts` builds and merges the current minimal draft.
- `packages/core/src/review-draft.test.ts` covers the current minimal draft.
- `packages/core/src/upload-readiness.ts` computes readiness from job state and evidence.
- `packages/core/src/index.ts` exports shared modules.

Worker:

- `apps/worker/src/phases.ts` runs MediaInfo with `--Output=JSON`, parses summary, prepares screenshots, and builds the current upload description from JSON stdout.
- `apps/worker/src/phases.test.ts` covers inspect media, preparation, screenshots, upload draft behavior, and fixture media handling.

API:

- `apps/api/src/jobs.ts` defines persisted job and artifact types.
- `apps/api/src/preparation.ts` collects worker artifacts and computes preparation readiness.
- `apps/api/src/preparation.test.ts` validates artifact collection and readiness.
- `apps/api/src/server.ts` owns review draft PATCH and start upload endpoints.
- `apps/api/src/persistence.ts` persists artifacts and review drafts inside SQLite JSON columns.

PTP Integration:

- `packages/integrations/src/ptp/submitter.ts` maps `ReviewDraft` to PTP form fields.
- `packages/integrations/src/ptp/submitter.test.ts` verifies current form field mapping.

Reference Material:

- `PtpUploader/src/PtpUploader/Tool/MediaInfo.py` shows the old tool used text MediaInfo, not JSON, and stripped upload root paths from `Complete name`.
- `PtpUploader/src/PtpUploader/Tool/ReleaseDescriptionFormatter.py` shows full MediaInfo/BDInfo plus screenshot BBCode in release descriptions.
- `PtpUploader/src/PtpUploader/Tool/Ptp.py` shows PTP upload field names.
- `/home/emt/ptp/Upload __ PassThePopcorn.html` contains the real upload form markup.

## Data Contract

Use this shared draft shape in core and mirror it in the web API type:

```ts
export interface PtpArtistDraft {
  name: string;
  importance: "1" | "2" | "3" | "4" | "5" | "";
}

export interface ReviewDraft {
  releaseName: string;
  description: string;
  groupId?: string;
  type: string;
  source: string;
  codec: string;
  container: string;
  resolution: string;
  otherSource?: string;
  otherCodec?: string;
  otherContainer?: string;
  otherResolutionWidth?: string;
  otherResolutionHeight?: string;
  imdb?: string;
  title?: string;
  year?: string;
  image?: string;
  trailer?: string;
  tags?: string;
  synopsis?: string;
  remaster?: boolean;
  remasterYear?: string;
  remasterTitle?: string;
  special?: string;
  subtitles: string[];
  trumpable: string[];
  scene: boolean;
  personalRip: boolean;
  internal: boolean;
  uploadToken?: string;
  artists: PtpArtistDraft[];
}
```

Use these artifact fields:

```ts
export interface JobArtifacts {
  mediaFiles?: MediaFileArtifact[];
  screenshots?: ScreenshotArtifact[];
  mediainfo?: string;
  mediaInfoText?: string;
  mediaInfoJson?: string;
  bdinfo?: string;
  releaseName?: string;
  description?: string;
  duplicateResult?: DuplicateCheckResult;
  uploadTorrent?: TorrentArtifact;
  sourceTorrent?: TorrentArtifact;
  qbReady?: boolean;
  ptpUploadUrl?: string;
  ptpUploadPayload?: Record<string, unknown>;
  ptpUploadedAt?: string;
}
```

`mediainfo` remains as a backward-compatible alias for text MediaInfo. New code writes both `mediainfo` and `mediaInfoText` to the same text value.

## Task 1: Expand Core Draft Model And PTP Field Helpers

- [ ] Add failing tests in `packages/core/src/review-draft.test.ts`.

Test cases:

```ts
it("builds PTP release description from text mediainfo and screenshots", () => {
  const description = buildReleaseDescription({
    releaseName: "Movie.2025.1080p.WEB-DL.x265-GROUP",
    mediaInfoText: "General\nComplete name                            : Movie.mkv",
    screenshots: ["https://img.example/1.png", "https://img.example/2.png", "https://img.example/3.png"]
  });

  expect(description).toContain("[size=4][b]Movie.2025.1080p.WEB-DL.x265-GROUP[/b][/size]");
  expect(description).toContain("General");
  expect(description).toContain("[img]https://img.example/1.png[/img]");
});

it("builds PTP draft fields from release metadata", () => {
  const draft = buildReviewDraft({
    releaseName: "Movie.2025.1080p.WEB-DL.x265-GROUP",
    candidate: { title: "Movie", year: 2025, imdbId: "tt1234567" },
    checkResult: { groupId: "123" },
    description: "Release description"
  });

  expect(draft.type).toBe("Feature Film");
  expect(draft.source).toBe("WEB");
  expect(draft.codec).toBe("H.265");
  expect(draft.container).toBe("MKV");
  expect(draft.resolution).toBe("1080p");
  expect(draft.imdb).toBe("tt1234567");
  expect(draft.title).toBe("Movie");
  expect(draft.year).toBe("2025");
  expect(draft.groupId).toBe("123");
});

it("maps draft values to real PTP upload field names", () => {
  const { fields, missing } = ptpFormFieldsFromDraft({
    releaseName: "Movie.2025.1080p.WEB-DL.x265-GROUP",
    description: "Description",
    groupId: "123",
    type: "Feature Film",
    source: "WEB",
    codec: "H.265",
    container: "MKV",
    resolution: "1080p",
    imdb: "tt1234567",
    title: "Movie",
    year: "2025",
    image: "",
    trailer: "",
    tags: "drama",
    synopsis: "",
    remaster: false,
    subtitles: ["3"],
    trumpable: ["14"],
    scene: false,
    personalRip: true,
    internal: false,
    uploadToken: "token",
    artists: [{ name: "Director Name", importance: "1" }]
  });

  expect(missing).toEqual([]);
  expect(fields).toContainEqual(["type", "Feature Film"]);
  expect(fields).toContainEqual(["source", "WEB"]);
  expect(fields).toContainEqual(["codec", "H.265"]);
  expect(fields).toContainEqual(["container", "MKV"]);
  expect(fields).toContainEqual(["resolution", "1080p"]);
  expect(fields).toContainEqual(["imdb", "tt1234567"]);
  expect(fields).toContainEqual(["artist[]", "Director Name"]);
  expect(fields).toContainEqual(["importance[]", "1"]);
  expect(fields).toContainEqual(["subtitles[]", "3"]);
  expect(fields).toContainEqual(["trumpable[]", "14"]);
});
```

Run:

```bash
npm test -- packages/core/src/review-draft.test.ts
```

Expected: fails because the expanded fields and helper do not exist.

- [ ] Implement `packages/core/src/ptp-options.ts`.

Required exports:

```ts
export const PTP_TYPES = [
  "Feature Film",
  "Short Film",
  "Miniseries",
  "Stand-up Comedy",
  "Live Performance",
  "Movie Collection"
] as const;

export const PTP_SOURCES = ["Blu-ray", "DVD", "WEB", "HD-DVD", "HDTV", "TV", "VHS", "Other"] as const;
export const PTP_CODECS = ["XviD", "DivX", "H.264", "x264", "H.265", "x265", "DVD5", "DVD9", "BD25", "BD50", "BD66", "BD100", "Other"] as const;
export const PTP_CONTAINERS = ["AVI", "MPG", "MKV", "MP4", "VOB IFO", "ISO", "m2ts", "Other"] as const;
export const PTP_RESOLUTIONS = ["NTSC", "PAL", "480p", "576p", "720p", "1080i", "1080p", "2160p", "Other"] as const;

export const PTP_SUBTITLE_OPTIONS = [
  { id: "3", label: "English" },
  { id: "14", label: "Chinese" },
  { id: "44", label: "No Subtitles" }
] as const;

export const PTP_TRUMPABLE_OPTIONS = [
  { id: "14", label: "No English Subtitles" },
  { id: "4", label: "Hardcoded Subtitles" }
] as const;
```

- [ ] Expand `packages/core/src/review-draft.ts`.

Required behavior:

- `buildReviewDraft` fills title, year, IMDb, group id, source, codec, container, resolution, and PTP defaults.
- `mergeReviewDraft` preserves existing PATCH behavior and accepts partial expanded fields.
- Existing string subtitle and trumpable values are migrated to PTP numeric IDs for known labels.
- `normalizeSource("WEB-DL")` and `normalizeSource("WEBRip")` return `WEB`.
- `normalizeContainer("Matroska")` returns `MKV`.
- `normalizeCodec("HEVC")` returns `H.265`.

- [ ] Add `packages/core/src/ptp-form-fields.ts`.

Required exports:

```ts
export interface PtpFieldResult {
  fields: Array<[string, string]>;
  missing: string[];
}

export function ptpFormFieldsFromDraft(draft: ReviewDraft): PtpFieldResult;
export function missingPtpDraftFields(draft: ReviewDraft): string[];
```

Required field mapping:

- Always include `type`, `source`, `codec`, `container`, `resolution`, `release_desc`, `nfo_text`, `scene`, `internalrip`, and `remaster` when values are present.
- Include `groupid` for existing PTP group upload.
- Include `imdb`, `title`, `year`, `image`, `trailer`, `tags`, `album_desc`, `special`, and `uploadtoken` when present.
- Include repeated `artist[]`, `importance[]`, `subtitles[]`, and `trumpable[]` fields.
- When source, codec, or container is not in the PTP option list, submit `Other` plus `other_source`, `other_codec`, or `other_container`.
- When resolution is `Other`, submit `other_resolution_width` and `other_resolution_height`.

- [ ] Add `packages/core/src/release-description.ts`.

Required exports:

```ts
export interface ReleaseDescriptionInput {
  releaseName?: string;
  releaseNotes?: string;
  mediaInfoText?: string;
  bdInfoText?: string;
  screenshots?: string[];
}

export function buildReleaseDescription(input: ReleaseDescriptionInput): string;
```

Required behavior:

- Add a PtpUploader-style release title header when `releaseName` is present.
- Add release notes when present.
- Prefer BDInfo text over MediaInfo text when both exist.
- Add full text MediaInfo or BDInfo without JSON conversion.
- Add each screenshot as `[img]URL[/img]`.
- Separate major sections with blank lines.

- [ ] Export new helpers from `packages/core/src/index.ts`.

- [ ] Run and fix:

```bash
npm test -- packages/core/src/review-draft.test.ts
```

Expected: passes.

- [ ] Commit:

```bash
git add packages/core/src/review-draft.ts packages/core/src/review-draft.test.ts packages/core/src/ptp-options.ts packages/core/src/ptp-form-fields.ts packages/core/src/release-description.ts packages/core/src/index.ts
git commit -m "core: expand ptp review draft model"
```

## Task 2: Emit Text And JSON MediaInfo From Worker

- [ ] Add failing tests in `apps/worker/src/phases.test.ts`.

Test case names:

- `inspect-media stores text and json mediainfo artifacts`
- `ptp upload draft uses text mediainfo in release description`
- `sanitizeMediaInfoText removes absolute upload paths`

Required assertions:

```ts
expect(result.mediaInfoText.result.stdout).toContain("General");
expect(result.mediaInfoJson.result.stdout).toContain("\"media\"");
expect(result.summary.container).toBe("Matroska");
expect(description).toContain("MediaInfo");
expect(description).toContain("General");
expect(description).not.toContain("\"track\"");
expect(sanitizeMediaInfoText(input, "/jobs/abc/upload")).toContain("Complete name                            : Movie.mkv");
```

Run:

```bash
npm test -- apps/worker/src/phases.test.ts -t "mediainfo"
```

Expected: fails because worker currently has only JSON MediaInfo.

- [ ] Update `apps/worker/src/phases.ts`.

Required implementation:

```ts
export function mediaInfoTextInvocation(command: string, mediaPath: string): ToolInvocation {
  return { command, args: [mediaPath] };
}

export function mediaInfoJsonInvocation(command: string, mediaPath: string): ToolInvocation {
  return { command, args: ["--Output=JSON", mediaPath] };
}

export function sanitizeMediaInfoText(text: string, uploadRoot: string): string {
  const normalizedRoot = uploadRoot.replace(/\/+$/, "");
  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(\s*Complete name\s*:\s*)(.+)$/);
      if (!match) return line;
      const value = match[2].trim();
      if (!value.startsWith(`${normalizedRoot}/`)) return line;
      return `${match[1]}${value.slice(normalizedRoot.length + 1)}`;
    })
    .join("\n");
}
```

Inspect media phase must:

- Run text MediaInfo first.
- Run JSON MediaInfo second.
- Parse summary from JSON stdout.
- Store both command results in the phase output.
- Store sanitized text as the stdout value for `mediaInfoText`.

PTP draft building must:

- Use `buildReleaseDescription` from core.
- Prefer `bdInfoText` when present.
- Prefer `mediaInfoText.result.stdout` over legacy JSON output when BDInfo is absent.
- Fall back to legacy `mediaInfo.result.stdout`.
- Include screenshots as BBCode image lines when image URLs are present.

- [ ] Run and fix:

```bash
npm test -- apps/worker/src/phases.test.ts -t "mediainfo"
npm test -- apps/worker/src/phases.test.ts
```

Expected: passes.

- [ ] Commit:

```bash
git add apps/worker/src/phases.ts apps/worker/src/phases.test.ts
git commit -m "worker: preserve text mediainfo for ptp drafts"
```

## Task 3: Persist New Artifacts And Enforce Review Readiness

- [ ] Add failing tests in `apps/api/src/preparation.test.ts`.

Test cases:

- `collectArtifacts stores text and json mediainfo`
- `readiness accepts bdinfo when text mediainfo is absent`
- `readiness blocks upload without text mediainfo or bdinfo`
- `readiness blocks upload without three hosted png screenshots`
- `readiness blocks upload without upload torrent`
- `readiness reports missing draft fields`
- `readiness warns when json mediainfo is missing but text mediainfo exists`

Required assertions:

```ts
expect(artifacts.mediaInfoText).toContain("General");
expect(artifacts.mediaInfoJson).toContain("\"media\"");
expect(artifacts.mediainfo).toBe(artifacts.mediaInfoText);
expect(review.ready).toBe(false);
expect(review.blockers).toContain("Missing text MediaInfo or BDInfo");
```

Run:

```bash
npm test -- apps/api/src/preparation.test.ts
```

Expected: fails because artifacts and blockers are not implemented.

- [ ] Update `apps/api/src/jobs.ts`.

Add `mediaInfoText` and `mediaInfoJson` to `JobArtifacts`. Keep `mediainfo` as the text alias.

- [ ] Update `apps/api/src/preparation.ts`.

Required artifact collection:

```ts
const text = mediaInspection?.mediaInfoText?.result?.stdout ?? mediaInspection?.mediaInfo?.result?.stdout;
const json = mediaInspection?.mediaInfoJson?.result?.stdout;

if (text) {
  artifacts.mediaInfoText = text;
  artifacts.mediainfo = text;
}

if (json) {
  artifacts.mediaInfoJson = json;
}
```

Required readiness blockers:

- `Missing media file`
- `Missing text MediaInfo or BDInfo`
- `Missing screenshot evidence`
- `Missing upload torrent`
- `Missing draft field: <field>`

Screenshot readiness requires at least three hosted `.png` URLs.

JSON MediaInfo failure with text MediaInfo success must produce a warning, not a blocker. The warning text is `Missing JSON MediaInfo for internal parsing`.

Draft field validation must use `missingPtpDraftFields` from core against the draft that will be shown in the UI.

- [ ] Keep persistence format unchanged.

`apps/api/src/persistence.ts` already stores artifacts and review drafts as JSON. Only update tests when type changes require it.

- [ ] Run and fix:

```bash
npm test -- apps/api/src/preparation.test.ts
npm test -- apps/api/src/jobs.test.ts apps/api/src/persistence.test.ts
```

Expected: passes.

- [ ] Commit:

```bash
git add apps/api/src/jobs.ts apps/api/src/preparation.ts apps/api/src/preparation.test.ts apps/api/src/jobs.test.ts apps/api/src/persistence.test.ts
git commit -m "api: require complete ptp review evidence"
```

## Task 4: Submit Real PTP Form Fields

- [ ] Add failing tests in `packages/integrations/src/ptp/submitter.test.ts`.

Test cases:

- `submits direct PTP select values without forcing Other`
- `submits Other resolution width and height`
- `submits new movie metadata fields`

Required assertions:

```ts
expect(form.get("source")).toBe("WEB");
expect(form.get("other_source")).toBeNull();
expect(form.get("codec")).toBe("H.265");
expect(form.get("container")).toBe("MKV");
expect(form.get("resolution")).toBe("1080p");
expect(form.get("imdb")).toBe("tt1234567");
expect(form.getAll("artist[]")).toEqual(["Director Name"]);
expect(form.getAll("importance[]")).toEqual(["1"]);
```

Run:

```bash
npm test -- packages/integrations/src/ptp/submitter.test.ts
```

Expected: fails because submitter currently forces source, codec, and container to `Other`.

- [ ] Update `packages/integrations/src/ptp/submitter.ts`.

Required implementation:

- Import `ptpFormFieldsFromDraft`.
- Build the multipart form from the helper result.
- Keep `AntiCsrfToken` behavior.
- Keep torrent file attachment behavior.
- Throw a validation error before submit when `missing` is not empty.

Validation error message:

```ts
`Cannot submit PTP upload draft; missing fields: ${missing.join(", ")}`
```

- [ ] Run and fix:

```bash
npm test -- packages/integrations/src/ptp/submitter.test.ts
```

Expected: passes.

- [ ] Commit:

```bash
git add packages/integrations/src/ptp/submitter.ts packages/integrations/src/ptp/submitter.test.ts
git commit -m "integrations: submit real ptp upload fields"
```

## Task 5: Replace Fixed Review Column With Draggable Drawer

- [ ] Add failing Playwright test `apps/web/e2e/job-drawer.spec.ts`.

Use mocked API routes. The test must not contact the real API.

Required route setup:

```ts
await page.route("**/api/jobs", async (route) => {
  await route.fulfill({ json: { jobs: [mockJob] } });
});

await page.route("**/api/jobs/job-1/review-draft", async (route) => {
  await route.fulfill({ json: { reviewDraft: await route.request().postDataJSON() } });
});

await page.route("**/api/logs/global*", async (route) => {
  await route.fulfill({ json: { entries: [] } });
});
```

Test cases:

- `opens job drawer over the table`
- `resizes drawer with drag handle`
- `closes drawer and preserves selected table`
- `switches drawer content when another job row is selected`

Required assertions:

```ts
await expect(page.getByRole("dialog", { name: /job review/i })).toBeVisible();
await expect(page.getByTestId("job-drawer")).toHaveCSS("position", "fixed");
await page.getByTestId("job-drawer-resizer").dragTo(page.locator("body"), { targetPosition: { x: 650, y: 160 } });
expect(await page.evaluate(() => localStorage.getItem("popcorn.drawer.width"))).toBeTruthy();
```

Run:

```bash
npm run test:e2e -- apps/web/e2e/job-drawer.spec.ts
```

Expected: fails because the drawer does not exist.

- [ ] Add `apps/web/src/components/JobDrawer.tsx`.

Required behavior:

- Render only when a job is selected.
- Use `role="dialog"` and `aria-label="Job review"`.
- Cover the right side of the viewport with fixed positioning.
- Header shows release name, job state, readiness, primary actions, and close.
- Default width is `min(860px, calc(100vw - 260px))`.
- Minimum width is `520px`.
- Maximum width is `calc(100vw - 260px)` on desktop and `100vw` on mobile.
- Left edge is draggable with pointer events.
- Width is stored in `localStorage` key `popcorn.drawer.width`.
- Escape closes the drawer.
- Close button clears the selected job.

Required component signature:

```ts
interface JobDrawerProps {
  job: ApiJob | null;
  onClose: () => void;
  children: React.ReactNode;
}
```

- [ ] Update `apps/web/src/App.tsx`.

Required structure:

```tsx
<main className="workspace">
  <QueueTable />
</main>
<JobDrawer job={selectedJob} onClose={() => setSelectedJobId(null)}>
  <ReviewPanel />
</JobDrawer>
```

Remove the third column usage from the shell grid.

- [ ] Update `apps/web/src/styles.css`.

Required CSS classes:

- `.shell` with two columns: sidebar and workspace.
- `.job-drawer`
- `.job-drawer__resizer`
- `.job-drawer__header`
- `.job-drawer__body`
- Mobile breakpoint sets drawer width to full viewport and hides drag resize.

- [ ] Run and fix:

```bash
npm run test:e2e -- apps/web/e2e/job-drawer.spec.ts
npm run typecheck --workspace apps/web
```

Expected: passes.

- [ ] Commit:

```bash
git add apps/web/src/App.tsx apps/web/src/components/JobDrawer.tsx apps/web/src/styles.css apps/web/e2e/job-drawer.spec.ts
git commit -m "web: move job review into resizable drawer"
```

## Task 6: Rebuild Draft Editor Around PTP Upload Form

- [ ] Add failing web tests.

Extend `apps/web/e2e/job-drawer.spec.ts` with:

- `shows required PTP draft fields by default`
- `edits advanced PTP fields in collapsible section`
- `shows text mediainfo artifact`

Required assertions:

```ts
await expect(page.getByLabel("Type")).toHaveValue("Feature Film");
await expect(page.getByLabel("Source")).toHaveValue("WEB");
await expect(page.getByLabel("Codec")).toHaveValue("H.265");
await expect(page.getByLabel("Container")).toHaveValue("MKV");
await expect(page.getByLabel("Resolution")).toHaveValue("1080p");
await expect(page.getByText("General")).toBeVisible();
await page.getByRole("button", { name: "Advanced PTP fields" }).click();
await page.getByLabel("IMDb").fill("tt7654321");
await page.getByRole("button", { name: "Save draft" }).click();
await expect(page.getByText("Draft saved")).toBeVisible();
```

Run:

```bash
npm run test:e2e -- apps/web/e2e/job-drawer.spec.ts
```

Expected: fails because current draft editor is minimal.

- [ ] Update `apps/web/src/types.ts`.

Mirror the expanded `ReviewDraft` and artifact fields from the data contract.

- [ ] Add `apps/web/src/ptp-options.ts`.

Export the same option arrays used by the UI. Keep values identical to `packages/core/src/ptp-options.ts`.

- [ ] Add `apps/web/src/components/DraftEditor.tsx`.

Required layout:

- Required PTP fields are visible immediately: release name, group id, type, source, codec, container, resolution, subtitles, trumpable flags, scene, personal rip, internal, description.
- New movie metadata is in the advanced section: IMDb, title, year, poster image, trailer, tags, synopsis, artists, special, remaster, remaster title, remaster year, upload token.
- Save button calls existing `onSaveDraft(patch)`.
- Dirty state is local to the component.
- Saving state disables the save button.
- Errors are shown inline near the save action.

Required props:

```ts
interface DraftEditorProps {
  draft: ReviewDraft;
  saving: boolean;
  error: string | null;
  onSave: (patch: Partial<ReviewDraft>) => Promise<void>;
}
```

- [ ] Update `apps/web/src/components/ReviewPanel.tsx`.

Required changes:

- Replace the current inline Upload Draft form with `DraftEditor`.
- Render MediaInfo from `job.artifacts.mediaInfoText ?? job.artifacts.mediainfo`.
- Detect legacy JSON-like `job.artifacts.mediainfo`, keep the view stable, and label it `Legacy internal MediaInfo JSON`.
- Keep JSON MediaInfo out of the main review view.
- Organize content into Review, Draft, Evidence, and Logs tabs or compact sections.
- Show missing draft fields inline near the relevant inputs and in the drawer header readiness area.
- Show readiness blockers from the API without mentioning development status.
- Keep existing screenshots, duplicate result, qB status, torrent details, diagnostics, and logs sections.

- [ ] Update CSS.

Required classes:

- `.draft-editor`
- `.draft-grid`
- `.draft-field`
- `.draft-checkbox-row`
- `.draft-actions`
- `.artifact-pre`

Design constraints:

- No nested cards.
- Inputs and selects fill their container.
- Text areas have stable minimum height.
- Labels remain readable in the drawer at minimum width.

- [ ] Run and fix:

```bash
npm run test:e2e -- apps/web/e2e/job-drawer.spec.ts
npm run typecheck --workspace apps/web
```

Expected: passes.

- [ ] Commit:

```bash
git add apps/web/src/types.ts apps/web/src/ptp-options.ts apps/web/src/components/DraftEditor.tsx apps/web/src/components/ReviewPanel.tsx apps/web/src/styles.css apps/web/e2e/job-drawer.spec.ts
git commit -m "web: rebuild ptp draft editor"
```

## Task 7: Full Flow Regression And Cleanup

- [ ] Run focused tests:

```bash
npm test -- packages/core/src/review-draft.test.ts
npm test -- packages/integrations/src/ptp/submitter.test.ts
npm test -- apps/worker/src/phases.test.ts
npm test -- apps/api/src/preparation.test.ts
npm run test:e2e -- apps/web/e2e/job-drawer.spec.ts
npm run typecheck --workspaces
```

Expected: all commands pass.

- [ ] Run the full test suite:

```bash
npm test
```

Expected: all tests pass.

- [ ] Start the remote development stack for manual review.

Use the existing project scripts. Bind web and API hosts to `0.0.0.0`.

```bash
HOST=0.0.0.0 npm run dev
```

Expected:

- Web UI is reachable from the remote development URL.
- Selecting a job opens the drawer over the table.
- Drawer width can be dragged and persists after reload.
- MediaInfo review shows text output.
- Draft editor shows PTP fields and saves.
- Start upload stays blocked until evidence and draft fields are complete.

- [ ] Inspect git status.

```bash
git status --short
```

Expected: only intentional changes from this plan are present. Preserve unrelated pre-existing changes such as `.gitignore`.

- [ ] Commit final cleanup when needed:

```bash
git add <intentional-files>
git commit -m "test: cover ptp review drawer flow"
```

## Manual Validation Checklist

- [ ] Submit a local test job with a small media fixture.
- [ ] Wait for preparation to complete.
- [ ] Confirm source torrent displays the original torrent name when present.
- [ ] Confirm upload torrent exists and is not displayed as `source.torrent` unless that was the original file name.
- [ ] Open the drawer and inspect screenshots.
- [ ] Confirm MediaInfo text matches PTPUploader-style text output and does not show JSON.
- [ ] Edit required draft fields and save.
- [ ] Confirm advanced fields remain hidden until opened.
- [ ] Start upload in dry-run or mock mode and confirm the PTP payload uses real field names.

## Rollback Plan

Use git commits as rollback boundaries:

- Revert Task 6 to restore the previous draft editor while keeping data fixes.
- Revert Task 5 to restore the fixed review column while keeping backend fixes.
- Revert Tasks 2 through 4 together to restore legacy JSON-only MediaInfo behavior and old submitter mapping.

Do not revert unrelated user changes.
