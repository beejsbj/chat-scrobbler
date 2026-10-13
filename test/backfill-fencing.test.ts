import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBackfillLock } from "../src/indexer/backfill-lock";
import { embedBackfill } from "../src/indexer/embed-backfill";
import { embedAsset } from "../src/indexer/asset-embeddings";
import { migrateLegacyVectors } from "../src/indexer/vector-store";
import { openIndex, indexSession } from "../src/indexer/sqlite";
import { fixture } from "./support/embedding-fixture";

function setup() {
  const root=mkdtempSync(join(tmpdir(),"backfill-fence-")),index=join(root,"index.db");
  const db=openIndex(index);let clock=1000;
  const lease=acquireBackfillLock(index,{now:()=>clock})!;
  return {root,index,db,lease,expire:()=>{clock=61_000;}};
}
const provider={kind:"test",model:"m",dimensions:2,embed:async()=>[1,0]};

test("a fenced text holder retains prior commits, discards its in-flight result and stops dispatching", async () => {
  const {root,index,db,lease,expire}=setup();const replacement: {lease:ReturnType<typeof acquireBackfillLock>}={lease:null};let calls=0;
  try {
    const session=fixture();session.messages=Array.from({length:3},(_,i)=>({...session.messages[0],id:`m${i}`,text:`text ${i}`}));
    indexSession(db,session);
    await expect(embedBackfill(db,{provider:{...provider,embed:async()=>{
      if(++calls===2) {expire();replacement.lease=acquireBackfillLock(index,{now:()=>61_000})!;}
      return [1,0];
    }},assertLease:()=>lease.assertOwned(db),sleep:async()=>{}})).rejects.toThrow("backfill lease lost");
    expect(calls).toBe(2);
    expect(db.query("SELECT message_id FROM message_vectors").all()).toEqual([{message_id:"m0"}]);
    replacement.lease!.assertOwned(db);
  } finally {lease.release();replacement.lease?.release();db.close();rmSync(root,{recursive:true,force:true});}
});

test("an expired asset holder cannot commit a completed media inference", async () => {
  const {root,db,lease,expire}=setup();
  try {
    const session=fixture(),sha="a".repeat(64);
    session.messages[0].blocks=[{type:"attachment",kind:"image",filename:"fixture.png",pointer:"fixture",local_path:null,sha256:sha}];
    indexSession(db,session);
    await expect(embedAsset(db,sha,"/synthetic/image.png",{...provider,embedAsset:async()=>{expire();return [1,0];}},undefined,()=>lease.assertOwned(db)))
      .rejects.toThrow("backfill lease lost");
    expect(db.query("SELECT * FROM asset_vectors").all()).toHaveLength(0);
  } finally {lease.release();db.close();rmSync(root,{recursive:true,force:true});}
});

test("lease expiry before a migration batch commits rolls back vectors and its resume cursor", () => {
  const {root,db,lease,expire}=setup();let checks=0;
  try {
    db.run(`INSERT INTO message_embeddings(session_id,message_id,embedding,text,title,provider_kind,provider_model,dimension)
      VALUES ('chatgpt:test','m','[1,0]','synthetic','T','test','m',2)`);
    expect(()=>migrateLegacyVectors(db,{assertLease:()=>{
      if(++checks===2) expire();lease.assertOwned(db);
    }})).toThrow("backfill lease lost");
    expect(checks).toBe(2);
    expect(db.query("SELECT * FROM message_vectors").all()).toHaveLength(0);
    expect(db.query("SELECT * FROM vector_migration").all()).toHaveLength(0);
    expect(db.query("SELECT * FROM message_embeddings").all()).toHaveLength(1);
  } finally {lease.release();db.close();rmSync(root,{recursive:true,force:true});}
});
