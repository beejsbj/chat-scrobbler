// ChatGPT message metadata (`citations`, `content_references`, `attachments`).
// Each entry is one of three things: a source or place a reader would want
// (becomes a `citation` block), a display span whose payload the message text already
// carries (known and ignored), or something unrecognized (stays `unknown`, so a new
// shape still alerts). The raw capture keeps every ignored entry.
import type { Block } from "../schema/types";
import { childLocation, unknownBlock, type PartLocation } from "./parts";

type Citation = Extract<Block, { type: "citation" }>;
const rec = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const str = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];

const cite = (provider_type: string, title: unknown, url: unknown, text: unknown): Citation =>
  ({ type: "citation", provider_type, url: str(url), title: str(title), text: str(text) });

/** Web results: grouped pages, footnote lists and nav lists share this item shape. */
const pageCitations = (type: string, items: unknown): Citation[] =>
  list(items).flatMap(item => [item, ...list(rec(item).supporting_websites)])
    .filter(item => str(rec(item).url))
    .map(item => cite(type, rec(item).title, rec(item).url, rec(item).snippet));

const productCitation = (type: string, product: unknown): Citation[] => {
  const p = rec(product);
  if (!str(p.title)) return [];
  return [cite(type, p.title, p.url, [str(p.price), str(p.merchants)].filter(Boolean).join(" "))];
};

/** The matched span is a substring of the message text, so a payload inside it is already searchable. */
const spanCarries = (entry: Record<string, any>, value: unknown) => {
  const span = str(entry.matched_text);
  const needle = str(value);
  return !!span && !!needle && span.includes(needle);
};

/** Widgets whose whole payload is embedded in the matched span the message text carries. */
const SPAN_WIDGETS = new Set(["writing_block_final_output", "app_block", "code_block"]);

/** The span must be at least as long as the content it is said to hold; a shorter one cannot carry it. */
const spanHolds = (entry: Record<string, any>, content: unknown) => {
  const span = str(entry.matched_text);
  return !!span && (typeof content !== "string" || span.length >= content.length);
};

/** Citations for a recognized `content_references` entry, [] for a known-ignored one, null for unrecognized. */
function fromReference(entry: Record<string, any>): Citation[] | null {
  const type = entry.type;
  switch (type) {
    case "grouped_webpages": {
      if (!Array.isArray(entry.items)) return null;
      return [...pageCitations(type, entry.items), ...pageCitations(type, entry.fallback_items)];
    }
    case "sources_footnote": return Array.isArray(entry.sources) ? pageCitations(type, entry.sources) : null;
    case "nav_list": return Array.isArray(entry.items) ? pageCitations(type, entry.items) : null;
    case "url": return entry.item && typeof entry.item === "object" ? pageCitations(type, [entry.item]) : null;
    case "image_group": return Array.isArray(entry.images)
      ? entry.images.flatMap((image: unknown) => { const r = rec(rec(image).image_result); return str(r.url) ? [cite(type, r.title, r.url, null)] : []; })
      : null;
    case "image_v2": return Array.isArray(entry.images)
      ? entry.images.filter((image: unknown) => str(rec(image).url)).map((image: unknown) => cite(type, rec(image).title, rec(image).url, null))
      : null;
    case "product": return entry.product && typeof entry.product === "object" ? productCitation(type, entry.product) : null;
    case "products": return Array.isArray(entry.products) ? entry.products.flatMap((p: unknown) => productCitation(type, p)) : null;
    case "file": return str(entry.name) ? [cite(type, entry.name, entry.cloud_doc_url, entry.snippet)] : null;
    case "entity_metadata": {
      const data = rec(entry.entity_data);
      const title = str(entry.name) ?? str(data.name);
      return title ? [cite(type, title, rec(entry.metadata).map_url, data.address)] : null;
    }
    case "client_defined_widget": {
      const data = rec(entry.data);
      if (Array.isArray(data.points)) {
        return data.points.filter((point: unknown) => str(rec(point).name))
          .map((point: unknown) => cite(type, rec(point).name, rec(rec(point).entity).website_url, rec(point).address));
      }
      return SPAN_WIDGETS.has(data.widget_type) && spanHolds(entry, data.content) ? [] : null;
    }
    // Interface layout. Lists of quoted sources inside it are the only content.
    case "dil": return list(rec(rec(entry.dil).initialState).items).filter(item => str(rec(item).source_url))
      .map(item => cite(type, rec(item).source_title, rec(item).source_url, rec(item).quote));
    // Pure display spans: nothing a reader sees that the message text does not already carry.
    case "hidden": return [];
    case "entity": {
      if (!spanCarries(entry, entry.name)) return null;
      // Business lookups carry address and links that are not in the span.
      const data = rec(entry.entity_data);
      return str(data.address) || str(data.website_url) ? [cite(type, entry.name, data.website_url ?? rec(entry.metadata).map_url, data.address)] : [];
    }
    case "followup_a": return spanCarries(entry, entry.alt) ? [] : null;
    // alt_text and map are deliberately not handled: redacted samples do not show what they hold.
    default: return null;
  }
}

/** File citations. An entry that only reports why a citation was invalid carries no content. */
function fromCitation(entry: Record<string, any>): Citation[] | null {
  const meta = rec(entry.metadata);
  if (entry.metadata && typeof entry.metadata === "object" && str(meta.type) && (str(meta.name) || str(meta.title))) {
    return [cite(meta.type, meta.name ?? meta.title, meta.url ?? rec(meta.extra).cloud_doc_url, meta.text)];
  }
  return str(entry.invalid_reason) && !entry.metadata ? [] : null;
}

const citationKey = (c: Citation) => c.url ?? `${c.title}\n${c.text}`;

/** Blocks for one metadata key: recognized entries become citations (deduplicated per message), the rest stay unknown. */
export function blocksFromMetadata(key: "citations" | "content_references" | "attachments", entries: unknown,
  loc: PartLocation, seen: Set<string>): Block[] {
  const blocks: Block[] = [];
  const visit = (entry: unknown, at: PartLocation) => {
    const entryRec = rec(entry);
    let found: Citation[] | null = null;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      if (key === "citations") found = fromCitation(entryRec);
      else if (key === "content_references") found = fromReference(entryRec);
      // An attachment with an id is linked as media by the caller; one without has nothing to link.
      else found = str(entryRec.id) ? [] : null;
    }
    if (!found) {
      const block = unknownBlock(entry, at, key);
      const widget = key === "content_references" && entryRec.type === "client_defined_widget" ? str(rec(entryRec.data).widget_type) : null;
      blocks.push(widget && block.type === "unknown" ? { ...block, provider_type: `client_defined_widget:${widget}` } : block);
      return;
    }
    for (const citation of found) {
      const id = citationKey(citation);
      if (seen.has(id)) continue;
      seen.add(id);
      blocks.push(citation);
    }
  };
  if (Array.isArray(entries)) entries.forEach((entry, i) => visit(entry, childLocation(loc, i)));
  else if (entries != null) blocks.push(unknownBlock(entries, loc, key));
  return blocks;
}
