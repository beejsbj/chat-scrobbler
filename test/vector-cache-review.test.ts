import { test, expect } from "bun:test";
import { indexSession, openIndex, searchMessages, deleteIndexedSession } from "../src/indexer/sqlite";
import { fixture } from "./support/embedding-fixture";
import { encodeVector } from "../src/indexer/vector-store";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
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
test("a rolled-back search transaction cannot leave uncommitted vectors or text cached",()=> {
  const db=openIndex(":memory:"),p={kind:"test",model:"rollback",dimensions:2,embed:()=>[1,0]};
  try {
    indexSession(db,fixture(),{embeddingProvider:p});
    searchMessages(db,"unmatched",{embeddingProvider:p});
    expect(()=>db.transaction(()=> {
      indexSession(db,fixture("rolled back"),{embeddingProvider:p});
      expect(searchMessages(db,"unmatched",{embeddingProvider:p})[0]?.snippet).toBe("rolled back");
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(searchMessages(db,"unmatched",{embeddingProvider:p})[0]?.snippet).toBe("archived words");
    expect(searchMessages(db,"rolled back")).toEqual([]);
  } finally {db.close();}
});
test("rolling back a vector update restores the prior semantic direction",()=> {
  const db=openIndex(":memory:"),p={kind:"test",model:"rollback-direction",dimensions:2,embed:()=>[1,0]};
  try {
    indexSession(db,fixture(),{embeddingProvider:p});
    expect(searchMessages(db,"unmatched",{embeddingProvider:p})).toHaveLength(1);
    expect(()=>db.transaction(()=> {
      db.run("UPDATE message_vectors SET embedding=?",[encodeVector([0,1])]);
      expect(searchMessages(db,"unmatched",{embeddingProvider:p})).toEqual([]);
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(searchMessages(db,"unmatched",{embeddingProvider:p})).toHaveLength(1);
  } finally {db.close();}
});
test("a warm reader catches a different connection deleting and replacing a message",()=> {
  const root=mkdtempSync(join(tmpdir(),"vector-reader-")),path=join(root,"synthetic.db");
  const writer=openIndex(path),reader=openIndex(path);
  const p={kind:"test",model:"external",dimensions:2,embed:()=>[1,0]};
  try {
    indexSession(writer,fixture(),{embeddingProvider:p});
    expect(searchMessages(reader,"unmatched",{embeddingProvider:p})).toHaveLength(1);
    const replacement=fixture("new content");replacement.id="chatgpt:replacement";replacement.source_id="replacement";
    const queryProvider={...p,embed:()=>{
      writer.transaction(()=>{deleteIndexedSession(writer,"chatgpt","test");indexSession(writer,replacement);})();
      return [1,0];
    }};
    expect(searchMessages(reader,"unmatched",{embeddingProvider:queryProvider})).toEqual([]);
    expect(searchMessages(reader,"new content")[0]?.session_id).toBe(replacement.id);
  } finally {reader.close();writer.close();rmSync(root,{recursive:true,force:true});}
});
