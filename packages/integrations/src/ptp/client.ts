import { normalizePtpResponse, type NormalizedPtpResponse } from "@popcorn-queue/core";

export interface PtpClientConfig {
  apiUser: string;
  apiKey: string;
  baseUrl?: string;
  userAgent?: string;
}

export class PtpApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean
  ) {
    super(message);
  }
}

export class PtpClient {
  private readonly baseUrl: string;
  private readonly userAgent: string;

  constructor(private readonly config: PtpClientConfig) {
    this.baseUrl = config.baseUrl ?? "https://passthepopcorn.me/torrents.php";
    this.userAgent = config.userAgent ?? "Popcorn Queue/0.1";
  }

  async searchByCandidate(params: { title: string; imdbId?: string | null; searchName: string; year?: string }): Promise<NormalizedPtpResponse> {
    if (params.imdbId) {
      return this.searchByImdb(params.imdbId);
    }
    const url = new URL(this.baseUrl);
    url.searchParams.set("searchstr", params.searchName);
    if (params.year) url.searchParams.set("year", params.year);
    url.searchParams.set("json", "noredirect");
    return this.fetchJson(url);
  }

  async searchByImdb(imdbId: string): Promise<NormalizedPtpResponse> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("imdb", imdbId);
    url.searchParams.set("json", "noredirect");
    return this.fetchJson(url);
  }

  async getGroup(groupId: string): Promise<NormalizedPtpResponse> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("id", groupId);
    url.searchParams.set("json", "1");
    url.searchParams.set("jsontrumpable", "1");
    return this.fetchJson(url);
  }

  private async fetchJson(url: URL): Promise<NormalizedPtpResponse> {
    const response = await fetch(url, {
      redirect: "manual",
      headers: {
        ApiUser: this.config.apiUser,
        ApiKey: this.config.apiKey,
        "User-Agent": this.userAgent,
        Accept: "application/json"
      }
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new PtpApiError("PTP returned a redirect without a Location header.", response.status, true);
      }
      const redirectUrl = new URL(location, this.baseUrl);
      if (redirectUrl.searchParams.has("id")) {
        redirectUrl.searchParams.set("json", "1");
        redirectUrl.searchParams.set("jsontrumpable", "1");
      } else {
        redirectUrl.searchParams.set("json", "noredirect");
      }
      return this.fetchJson(redirectUrl);
    }

    if (response.status === 429) {
      throw new PtpApiError("PTP API rate limit reached.", response.status, true);
    }
    if (response.status === 403) {
      throw new PtpApiError("PTP API credentials rejected; circuit breaker should halt further requests.", response.status, false);
    }
    if (response.status === 503) {
      throw new PtpApiError("PTP is unavailable or in intermission.", response.status, true);
    }
    if (!response.ok) {
      throw new PtpApiError(`PTP API request failed with HTTP ${response.status}.`, response.status, response.status >= 500);
    }

    const text = await response.text();
    if (text.trim().startsWith("<")) {
      throw new PtpApiError("PTP returned HTML instead of JSON.", response.status, true);
    }
    return normalizePtpResponse(JSON.parse(text));
  }
}
