// Synthetic shapes for the ChatGPT metadata entries the monitor used to report as unknown.
// Values are invented; only the structure follows what the web client sends.
import { test, expect } from "bun:test";
import { parseChatgpt } from "../src/parsers/chatgpt";
import sample from "./fixtures/chatgpt-api-sample.json";

const MARK = "citeturn0search0";

function parseWith(metadata: Record<string, unknown>, content?: unknown, role = "assistant") {
  const capture = structuredClone(sample) as any;
  const message = capture.payload.mapping.n3.message;
  message.content = content ?? { content_type: "text", parts: [`Answer ${MARK}`] };
  message.metadata = { model_slug: "gpt-4", ...metadata };
  message.author = { role, name: role === "tool" ? "browser" : null };
  const [session] = parseChatgpt(capture, { raw_ref: "chatgpt/conv-1/v1.json.gz" });
  return session.messages[2];
}

const ref = (extra: Record<string, unknown>) => ({ matched_text: MARK, start_idx: 7, end_idx: 20, safe_urls: [], refs: [], ...extra });
const unknownTypes = (message: { blocks: any[] }) => message.blocks.filter(b => b.type === "unknown").map(b => b.provider_type);
const citations = (message: { blocks: any[] }) => message.blocks.filter(b => b.type === "citation");

test("grouped_webpages, sources_footnote, url and nav_list become deduplicated citations", () => {
  const item = { title: "Page One", url: "https://example.org/one", attribution: "Example", snippet: "", supporting_websites: [
    { title: "Mirror", url: "https://example.org/mirror", attribution: "Example", snippet: "" }] };
  const message = parseWith({ content_references: [
    ref({ type: "grouped_webpages", items: [item, { title: "Page Two", url: "https://example.org/two", snippet: "Two says so" }], fallback_items: null }),
    ref({ type: "sources_footnote", matched_text: "", sources: [{ title: "Page One", url: "https://example.org/one", attribution: "Example" }] }),
    ref({ type: "url", title: "Page", item: { title: "Page Two", url: "https://example.org/two", snippet: "" } }),
    ref({ type: "nav_list", title: null, items: [{ title: "Headline", url: "https://example.org/news", thumbnail_url: "https://example.org/t.png", attribution: "Wire" }] }),
  ] });
  expect(unknownTypes(message)).toEqual([]);
  expect(citations(message)).toEqual([
    { type: "citation", provider_type: "grouped_webpages", url: "https://example.org/one", title: "Page One", text: null },
    { type: "citation", provider_type: "grouped_webpages", url: "https://example.org/mirror", title: "Mirror", text: null },
    { type: "citation", provider_type: "grouped_webpages", url: "https://example.org/two", title: "Page Two", text: "Two says so" },
    { type: "citation", provider_type: "nav_list", url: "https://example.org/news", title: "Headline", text: null },
  ]);
  expect(message.text).toContain("https://example.org/two");
  expect(message.text).toContain("Headline");
});

test("image_group and image_v2 keep titles and page urls but never invent an image asset", () => {
  const message = parseWith({ content_references: [
    ref({ type: "image_group", alt: "long generated description", images: [
      { image_result: { url: "https://example.org/page-a", content_url: "https://img.example.org/a.jpg", thumbnail_url: "https://img.example.org/a-t.jpg", title: "Picture A" }, image_search_query: "query" },
      { image_result: { url: "https://example.org/page-b", content_url: "https://img.example.org/b.jpg", title: "Picture B" } }] }),
    ref({ type: "image_v2", images: [{ url: "https://example.org/page-c", content_url: "https://img.example.org/c.jpg", title: "Picture C", attribution: "Site" }] }),
  ] });
  expect(unknownTypes(message)).toEqual([]);
  expect(citations(message).map(b => [b.provider_type, b.title, b.url])).toEqual([
    ["image_group", "Picture A", "https://example.org/page-a"],
    ["image_group", "Picture B", "https://example.org/page-b"],
    ["image_v2", "Picture C", "https://example.org/page-c"],
  ]);
  expect(message.blocks.some(b => ["image", "attachment"].includes(b.type))).toBe(false);
});

