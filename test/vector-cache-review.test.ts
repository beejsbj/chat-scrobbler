import { test, expect } from "bun:test";
import { indexSession, openIndex, searchMessages, deleteIndexedSession } from "../src/indexer/sqlite";
import { fixture } from "./support/embedding-fixture";
test("warm semantic search observes incremental writes, edits, deletions and model switches",()=> {
  const db=openIndex(":memory:");
  const a={kind:"test",model:"a",dimensions:2,embed:()=>[1,0]};
  const b={...a,model:"b",embed:()=>[0,1]};
  try {
    indexSession(db,fixture(),{embeddingProvider:a});
    expect(searchMessages(db,"unmatched",{embeddingProvider:a})).toHaveLength(1);
    indexSession(db,fixture("changed"),{embeddingProvider:b});
    expect(searchMessages(db,"unmatched",{embeddingProvider:a})).toEqual([]);
    expect(searchMessages(db,"unmatched",{embeddingProvider:b})).toHaveLength(1);
    const second=fixture("second");second.id="chatgpt:second";second.source_id="second";
    indexSession(db,second,{embeddingProvider:b});
    expect(searchMessages(db,"unmatched",{embeddingProvider:b})).toHaveLength(2);
    deleteIndexedSession(db,"chatgpt","test");
    expect(searchMessages(db,"unmatched",{embeddingProvider:b}).map(h=>h.session_id)).toEqual(["chatgpt:second"]);
  } finally {db.close();}
});
