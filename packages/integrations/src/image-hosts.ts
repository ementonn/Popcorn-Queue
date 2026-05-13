import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ImageUploadResult {
  host: string;
  url: string;
  viewerUrl: string;
  deleteUrl: string | null;
  mediumUrl: string | null;
  width: number | null;
  height: number | null;
}

export interface ImageHostUploader {
  readonly name: string;
  uploadImage(filePath: string): Promise<ImageUploadResult>;
}

export class ImageHostError extends Error {
  constructor(
    message: string,
    public readonly host: string,
    public readonly retryable: boolean
  ) {
    super(message);
  }
}

export class NotConfiguredImageHostUploader implements ImageHostUploader {
  readonly name = "not-configured";

  async uploadImage(): Promise<ImageUploadResult> {
    throw new ImageHostError("Image host is not configured.", this.name, false);
  }
}

interface ImgBbResponse {
  success?: boolean;
  data?: {
    url?: string;
    display_url?: string;
    delete_url?: string;
    width?: number | string;
    height?: number | string;
    medium?: {
      url?: string;
    };
  };
  error?: {
    message?: string;
  };
}

function numeric(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export class ImgBbUploader implements ImageHostUploader {
  readonly name = "imgbb";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async uploadImage(filePath: string): Promise<ImageUploadResult> {
    if (!this.apiKey) {
      throw new ImageHostError("IMGBB_API_KEY is not configured.", this.name, false);
    }

    const bytes = await readFile(filePath);
    const uploadUrl = new URL("https://api.imgbb.com/1/upload");
    uploadUrl.searchParams.set("key", this.apiKey);

    const form = new FormData();
    form.set("image", bytes.toString("base64"));
    form.set("name", path.basename(filePath, path.extname(filePath)));

    const response = await this.fetchImpl(uploadUrl, {
      method: "POST",
      body: form
    });
    const text = await response.text();
    let body: ImgBbResponse;
    try {
      body = JSON.parse(text) as ImgBbResponse;
    } catch {
      throw new ImageHostError(`ImgBB returned a non-JSON response with HTTP ${response.status}.`, this.name, response.status >= 500);
    }

    if (!response.ok || body.success === false || !body.data?.url) {
      const message = body.error?.message ?? `ImgBB upload failed with HTTP ${response.status}.`;
      throw new ImageHostError(message, this.name, response.status >= 500 || response.status === 429);
    }

    return {
      host: this.name,
      url: body.data.url,
      viewerUrl: body.data.display_url ?? body.data.url,
      deleteUrl: body.data.delete_url ?? null,
      mediumUrl: body.data.medium?.url ?? null,
      width: numeric(body.data.width),
      height: numeric(body.data.height)
    };
  }
}
