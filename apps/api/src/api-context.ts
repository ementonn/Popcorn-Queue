import type { CacheStore, NormalizedPtpResponse } from "@popcorn-queue/core";
import type { BrowserCheckService, PtpClient } from "@popcorn-queue/integrations";
import type { CommandExecutor, PtpSubmitter, TorrentDownloadClient } from "@popcorn-queue/worker";
import type { WebSessionAuth, makeBrowserAuthHook } from "./auth.js";
import type { ApiConfig } from "./config.js";
import type { PrismaPersistence } from "./persistence.js";
import type { PreparationService } from "./preparation.js";

export interface BuildServerOptions {
  autoPrepare?: boolean;
  ptpSubmitter?: PtpSubmitter;
  torrentClient?: TorrentDownloadClient;
  commandExecutor?: CommandExecutor;
  fetchImpl?: typeof fetch;
  settingsEnvPath?: string;
}

export interface ApiRouteContext {
  config(): ApiConfig;
  jobRepository: PrismaPersistence["jobs"];
  cache: CacheStore<NormalizedPtpResponse>;
  options: BuildServerOptions;
  settingsEnvPath: string;
  getPtpClient(): PtpClient;
  getBrowserChecks(): BrowserCheckService;
  getTorrentClient(): TorrentDownloadClient | null;
  getPtpSubmitter(): PtpSubmitter | undefined;
  getPreparation(): PreparationService;
  getWebAuth(): WebSessionAuth;
  getBrowserAuthHook(): ReturnType<typeof makeBrowserAuthHook>;
  enqueuePreparation(jobId: string): void;
  applyRuntimeConfig(config: ApiConfig): void;
}