test("product and products references become citations with price and merchant text", () => {
  const product = { id: "p1", title: "Kettle", url: "https://shop.example.org/kettle", price: "$20", merchants: "ShopCo", image_urls: ["https://img.example.org/k.jpg"] };
  const message = parseWith({ content_references: [
    ref({ type: "product", product }),
    ref({ type: "products", products: [{ ...product, id: "p2", title: "Toaster", url: "", price: "$30", merchants: "" }] }),
  ] });
  expect(unknownTypes(message)).toEqual([]);
  expect(citations(message)).toEqual([
    { type: "citation", provider_type: "product", url: "https://shop.example.org/kettle", title: "Kettle", text: "$20 ShopCo" },
    { type: "citation", provider_type: "products", url: null, title: "Toaster", text: "$30" },
  ]);
});

test("map widgets keep their places, entity_metadata keeps the business", () => {
  const message = parseWith({ content_references: [
    ref({ type: "client_defined_widget", category: "map", data: { fill: false, points: [
      { name: "Cafe One", address: "1 Main St", latitude: 1, longitude: 2, entity: { website_url: "https://cafe.example.org" } },
      { name: "Cafe Two", address: "2 Main St", latitude: 3, longitude: 4, entity: null }] } }),
    ref({ type: "entity_metadata", name: "Cafe One", metadata: { map_url: "https://maps.example.org/one" }, entity_data: { name: "Cafe One", address: "1 Main St" } }),
  ] });
  expect(unknownTypes(message)).toEqual([]);
  expect(citations(message).map(b => [b.provider_type, b.title, b.url, b.text])).toEqual([
    ["client_defined_widget", "Cafe One", "https://cafe.example.org", "1 Main St"],
    ["client_defined_widget", "Cafe Two", null, "2 Main St"],
    ["entity_metadata", "Cafe One", "https://maps.example.org/one", "1 Main St"],
  ]);
});

test("file references and file citations become citations carrying the cited file name", () => {
  const message = parseWith({
    content_references: [ref({ type: "file", name: "notes.pdf", id: "file-abc", source: "my_files", snippet: null, cloud_doc_url: null })],
    citations: [
      { start_ix: 1, end_ix: 4, citation_format_type: "tether_og", metadata: { type: "file", name: "notes.pdf", id: "file-abc", source: "my_files", text: "quoted line", extra: { cloud_doc_url: "https://docs.example.org/notes" } } },
      { start_ix: 5, end_ix: 8, citation_format_type: "tether_og", invalid_reason: "not found" },
    ] });
  expect(unknownTypes(message)).toEqual([]);
  expect(citations(message)).toEqual([
    { type: "citation", provider_type: "file", url: "https://docs.example.org/notes", title: "notes.pdf", text: "quoted line" },
    { type: "citation", provider_type: "file", url: null, title: "notes.pdf", text: null },
  ]);
});

test("metadata attachments keep their media block and stop reporting an unknown", () => {
  const message = parseWith({ attachments: [{ id: "file-up1", name: "photo.png", mime_type: "image/png", size: 10, width: 1, height: 1 }] });
  expect(unknownTypes(message)).toEqual([]);
  expect(message.blocks).toContainEqual(expect.objectContaining({ type: "image", pointer: "file-up1", filename: "photo.png" }));
  const odd = parseWith({ attachments: [{ name: "no id" }] });
  expect(unknownTypes(odd)).toEqual(["attachments"]);
});

