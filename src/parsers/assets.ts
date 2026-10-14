import type { UploadedAsset, AssetBackfillReference } from "../../packages/shared/src";

export interface AssetLookup {
  byPointer(pointer: string): UploadedAsset | null;
  all(): UploadedAsset[];
  references(): AssetBackfillReference[];
  /** View of one message's assets: its own records win, legacy records without message_id are the only fallback. */
  scoped(messageIds: Array<string | null | undefined>): AssetLookup;
}

export function assetLookupFromRaw(raw: unknown): AssetLookup {
  return buildLookup(readAssets(raw), raw, null);
}

function buildLookup(base: UploadedAsset[], raw: unknown, ids: Set<string> | null): AssetLookup {
  const assets = ids ? base.filter(asset => !asset.message_id || ids.has(asset.message_id)) : base;
  return {
    byPointer(pointer: string) {
      const matches = assets.filter(asset => asset.pointer === pointer);
      return (ids ? matches.find(asset => asset.message_id) : null) ?? matches[0] ?? null;
    },
    references() {
      const refs = raw && typeof raw === "object" ? (raw as { asset_references?: unknown }).asset_references : null;
      const discovered = Array.isArray(refs) ? refs.filter(ref => ref && typeof ref.pointer === "string") as AssetBackfillReference[] : [];
      return [...assets.map(asset => ({ pointer: asset.pointer, message_id: asset.message_id ?? null, filename: asset.filename ?? null, content_type: asset.content_type ?? null })),
        ...discovered.filter(ref => !ids || !ref.message_id || ids.has(ref.message_id))];
    },
    all() {
      return assets;
    },
    scoped(messageIds) {
      return buildLookup(base, raw, new Set(messageIds.filter((id): id is string => !!id)));
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
