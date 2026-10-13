import { asArray, asObject } from "./types";
import type { ProviderAssetCandidate } from "./assets";

/** Source-verified in Claude web exporters; requires live session verification. */
export function claudeSandboxDownloadEndpoint(orgId: string, conversationId: string, path: string): string {
  return `/api/organizations/${encodeURIComponent(orgId)}/conversations/${encodeURIComponent(conversationId)}/wiggle/download-file?path=${encodeURIComponent(path)}`;
}

export function claudeAssetCandidates(payload: unknown, sourceId: string, orgId: string): ProviderAssetCandidate[] {
  const out: ProviderAssetCandidate[] = [];
  for (const raw of asArray(asObject(payload).chat_messages)) {
    const message = asObject(raw);
    const messageId = str(message.uuid);
    const add = (pointer: string, file: Record<string, unknown>, explicitUrl?: string | null) => {
      const path = str(file.path ?? file.file_path) ?? (pointer.startsWith("sandbox:") ? pointer.slice(8) : null);
      const url = explicitUrl ?? str(file.download_url ?? file.preview_url ?? file.url ?? file.document_asset) ?? str(asObject(file.document_asset).url)
        ?? (path ? claudeSandboxDownloadEndpoint(orgId, sourceId, path)
          : claudeUnverifiedFileDownloadEndpoint(orgId, pointer));
      out.push({ source: "claude", sourceId, messageId, pointer, url,
        filename: str(file.file_name ?? file.filename ?? file.name) ?? path?.split("/").at(-1),
        contentType: str(file.mime_type ?? file.content_type ?? file.media_type),
      });
    };
    for (const key of ["files", "files_v2", "attachments", "generated_files"]) for (const file of asArray(message[key])) {
      const item = asObject(file);
      const pointer = str(item.file_uuid ?? item.uuid ?? item.id ?? item.attachment_uuid ?? item.path);
      if (pointer) add(pointer, item);
    }
    const visit = (value: unknown, path: string): void => {
      if (typeof value === "string") {
        if (/^\/mnt\/user-data\/(uploads|outputs)\/[^\s]+$/.test(value)) add(`sandbox:${value}`, {});
        for (const match of value.matchAll(/sandbox:\/[^\s)\]<>"']+/g)) add(match[0], {});
        return;
      }
      if (Array.isArray(value)) { value.forEach((item, i) => visit(item, `${path}/${i}`)); return; }
      const item = asObject(value);
      const source = asObject(item.source);
      if (source.type === "base64" && typeof source.data === "string") {
        const mime = str(source.media_type) ?? "application/octet-stream";
        add(`claude-inline:${messageId}:${path}`, { media_type: mime }, `data:${mime};base64,${source.data}`);
        return;
      }
      if (["image", "document", "file", "audio", "video"].includes(String(item.type))) {
        const pointer = str(item.file_uuid ?? source.file_uuid ?? source.file_id ?? source.url ?? item.url);
        if (pointer) { add(pointer, { ...item, ...source }, str(source.url ?? item.url)); return; }
      }
      Object.entries(item).forEach(([key, v]) => visit(v, `${path}/${key}`));
    };
    visit(message.content, "/content");
  }
  return out;
}
function str(value: unknown): string | null { return typeof value === "string" && value ? value : null; }

/** UNVERIFIED legacy fallback. Prefer URLs supplied in files_v2/document_asset or sandbox paths. */
export function claudeUnverifiedFileDownloadEndpoint(orgId: string, pointer: string): string {
  return `/api/organizations/${encodeURIComponent(orgId)}/files/${encodeURIComponent(pointer)}/download`;
}
