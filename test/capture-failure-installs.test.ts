import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleIngestRequest } from "../packages/ingest/src/server";
import { captureFailureReports, LEGACY_INSTALL_KEY } from "../packages/ingest/src/capture-failures";

function testSetup() {
  const dir = mkdtempSync(join(tmpdir(), "scrobbler-install-failures-"));
  const opts = {
    canonicalDir: join(dir, "canonical/sessions"),
    indexPath: join(dir, "index/db.sqlite"),
    ingestToken: "receiver",
  };
  const request = (body: unknown) =>
    new Request("http://local/status", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer receiver",
      },
      body: JSON.stringify(body),
    });
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, opts, request, cleanup };
}

test("install-A and install-B isolate capture failures: A clearing does not clear B", async () => {
  const { opts, request, cleanup } = testSetup();
  try {
    const failureA = { source_id: "conv-A", updated_at: null, attempts: 3, quarantined: true };
    const failureB = { source_id: "conv-B", updated_at: "2026-06-05T12:00:00Z", attempts: 3, quarantined: true };

    // Install A reports its failure snapshot
    const resA1 = await handleIngestRequest(
      request({ source: "chatgpt", install_id: "install-A", conversations: [], capture_failures: [failureA] }),
      opts,
    );
    expect(resA1.status).toBe(200);
    const dataA1 = await resA1.json();
    expect(dataA1.capture_failures).toEqual([failureA]);

    // Install B reports its failure snapshot for the same provider
    const resB1 = await handleIngestRequest(
      request({ source: "chatgpt", install_id: "install-B", conversations: [], capture_failures: [failureB] }),
      opts,
    );
    expect(resB1.status).toBe(200);
    const dataB1 = await resB1.json();
    expect(dataB1.capture_failures).toEqual([failureB]);

    // Install A queries its own status - should see failureA
    const resAQuery = await handleIngestRequest(
      request({ source: "chatgpt", install_id: "install-A", conversations: [] }),
      opts,
    );
    expect((await resAQuery.json()).capture_failures).toEqual([failureA]);

    // Install B queries its own status - should see failureB
    const resBQuery = await handleIngestRequest(
      request({ source: "chatgpt", install_id: "install-B", conversations: [] }),
      opts,
    );
    expect((await resBQuery.json()).capture_failures).toEqual([failureB]);

    // Install A clears its failures - must not clobber B
    const resAClear = await handleIngestRequest(
      request({ source: "chatgpt", install_id: "install-A", conversations: [], capture_failures: [] }),
      opts,
    );
    expect(resAClear.status).toBe(200);
    expect((await resAClear.json()).capture_failures).toEqual([]);

    // Install B still has its failure record intact
    const resBAfter = await handleIngestRequest(
      request({ source: "chatgpt", install_id: "install-B", conversations: [] }),
      opts,
    );
    expect((await resBAfter.json()).capture_failures).toEqual([failureB]);
  } finally {
    cleanup();
  }
});

test("request without install_id aggregates all install snapshots and preserves legacy callers under legacy install key", async () => {
  const { opts, request, cleanup } = testSetup();
  try {
    const failureA = { source_id: "conv-A", updated_at: null, attempts: 3, quarantined: true };
    const failureB = { source_id: "conv-B", updated_at: "2026-06-05T12:00:00Z", attempts: 3, quarantined: true };
    const failureLegacy = { source_id: "conv-legacy", updated_at: null, attempts: 3, quarantined: true };

    // Legacy caller (no install_id) reports failures
    const resLegacy = await handleIngestRequest(
      request({ source: "chatgpt", conversations: [], capture_failures: [failureLegacy] }),
      opts,
    );
    expect(resLegacy.status).toBe(200);

    // Install A and B report
    await handleIngestRequest(
      request({ source: "chatgpt", install_id: "install-A", conversations: [], capture_failures: [failureA] }),
      opts,
    );
    await handleIngestRequest(
      request({ source: "chatgpt", install_id: "install-B", conversations: [], capture_failures: [failureB] }),
      opts,
    );

    // Query without install_id should aggregate all snapshots
    const resUnscoped = await handleIngestRequest(
      request({ source: "chatgpt", conversations: [] }),
      opts,
    );
    expect(resUnscoped.status).toBe(200);
    const unscopedData = await resUnscoped.json();
    const ids = unscopedData.capture_failures.map((f: any) => f.source_id).sort();
    expect(ids).toEqual(["conv-A", "conv-B", "conv-legacy"]);

    // Legacy caller clears, install-A and install-B remain in aggregate
    await handleIngestRequest(
      request({ source: "chatgpt", conversations: [], capture_failures: [] }),
      opts,
    );
    const resAfterLegacyClear = await handleIngestRequest(
      request({ source: "chatgpt", conversations: [] }),
      opts,
    );
    const idsAfterClear = (await resAfterLegacyClear.json()).capture_failures.map((f: any) => f.source_id).sort();
    expect(idsAfterClear).toEqual(["conv-A", "conv-B"]);
  } finally {
    cleanup();
  }
});

