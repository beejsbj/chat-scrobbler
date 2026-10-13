import { test, expect } from "bun:test";
import { indexSession, openIndex, searchMessages } from "../src/indexer/sqlite";
import { fixture } from "./support/embedding-fixture";
test("an initial lookup rebuild cannot turn an obsolete mapping into a phantom hit",()=> {
  const db=openIndex(":memory:"),p={kind:"test",model:"rollback",dimensions:2,embed:()=>[1,0]};
  try {
    indexSession(db,fixture(),{embeddingProvider:p});
    db.run("DELETE FROM messages_fts");
    db.run("INSERT INTO messages_fts(rowid,text,message_id,session_id,role,source,title) VALUES (1,'archived words','new','chatgpt:test','user','chatgpt','T')");
    expect(searchMessages(db,"unmatched",{embeddingProvider:p})).toEqual([]);
  } finally {db.close();}
});
test("search catches up after a rollback binary replaces FTS without maintaining the lookup", () => {
  const db=openIndex(":memory:");
  const p={kind:"test",model:"rollback",dimensions:2,embed:()=>[1,0]};
  try {
    indexSession(db,fixture(),{embeddingProvider:p});
    expect(searchMessages(db,"unmatched",{embeddingProvider:p})).toHaveLength(1);
    // Old binaries replace sessions and FTS but know nothing about message_lookup.
    db.run("INSERT OR REPLACE INTO sessions SELECT * FROM sessions WHERE id='chatgpt:test'");
    db.run("DELETE FROM messages_fts");
    db.run("INSERT INTO messages_fts(rowid,text,message_id,session_id,role,source,title) VALUES (99,'archived words','m','chatgpt:test','user','chatgpt','T')");
    expect(searchMessages(db,"unmatched",{embeddingProvider:p})).toHaveLength(1);
  } finally {db.close();}
});