test("pure display metadata is known and ignored, with the payload still in the message text", () => {
  const message = parseWith({ content_references: [
    ref({ type: "hidden", matched_text: "", invalid: false }),
    ref({ type: "entity", matched_text: "entity[\"city\",\"Oslo\",\"capital\"]", name: "Oslo", alt: "Oslo" }),
    ref({ type: "followup_a", matched_text: "Want more detail?", alt: "Want more detail?", prompt_text: "Give more detail" }),
    ref({ type: "client_defined_widget", category: "code_block", data: { widget_type: "code_block", content: "print(1)", language: "py" } }),
    ref({ type: "client_defined_widget", category: "app_block", data: { widget_type: "app_block", content: "<div></div>", title: "App" } }),
    ref({ type: "client_defined_widget", category: "writing_block_final_output", data: { widget_type: "writing_block_final_output" } }),
    ref({ type: "dil", dil: { type: "Basic", children: [{ type: "Button", $label: "Go" }] }, name: "pill" }),
  ] });
  expect(unknownTypes(message)).toEqual([]);
  expect(message.blocks.map(b => b.type)).toEqual(["text"]);
});

test("entity lookups with address or website keep them, and a span too short for its widget payload alerts", () => {
  const span = "\ue200entity\ue202[\"place\",\"Cafe One\",\"x\"]\ue201";
  const message = parseWith({ content_references: [
    ref({ type: "entity", matched_text: span, name: "Cafe One", entity_data: { name: "Cafe One", address: "1 Main St", website_url: "https://cafe.example.org" } }),
    ref({ type: "client_defined_widget", matched_text: "short", data: { widget_type: "code_block", content: "a much longer payload than the span" } }),
  ] });
  expect(citations(message)).toEqual([{ type: "citation", provider_type: "entity", url: "https://cafe.example.org", title: "Cafe One", text: "1 Main St" }]);
  expect(unknownTypes(message)).toEqual(["client_defined_widget:code_block"]);
});

test("dil widgets that list quoted sources keep them as citations", () => {
  const message = parseWith({ content_references: [ref({ type: "dil", dil: { type: "Basic", initialState: { items: [
    { refid: "r1", quote: "A quote", subreddit: "r/x", source_title: "Thread", source_url: "https://forum.example.org/t/1", metadata_label: "x" }] } } })] });
  expect(unknownTypes(message)).toEqual([]);
  expect(citations(message)).toEqual([{ type: "citation", provider_type: "dil", url: "https://forum.example.org/t/1", title: "Thread", text: "A quote" }]);
});

test("tether_browsing_display with no content is ignored, one with content still alerts", () => {
  const empty = parseWith({}, { content_type: "tether_browsing_display", result: "", summary: "", assets: null, tether_id: null }, "tool");
  expect(unknownTypes(empty)).toEqual([]);
  const full = parseWith({}, { content_type: "tether_browsing_display", result: "page text", summary: "", assets: null, tether_id: null }, "tool");
  expect(unknownTypes(full)).toEqual(["tether_browsing_display"]);
});

test("types nobody has seen, and shapes that do not match, still alert under a distinct label", () => {
  const message = parseWith({ content_references: [
    ref({ type: "brand_new_reference", payload: 1 }),
    ref({ type: "grouped_webpages", items: "not a list" }),
    ref({ type: "client_defined_widget", category: "future", data: { widget_type: "future_widget" } }),
    ref({ type: "entity", matched_text: "something else", name: "Oslo" }),
    ref({ type: "alt_text", alt: "A description" }),
    ref({ type: "map" }),
  ], citations: [{ source: "paper" }] });
  expect(unknownTypes(message)).toEqual(["citations", "brand_new_reference", "grouped_webpages", "client_defined_widget:future_widget", "entity", "alt_text", "map"]);
});

test("citation blocks carry only the existing schema fields", () => {
  const message = parseWith({ content_references: [ref({ type: "url", item: { title: "T", url: "https://example.org/x" } })] });
  expect(Object.keys(citations(message)[0]).sort()).toEqual(["provider_type", "text", "title", "type", "url"]);
});
