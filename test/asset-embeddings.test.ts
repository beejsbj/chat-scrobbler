import { test, expect } from "bun:test";
import { indexSession, openIndex, searchMessages, deleteIndexedSession } from "../src/indexer/sqlite";
import { embedAsset, assetCoverage } from "../src/indexer/asset-embeddings";
import { fixture } from "./support/embedding-fixture";

const sha = "a".repeat(64);
const provider = { kind: "media", model: "m", dimensions: 2, embed: () => [1,0], embedAsset: async () => [1,0] };
function session(id = "test") { const s = fixture(""); s.id = `chatgpt:${id}`; s.source_id = id; s.messages[0].blocks = [{ type: "attachment", kind: "image", filename: "photo.png", pointer: "remote", local_path: null, sha256: sha }]; return s; }
test("one asset vector maps to multiple owners including messages without text", async () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, session()); indexSession(db, session("other"));
    let calls = 0;
    const p = { ...provider, embedAsset: async () => { calls++; return [1,0]; } };
    expect(await embedAsset(db, sha, "/tmp/synthetic", p)).toBe("indexed");
    expect(await embedAsset(db, sha, "/tmp/synthetic", p)).toBe("skipped");
    expect(calls).toBe(1);
    expect(assetCoverage(db, p)).toEqual({ total: 1, embedded: 1 });
    expect(searchMessages(db, "unmatched", { embeddingProvider: p }).map(hit => hit.session_id).sort()).toEqual(["chatgpt:other", "chatgpt:test"]);
    expect(searchMessages(db, "unmatched", { embeddingProvider: { ...p, model: "wrong" } })).toEqual([]);
    deleteIndexedSession(db, "chatgpt", "test");
    expect(db.query("SELECT * FROM asset_vectors").all()).toHaveLength(1);
    indexSession(db, fixture("attachment removed"));
    expect(searchMessages(db, "unmatched", { embeddingProvider: p })).toHaveLength(1);
    deleteIndexedSession(db, "chatgpt", "other");
    expect(db.query("SELECT * FROM asset_vectors").all()).toHaveLength(0);
  } finally { db.close(); }
});
test("asset inference cannot resurrect deleted ownership", async () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, session());
    expect(await embedAsset(db, sha, "/tmp/synthetic", { ...provider, embedAsset: async () => { deleteIndexedSession(db, "chatgpt", "test"); return [1,0]; } })).toBe("stale");
    expect(db.query("SELECT * FROM asset_vectors").all()).toHaveLength(0);
  } finally { db.close(); }
});

test("backfill repairs finite-sized corrupt asset vectors and coverage excludes them", async () => {
  const {embedBackfill}=await import("../src/indexer/embed-backfill"); const db=openIndex(":memory:");
  try {
    indexSession(db,session());await embedAsset(db,sha,"/tmp/synthetic",provider);
    db.run("UPDATE asset_vectors SET embedding=?",[new Uint8Array(new Float32Array([NaN,0]).buffer)]);
    expect(assetCoverage(db,provider)).toEqual({total:1,embedded:0});
    expect(await embedBackfill(db,{provider,canonicalDir:"/synthetic/canonical/sessions",load:()=>0,sleep:async()=>{}})).toMatchObject({embedded:1,assets:{total:1,embedded:1}});
    expect(searchMessages(db,"unmatched",{embeddingProvider:provider})).toHaveLength(1);
  } finally {db.close();}
});
test("text-only updates do not scan or prune unrelated asset hashes", async () => {
  const db=openIndex(":memory:");
  try {
    indexSession(db,session());await embedAsset(db,sha,"/tmp/synthetic",provider);
    const orphan="b".repeat(64);db.run("INSERT INTO asset_vectors VALUES (?,?,?,?,?)",[orphan,"media","m",2,new Uint8Array(new Float32Array([1,0]).buffer)]);
    indexSession(db,fixture("attachment removed"));
    expect((db.query("SELECT sha256 FROM asset_vectors").all() as any[]).map(row=>row.sha256)).toEqual([orphan]);
  } finally {db.close();}
});

function mediaSession(blocks: any[]) { const s = fixture(""); s.messages[0].blocks = blocks; return s; }
function links(db: ReturnType<typeof openIndex>) {
  return db.query("SELECT sha256,media_type FROM asset_embedding_links ORDER BY sha256").all() as Array<{sha256:string;media_type:string}>;
}
const hash = (c: string) => c.repeat(64);
const media = (type: string, extra: Record<string, unknown>) => ({ type, pointer: "p", filename: null, local_path: null, ...extra });

