import { expect, test } from "bun:test";
import { uploadProviderAssets } from "../packages/extension/src/providers/assets";
import { allowedAssetUrl, assetCredentials } from "../packages/extension/src/providers/asset-url";

test("legacy DALL-E signed Azure media is allowed without provider cookies", () => {
  const url = "https://oaidalleapiprodscus.blob.core.windows.net/private/image.png?sig=signed";
  expect(allowedAssetUrl(url, "chatgpt")).toBe(true);
  expect(assetCredentials(url, "chatgpt")).toBe("omit");
  expect(allowedAssetUrl("https://unrelated.blob.core.windows.net/image.png")).toBe(false);
});

test("binary response MIME wins over a provider image format hint", async () => {
  const assets = await uploadProviderAssets(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } }),
    async request => {
      expect(request.contentType).toBe("image/jpeg");
      return { pointer: request.pointer, local_path: "assets/gemini/c/hash.jpg" };
    }, [{ source: "gemini", sourceId: "c", pointer: "p", url: "https://lh3.googleusercontent.com/a", contentType: "image/png" }]);
  expect(assets[0]?.content_type).toBe("image/jpeg");
});

test("capture resolves a provider download link before archiving binary bytes", async () => {
  const failures: unknown[] = [];
  const assets = await uploadProviderAssets(async input => {
    expect(input).toBe("https://files.oaiusercontent.com/image.png");
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
  }, async request => {
    expect(Array.from(request.bytes)).toEqual([137, 80, 78, 71]);
    return { pointer: request.pointer, local_path: "assets/chatgpt/c/hash.png" };
  }, [{ source: "chatgpt", sourceId: "c", pointer: "sediment://file_1", url: "/backend-api/files/download/file_1" }], {
    resolveUrl: async () => "https://files.oaiusercontent.com/image.png",
    reportFailure: async failure => { failures.push(failure); },
  });
  expect(assets).toHaveLength(1);
  expect(failures).toEqual([]);
});

test("asset stream is cancelled at the configured limit even without content length", async () => {
  let cancelled = false;
  const failures: unknown[] = [];
  let chunks = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { if (chunks++ < 3) controller.enqueue(new Uint8Array([1, 2, 3])); else controller.close(); },
    cancel() { cancelled = true; },
  });
  const assets = await uploadProviderAssets(async () => new Response(stream), async () => {
    throw new Error("must not upload");
  }, [{ source: "gemini", sourceId: "c", pointer: "p", url: "https://lh3.googleusercontent.com/asset" }], {
    maxBytes: 4, reportFailure: async failure => { failures.push(failure); },
  });
  expect(assets).toEqual([]);
  expect(cancelled).toBe(true);
  expect(failures).toMatchObject([{ reason: "asset_too_large" }]);
});

test("a discovered pointer without a download URL is reported, while text capture continues", async () => {
  const failures: unknown[] = [];
  await uploadProviderAssets(async () => { throw new Error("no fetch expected"); }, async () => {
    throw new Error("no upload expected");
  }, [{ source: "gemini", sourceId: "c", pointer: "unavailable", url: null }], {
    reportFailure: async failure => { failures.push(failure); },
  });
  expect(failures).toMatchObject([{ reason: "asset_url_unavailable", source_id: "c" }]);
});
