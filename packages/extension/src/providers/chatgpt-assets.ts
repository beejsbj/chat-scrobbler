import { allowedAssetUrl, providerDownloadUrl } from "./asset-url";
import { validateAssetResponse } from "./asset-response";
import { fetchAllowedAsset } from "./asset-fetch";
import { boundedAssetBuffer } from "./asset-bytes";
import { asArray, asObject, type FetchLike } from "./types";
import type { ProviderAssetCandidate } from "./assets";

/** Download-link route observed in maintained web exporters. Live session verification is pending. */
export function chatgptFileDownloadEndpoint(pointer: string, conversationId: string, messageId?: string | null): string | null {
  const file = pointer.match(/^(sediment|file-service):\/\/(.+)$/);
  if (file?.[1] === "file-service") return `/backend-api/files/${encodeURIComponent(file[2])}/download`;
  if (file) return `/backend-api/files/download/${encodeURIComponent(file[2])}?conversation_id=${encodeURIComponent(conversationId)}&inline=false`;
  if (pointer.startsWith("sandbox:")) {
    // UNVERIFIED: interpreter links vary with backend version. Keep this seam independently testable.
    const params = new URLSearchParams({ message_id: messageId ?? "", sandbox_path: pointer.slice("sandbox:".length) });
    return `/backend-api/conversation/${encodeURIComponent(conversationId)}/interpreter/download?${params}`;
  }
  if (/^file[-_]/.test(pointer)) return `/backend-api/files/download/${encodeURIComponent(pointer)}?conversation_id=${encodeURIComponent(conversationId)}&inline=false`;
  return allowedAssetUrl(pointer, "chatgpt") ? pointer : null;
}

export function chatgptAssetCandidates(payload: unknown, sourceId: string, headers?: Record<string, string>): ProviderAssetCandidate[] {
  const out: ProviderAssetCandidate[] = [];
  for (const [nodeId, node] of Object.entries(asObject(asObject(payload).mapping))) {
    const message = asObject(asObject(node).message);
    const messageId = typeof message.id === "string" ? message.id : nodeId;
    const add = (pointer: string, item: Record<string, unknown> = {}) => {
      out.push({ source: "chatgpt", sourceId, messageId, pointer, headers,
        url: chatgptFileDownloadEndpoint(pointer, sourceId, messageId),
        filename: stringValue(item.name ?? item.filename ?? item.file_name),
        contentType: stringValue(item.mime_type ?? (typeof item.content_type === "string" && item.content_type.includes("/") ? item.content_type : null)),
      });
    };
    const visit = (value: unknown): void => {
      if (typeof value === "string") {
        // Sandbox links in assistant Markdown and execution output, not arbitrary cited web URLs.
        for (const match of value.matchAll(/sandbox:\/[^\s)\]<>"']+/g)) add(match[0]);
        return;
      }
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const item = asObject(value);
      for (const key of ["asset_pointer", "audio_asset_pointer", "video_asset_pointer", "video_container_asset_pointer", "image_url", "download_url"]) {
        if (typeof item[key] === "string" && (key !== "image_url" || allowedAssetUrl(item[key], "chatgpt"))) add(item[key], item);
      }
      Object.values(item).forEach(visit);
    };
    visit(message.content);
    const metadata = asObject(message.metadata);
    visit(metadata.aggregate_result);
    for (const file of [...asArray(metadata.attachments), ...asArray(metadata.generated_files)]) {
      const item = asObject(file);
      const pointer = stringValue(item.asset_pointer ?? item.id ?? item.file_id ?? item.url);
      if (pointer) add(pointer, item);
    }
  }
  return out;
}

export async function resolveChatgptAssetUrl(fetcher: FetchLike, candidate: ProviderAssetCandidate): Promise<string | null> {
  if (!candidate.url) return null;
  if (!allowedAssetUrl(candidate.url, "chatgpt")) throw new Error("asset_url_unavailable");
  if (!providerDownloadUrl(candidate.url, "chatgpt")) return candidate.url;
  if (!candidate.url.includes("/download")) return candidate.url;
  let downloadEndpoint = candidate.url;
  let downloaded = await fetchAllowedAsset(fetcher, downloadEndpoint, "chatgpt", candidate.headers);
  let res = downloaded.response;
  validateAssetResponse(res, "chatgpt");
  if (res.status === 404 && candidate.pointer.startsWith("sediment://")) {
    const id = candidate.pointer.slice("sediment://".length);
    downloadEndpoint = `/backend-api/conversation/${encodeURIComponent(candidate.sourceId)}/attachment/${encodeURIComponent(id)}/download`;
    if (!allowedAssetUrl(downloadEndpoint, "chatgpt")) throw new Error("asset_url_unavailable");
    downloaded = await fetchAllowedAsset(fetcher, downloadEndpoint, "chatgpt", candidate.headers);
    res = downloaded.response;
    validateAssetResponse(res, "chatgpt");
  }
  if (!res.ok) throw new Error(res.status === 404 || res.status === 410 ? "asset_expired" : "asset_download_failed");
  if (!res.headers.get("content-type")?.includes("json")) {
    // Some older download routes return bytes directly.
    candidate.downloadResponse = res;
    return downloaded.url;
  }
  if (!providerDownloadUrl(downloaded.url, "chatgpt") || !downloaded.url.includes("/download")) throw new Error("asset_url_unavailable");
  const link = asObject(JSON.parse(new TextDecoder().decode(await boundedAssetBuffer(res, 1024 * 1024))));
  const url = stringValue(link.download_url ?? link.url);
  if (!url || !allowedAssetUrl(url, "chatgpt")) throw new Error("asset_url_unavailable");
  if (!candidate.filename) candidate.filename = stringValue(link.file_name);
  return url;
}

function stringValue(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