test("real parser media blocks are linked by their block type", () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, mediaSession([
      media("image", { sha256: hash("1"), filename: "a.bin" }),
      media("audio", { sha256: hash("2") }),
      media("video", { sha256: hash("3") }),
    ]));
    expect(links(db)).toEqual([
      { sha256: hash("1"), media_type: "image" },
      { sha256: hash("2"), media_type: "audio" },
      { sha256: hash("3"), media_type: "video" },
    ]);
  } finally { db.close(); }
});

test("file blocks infer their media kind from mime, filename, then local_path", () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, mediaSession([
      media("file", { sha256: hash("1"), mime_type: "image/jpeg", filename: "noext" }),
      media("file", { sha256: hash("2"), mime_type: "application/octet-stream", filename: "shot.PNG" }),
      media("file", { sha256: hash("3"), mime_type: null, filename: null, local_path: `assets/sha256/33/${hash("3")}.m4a` }),
      media("file", { sha256: hash("4"), mime_type: "video/mp4" }),
      media("file", { sha256: hash("5"), filename: "clip.mkv" }),
    ]));
    expect(links(db)).toEqual([
      { sha256: hash("1"), media_type: "image" },
      { sha256: hash("2"), media_type: "image" },
      { sha256: hash("3"), media_type: "audio" },
      { sha256: hash("4"), media_type: "video" },
      { sha256: hash("5"), media_type: "video" },
    ]);
  } finally { db.close(); }
});

test("file blocks that are not image, audio, or video are skipped", () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, mediaSession([
      media("file", { sha256: hash("1"), mime_type: "application/pdf", filename: "paper.pdf" }),
      media("file", { sha256: hash("2"), mime_type: "application/octet-stream", filename: "notes.docx", local_path: `assets/sha256/22/${hash("2")}.docx` }),
      media("file", { sha256: hash("3") }),
    ]));
    expect(links(db)).toEqual([]);
  } finally { db.close(); }
});

test("a missing sha256 falls back to the hash in local_path; invalid hashes are skipped", () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, mediaSession([
      media("image", { local_path: `assets/sha256/aa/${hash("a")}.jpg` }),
      media("image", { sha256: "not-a-hash", local_path: "assets/sha256/bb/short.jpg" }),
      media("image", { local_path: "assets/nothing.jpg" }),
    ]));
    expect(links(db)).toEqual([{ sha256: hash("a"), media_type: "image" }]);
  } finally { db.close(); }
});

test("legacy attachment blocks keep their behavior", () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, mediaSession([
      { type: "attachment", kind: "audio", pointer: "p", filename: null, local_path: null, sha256: hash("1") },
      { type: "attachment", kind: "file", pointer: "p", filename: "v.webm", local_path: null, sha256: hash("2") },
      { type: "attachment", kind: "file", pointer: "p", filename: "photo.png", local_path: null, sha256: hash("3") },
    ]));
    expect(links(db)).toEqual([
      { sha256: hash("1"), media_type: "audio" },
      { sha256: hash("2"), media_type: "video" },
    ]);
  } finally { db.close(); }
});

test("legacy attachment blocks keep kind video even without a video filename", () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, mediaSession([
      { type: "attachment", kind: "video", pointer: "p", filename: "clip", local_path: null, sha256: hash("1") },
      { type: "attachment", kind: "file", pointer: "p", filename: "v.avi", local_path: null, sha256: hash("2") },
    ]));
    expect(links(db)).toEqual([
      { sha256: hash("1"), media_type: "video" },
      { sha256: hash("2"), media_type: "video" },
    ]);
  } finally { db.close(); }
});

test("file blocks recognize .avi by filename and local_path", () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, mediaSession([
      media("file", { sha256: hash("1"), filename: "movie.AVI" }),
      media("file", { sha256: hash("2"), local_path: `assets/sha256/22/${hash("2")}.avi` }),
    ]));
    expect(links(db)).toEqual([
      { sha256: hash("1"), media_type: "video" },
      { sha256: hash("2"), media_type: "video" },
    ]);
  } finally { db.close(); }
});

test("an explicit non-media mime wins over a media extension; missing, empty, or octet-stream mime falls back", () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, mediaSession([
      media("file", { sha256: hash("1"), mime_type: "application/pdf", filename: "scan.png" }),
      media("file", { sha256: hash("2"), mime_type: "text/plain", local_path: `assets/sha256/22/${hash("2")}.mp4` }),
      media("file", { sha256: hash("3"), mime_type: "", filename: "a.png" }),
      media("file", { sha256: hash("4"), mime_type: "application/octet-stream", filename: "a.mp3" }),
      media("file", { sha256: hash("5"), filename: "a.mp4" }),
    ]));
    expect(links(db)).toEqual([
      { sha256: hash("3"), media_type: "image" },
      { sha256: hash("4"), media_type: "audio" },
      { sha256: hash("5"), media_type: "video" },
    ]);
  } finally { db.close(); }
});
