import type { UploadedAsset } from "../../packages/shared/src";

export interface AssetLookup {
  byPointer(pointer: string): UploadedAsset | null;
  all(): UploadedAsset[];
}

export function assetLookupFromRaw(raw: unknown): AssetLookup {
  const assets = readAssets(raw);
  const byPointer = new Map<string, UploadedAsset>();
  for (const asset of assets) {
    if (asset.pointer && asset.local_path && !byPointer.has(asset.pointer)) {
      byPointer.set(asset.pointer, asset);
    }
  }
  return {
    byPointer(pointer: string) {
      return byPointer.get(pointer) ?? null;
    },
    all() {
      return assets;
    },
  };
}

export function readAssets(raw: unknown): UploadedAsset[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const assets = (raw as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) return [];
  return assets.flatMap((asset) => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) return [];
    const rec = asset as Record<string, unknown>;
    if (typeof rec.pointer !== "string" || typeof rec.local_path !== "string") return [];
    return [{
      pointer: rec.pointer,
      local_path: rec.local_path,
      message_id: typeof rec.message_id === "string" ? rec.message_id : null,
      filename: typeof rec.filename === "string" ? rec.filename : null,
      content_type: typeof rec.content_type === "string" ? rec.content_type : null,
      size_bytes: typeof rec.size_bytes === "number" ? rec.size_bytes : null,
      sha256: typeof rec.sha256 === "string" ? rec.sha256 : null,
    }];
  });
}

export function kindFromContentType(contentType?: string | null): "image" | "audio" | "file" {
  if (contentType?.startsWith("image/")) return "image";
  if (contentType?.startsWith("audio/")) return "audio";
  return "file";
}