test("install_id validates limited safe string format and rejects unsafe or malformed identifiers", async () => {
  const { opts, request, cleanup } = testSetup();
  try {
    const validIds = ["install-A", "install_B", "uuid-1234-5678", "a", "A".repeat(128)];
    for (const install_id of validIds) {
      const res = await handleIngestRequest(
        request({ source: "chatgpt", install_id, conversations: [] }),
        opts,
      );
      expect(res.status).toBe(200);
    }

    const invalidIds = [
      "",
      "   ",
      "install with space",
      "install/slash",
      "../traversal",
      "install\x00null",
      "a".repeat(129),
      12345,
      true,
      {},
      [],
    ];
    for (const install_id of invalidIds) {
      const res = await handleIngestRequest(
        request({ source: "chatgpt", install_id, conversations: [] }),
        opts,
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error).toMatch(/install_id/);
    }
  } finally {
    cleanup();
  }
});

test("migrates old source:[records] format on load without losing records", async () => {
  const { dir, opts, request, cleanup } = testSetup();
  try {
    const storePath = `${opts.indexPath}.capture-failures.json`;
    const oldRecords = [
      { source_id: "migrated-1", updated_at: "2026-06-01T00:00:00Z", attempts: 3, quarantined: true, retry_after: "2026-06-02T00:00:00Z" },
      { source_id: "migrated-2", updated_at: null, attempts: 3, quarantined: true },
    ];
    const { dirname } = await import("node:path");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dirname(storePath), { recursive: true });
    // Write legacy format file: source -> array of records
    writeFileSync(storePath, JSON.stringify({ chatgpt: oldRecords }), "utf8");

    // Load via captureFailureReports directly
    const directReports = captureFailureReports(opts.indexPath, "chatgpt");
    expect(directReports).toEqual(oldRecords);

    // Load via status endpoint without install_id
    const res = await handleIngestRequest(request({ source: "chatgpt", conversations: [] }), opts);
    expect(res.status).toBe(200);
    expect((await res.json()).capture_failures).toEqual(oldRecords);

    // New install can report without clobbering migrated records
    const newInstallRecord = { source_id: "new-install", updated_at: null, attempts: 3, quarantined: true };
    await handleIngestRequest(
      request({ source: "chatgpt", install_id: "install-new", conversations: [], capture_failures: [newInstallRecord] }),
      opts,
    );

    // New install gets only its record
    const resNew = await handleIngestRequest(
      request({ source: "chatgpt", install_id: "install-new", conversations: [] }),
      opts,
    );
    expect((await resNew.json()).capture_failures).toEqual([newInstallRecord]);

    // Aggregate query sees both migrated and new install records
    const resAgg = await handleIngestRequest(request({ source: "chatgpt", conversations: [] }), opts);
    const aggIds = (await resAgg.json()).capture_failures.map((f: any) => f.source_id).sort();
    expect(aggIds).toEqual(["migrated-1", "migrated-2", "new-install"]);
  } finally {
    cleanup();
  }
});

test("preserves future additive record fields such as retry_after and custom fields", async () => {
  const { opts, request, cleanup } = testSetup();
  try {
    const failureWithExtra = {
      source_id: "conv-extra",
      updated_at: "2026-06-05T12:00:00Z",
      attempts: 3,
      quarantined: true,
      retry_after: "2026-06-07T12:00:00Z",
      extra_field: "preserved_val",
    };

    const res = await handleIngestRequest(
      request({
        source: "chatgpt",
        install_id: "install-A",
        conversations: [],
        capture_failures: [failureWithExtra],
      }),
      opts,
    );
    expect(res.status).toBe(200);
    const returned = (await res.json()).capture_failures;
    expect(returned[0]).toMatchObject(failureWithExtra);

    // Unscoped aggregate query also preserves the fields
    const resAgg = await handleIngestRequest(request({ source: "chatgpt", conversations: [] }), opts);
    const aggReturned = (await resAgg.json()).capture_failures;
    expect(aggReturned[0]).toMatchObject(failureWithExtra);
  } finally {
    cleanup();
  }
});

test("install identifiers are dictionary keys even when named __proto__", () => {
  const { opts, cleanup } = testSetup();
  const failures = [{ source_id: "bad", attempts: 1, quarantined: false, updated_at: null }];
  try {
    expect(captureFailureReports(opts.indexPath, "chatgpt", failures, "__proto__")).toEqual(failures);
    expect(captureFailureReports(opts.indexPath, "chatgpt", undefined, "__proto__")).toEqual(failures);
  } finally { cleanup(); }
});
