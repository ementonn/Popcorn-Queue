import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ImageHostError, ImgBbUploader } from "./image-hosts.js";

describe("ImgBbUploader", () => {
  it("uploads an image through an injected fetch implementation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "popcorn-imgbb-"));
    const filePath = path.join(directory, "shot.png");
    const calls: Array<{ url: string; body: BodyInit | null | undefined }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: init?.body });
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            url: "https://i.ibb.co/image.png",
            display_url: "https://ibb.co/view",
            delete_url: "https://ibb.co/delete",
            medium: { url: "https://i.ibb.co/medium/image.png" },
            width: "1920",
            height: "1080"
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    try {
      await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const result = await new ImgBbUploader("test-key", fetchImpl).uploadImage(filePath);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toContain("https://api.imgbb.com/1/upload?key=test-key");
      expect(calls[0]?.body).toBeInstanceOf(FormData);
      expect(result).toMatchObject({
        host: "imgbb",
        url: "https://i.ibb.co/image.png",
        viewerUrl: "https://ibb.co/view",
        deleteUrl: "https://ibb.co/delete",
        mediumUrl: "https://i.ibb.co/medium/image.png",
        width: 1920,
        height: 1080
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not call the network without an API key", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("fetch should not be called");
    };

    await expect(new ImgBbUploader("", fetchImpl).uploadImage("/tmp/missing.png")).rejects.toBeInstanceOf(ImageHostError);
  });
});
