import type { ProviderSource } from "../../../shared/src";
import { allowedAssetUrl } from "./asset-url";
import { RateLimitError, parseRetryAfterMs } from "./types";
import { TransientSyncError } from "./sync-errors";

/**
 * A response that is not the asset (a sign-in redirect, an interstitial page, an error document)
 * can be a passing provider state, so it is reported as a transient download failure. Only a
 * pointer with no usable URL before any fetch is `asset_url_unavailable`, which rests for 30 days.
 */
export const UNEXPECTED_ASSET_RESPONSE = "asset_download_failed";

/** Each request uses manual redirects; this validates the final response after checked hops. */
export function validateAssetResponse(response: Response, source: ProviderSource): void {
  if (response.status === 429 || response.status === 503) throw new RateLimitError("Provider asset", response.status, parseRetryAfterMs(response.headers.get("retry-after")));
  if (response.status >= 500) throw new TransientSyncError(`Provider asset temporarily unavailable (${response.status})`);
  if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400
    || response.url && !allowedAssetUrl(response.url, source)) throw new Error(UNEXPECTED_ASSET_RESPONSE);
}

export type DocumentKind = "json" | "html";

/** What the provider said this attachment is, taken only from its own message metadata. */
export interface AssetDeclaration {
  /** Filename or mime type from the provider's message metadata. A download response never declares. */
  filename?: string | null;
  contentType?: string | null;
  /** Filename from the download response's content-disposition, checked against the declaration. */
  responseFilename?: string | null;
}

const HAS_EXTENSION = /\.[^.\/\\]+$/;
const GENERIC_TYPES = new Set(["application/octet-stream", "binary/octet-stream", "text/plain"]);

/** JSON or HTML by filename extension; any other name is null. */
function kindOfName(name?: string | null): DocumentKind | null {
  const extension = name?.trim().match(/\.([^.\/\\]+)$/)?.[1]?.toLowerCase();
  return extension === "json" ? "json" : extension === "html" || extension === "htm" ? "html" : null;
}

/** JSON or HTML by mime type, ignoring parameters such as charset. */
function kindOfType(type?: string | null): DocumentKind | null {
  const mime = (type ?? "").split(";")[0].trim().toLowerCase();
  return /json/.test(mime) ? "json" : /html/.test(mime) ? "html" : null;
}

/**
 * A `.json` or `.html` attachment is legitimate only when the provider's own message metadata
 * says so: by filename extension, or by mime type when the name has no extension. A filename with
 * another extension, or a filename and mime type that disagree, declares nothing. A generic mime
 * type (octet-stream, text/plain) or none does not disagree with a filename.
 */
export function declaredDocumentKind(filename?: string | null, contentType?: string | null): DocumentKind | null {
  const byType = kindOfType(contentType);
  if (!filename || !HAS_EXTENSION.test(filename.trim())) return byType;
  const byName = kindOfName(filename);
  if (!byName) return null;
  const mime = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return !mime || GENERIC_TYPES.has(mime) || byType === byName ? byName : null;
}

/** What the first 16 KiB of the body looks like, whatever the headers claim. */
function sniffKind(bytes: Uint8Array): DocumentKind | null {
  let start = 0;
  while (start < bytes.length && [9, 10, 13, 32].includes(bytes[start])) start++;
  const prefix = new TextDecoder().decode(bytes.subarray(start, start + 16 * 1024)).replace(/^\uFEFF/, "").trimStart();
  if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(prefix)) return "html";
  return /^[{\[]/.test(prefix) ? "json" : null;
}

/**
 * Never archive a login or session document disguised as an asset.
 *
 * The URL allowlist is the primary defense: a message cannot point the extension at
 * `/api/auth/session`. This is the second layer, for an allowlisted route that answers with a
 * sign-in page or auth document. A JSON or HTML body passes only when the provider declared the
 * attachment as that same kind and nothing in the response contradicts it. Any other document
 * is reported as `UNEXPECTED_ASSET_RESPONSE`.
 */
export function validateAssetBytes(bytes: Uint8Array, contentType?: string | null, declared: AssetDeclaration = {}): void {
  const responseKind = kindOfType(contentType);
  const bodyKind = sniffKind(bytes);
  const kind = declaredDocumentKind(declared.filename, declared.contentType);
  if (!kind) {
    if (responseKind || bodyKind) throw new Error(UNEXPECTED_ASSET_RESPONSE);
    return;
  }
  const dispositionKind = kindOfName(declared.responseFilename);
  if ([responseKind, bodyKind, dispositionKind].some(found => found && found !== kind)) throw new Error(UNEXPECTED_ASSET_RESPONSE);
}
