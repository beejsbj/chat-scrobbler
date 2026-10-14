import { expect, test } from "bun:test";
import { lookupAssetByHash, uploadAssetToIngest } from "../packages/extension/src/asset-upload";

const bytes = [1, 2, 3];
const sha = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const other = "b".repeat(64);
const settings = { ingestBaseUrl: "http://local", maxAssetBytes: 1000 };
const request = { source: "claude" as const, sourceId: "c", pointer: "p", bytes };
const identity = { source: "claude" as const, sourceId: "c", pointer: "p" };
const good = { ok: true, pointer: "p", local_path: "assets/claude/c/hash.png", sha256: sha, size_bytes: 3 };

const bad: Array<[string, unknown]> = [
  ["empty object", {}], ["null", null], ["array", [good]], ["ok false", { ...good, ok: false }],
  ["missing ok", { ...good, ok: undefined }],
  ["wrong pointer", { ...good, pointer: "q" }], ["empty path", { ...good, local_path: "" }],
  ["absolute path", { ...good, local_path: "/etc/passwd" }], ["traversal path", { ...good, local_path: "assets/../x" }],
  ["non-assets path", { ...good, local_path: "sessions/x.json" }], ["backslash path", { ...good, local_path: "assets\\x" }],
  ["wrong hash", { ...good, sha256: other }], ["missing hash", { ...good, sha256: undefined }],
  ["wrong size", { ...good, size_bytes: 4 }], ["fractional size", { ...good, size_bytes: 3.5 }],
  ["string size", { ...good, size_bytes: "3" }], ["missing size", { ...good, size_bytes: undefined }],
];

function server(onPost: () => Response, lookup: unknown = { ok: true, exists: false }): typeof fetch {
  return (async (_url, init) => init?.method ? onPost() : Response.json(lookup)) as typeof fetch;
}

for (const [name, body] of bad) {
  test(`upload rejects ${name} acknowledgement`, async () => {
    await expect(uploadAssetToIngest(server(() => Response.json(body)), settings, request)).rejects.toThrow("asset_ack_invalid");
  });
  test(`reference rejects ${name} acknowledgement`, async () => {
    await expect(uploadAssetToIngest(server(() => Response.json(body), { ok: true, exists: true, size_bytes: 3 }), settings, request)).rejects.toThrow("asset_ack_invalid");
  });
  test(`hash lookup rejects ${name} reference`, async () => {
    await expect(lookupAssetByHash(server(() => Response.json(body), { ok: true, exists: true, size_bytes: 3 }), settings, identity, sha)).rejects.toThrow("asset_ack_invalid");
  });
}

test("valid acknowledgement is accepted on upload and reference", async () => {
  expect(await uploadAssetToIngest(server(() => Response.json(good)), settings, request)).toMatchObject({ pointer: "p", sha256: sha, size_bytes: 3 });
  expect(await uploadAssetToIngest(server(() => Response.json(good), { exists: true }), settings, request)).toMatchObject({ sha256: sha });
});

test("lookup compares reference size with lookup metadata when available", async () => {
  await expect(lookupAssetByHash(server(() => Response.json(good), { exists: true, size_bytes: 9 }), settings, identity, sha)).rejects.toThrow("asset_ack_invalid");
  expect(await lookupAssetByHash(server(() => Response.json(good), { exists: true }), settings, identity, sha)).toMatchObject({ sha256: sha });
});
