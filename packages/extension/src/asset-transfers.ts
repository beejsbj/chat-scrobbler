import type { AssetUploadRequest } from "./messages";

export const ASSET_CHUNK_BYTES = 1024 * 1024;
type Metadata = Omit<AssetUploadRequest, "bytes">;
interface Transfer { asset: Metadata; bytes: Uint8Array; received: number; touched: number; }

/** Keep individual Chrome runtime messages below its serialization limit. */
export class AssetTransfers {
  private transfers = new Map<string, Transfer>();
  start(asset: Metadata, size: number, limit: number): string {
    for (const [id, transfer] of this.transfers) if (Date.now() - transfer.touched > 120_000) this.transfers.delete(id);
    if (!Number.isSafeInteger(size) || size < 1 || size > limit) throw new Error("asset_too_large");
    if (this.transfers.size >= 2) throw new Error("asset_transfer_busy");
    const id = crypto.randomUUID();
    this.transfers.set(id, { asset, bytes: new Uint8Array(size), received: 0, touched: Date.now() });
    return id;
  }
  append(id: string, offset: number, bytes: number[]): void {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.received !== offset || bytes.length > ASSET_CHUNK_BYTES || offset + bytes.length > transfer.bytes.length) throw new Error("invalid_asset_chunk");
    transfer.bytes.set(bytes, offset);
    transfer.received += bytes.length;
    transfer.touched = Date.now();
  }
  finish(id: string): AssetUploadRequest {
    const transfer = this.transfers.get(id);
    this.transfers.delete(id);
    if (!transfer || transfer.received !== transfer.bytes.length) throw new Error("incomplete_asset_transfer");
    return { ...transfer.asset, bytes: transfer.bytes };
  }
  cancel(id: string): void { this.transfers.delete(id); }
}
