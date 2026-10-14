import {expect,test} from 'bun:test';
import {openIndex,indexSession,type EmbeddingProvider} from '../src/indexer/sqlite';
import {embedBackfill} from '../src/indexer/embed-backfill';
import {fixture} from './support/embedding-fixture';

const day=86_400_000;
const provider:EmbeddingProvider={kind:'test',model:'m',dimensions:2,embed:()=>[1,0]};
const timeout={...provider,embed:()=>{throw new DOMException('private','TimeoutError');}};
const pass=(db:ReturnType<typeof openIndex>,p:EmbeddingProvider,time:number,extra={})=>
 embedBackfill(db,{provider:p,wallNow:()=>time,limit:1,sleep:async()=>{},...extra});

test('skipped timeout work automatically recovers after a day without manual intervention',async()=> {
 const db=openIndex(':memory:');
 try {
  indexSession(db,fixture());
  for(const time of [1000,200000])await pass(db,timeout,time);
  expect(await pass(db,timeout,500000)).toMatchObject({retry_scheduled:1});
  expect(await pass(db,provider,500000+day-1)).toMatchObject({attempted:0,queue:{skipped:1}});
  expect(await pass(db,provider,500000+day)).toMatchObject({embedded:1,queue:{skipped:0},text:{embedded:1}});
 }finally{db.close();}
});

test('repeated retry cycles wait one, three, then seven days and survive unchanged recaptures',async()=> {
 const db=openIndex(':memory:');
 try {
  indexSession(db,fixture());
  let start=1000;
  for(const spacing of [day,3*day,7*day,7*day]) {
   for(const time of [start,start+120000,start+360000])
    expect(await pass(db,timeout,time)).toMatchObject({attempted:1});
   const exhausted=start+360000;
   indexSession(db,fixture()); // Repeated provider polls preserve cycle history.
   expect(await pass(db,provider,exhausted+spacing-1)).toMatchObject({attempted:0,queue:{skipped:1}});
   start=exhausted+spacing;
  }
  expect(await pass(db,provider,start)).toMatchObject({embedded:1,queue:{skipped:0}});
 }finally{db.close();}
});

 test('due skipped retries run behind fresh items, even when the retry is newer',async()=> {
 const db=openIndex(':memory:');
 try {
  const s=fixture();s.messages[0].created_at='2026-10-14';indexSession(db,s);
  for(const time of [1000,200000,500000])await pass(db,timeout,time);
  s.messages.push({...s.messages[0],id:'fresh',text:'fresh words',created_at:'2026-01-01'});indexSession(db,s);
  const seen:string[]=[];const healthy={...provider,embed:(text:string)=>{seen.push(text);return [1,0];}};
  expect(await pass(db,healthy,500000+day)).toMatchObject({embedded:1});
  expect(seen).toEqual(['fresh words']);
  expect(await pass(db,healthy,500000+day)).toMatchObject({embedded:1});
  expect(seen).toEqual(['fresh words','archived words']);
  const plan=db.query(`EXPLAIN QUERY PLAN SELECT * FROM embedding_pending WHERE provider_kind='test' AND provider_model='m'
   AND state IN ('pending','deferred') AND retry_at<=1 ORDER BY (retry_cycles>0),priority DESC,fts_rowid DESC LIMIT 25`).all() as Array<{detail:string}>;
  expect(plan.some(row=>row.detail.includes('embedding_pending_retry_lane'))).toBe(true);
  expect(plan.some(row=>row.detail.includes('TEMP B-TREE'))).toBe(false);
 }finally{db.close();}
});

test('older permanent skips get a durable timer once, while whitespace remains excluded',async()=> {
 const {initializePendingEmbeddings}=await import('../src/indexer/pending-embeddings');
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'old-skip-')),path=join(root,'index.db');let db=openIndex(path);
 try {
  const s=fixture();s.messages.push({...s.messages[0],id:'blank',text:' \n '});indexSession(db,s);
  await initializePendingEmbeddings(db,provider);
  db.run("UPDATE embedding_pending SET state='skipped',attempts=3,reason='retry_exhausted_request_timeout' WHERE message_id='m'");
  expect(await pass(db,provider,1000)).toMatchObject({attempted:0,queue:{skipped:2,empty:1}});
  db.close();db=openIndex(path);
  expect(await pass(db,provider,1000+day-1)).toMatchObject({attempted:0});
  expect(await pass(db,provider,1000+day)).toMatchObject({embedded:1,queue:{skipped:1,empty:1}});
  // A successful retry resets escalation for a later edit.
  indexSession(db,fixture('new input'));
  const start=1000+day;
  for(const time of [start,start+120000,start+360000])await pass(db,timeout,time);
  expect(await pass(db,provider,start+360000+day)).toMatchObject({embedded:1});
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('a lost lease rolls back manual retry markers before dispatch',async()=> {
 const {pendingCoverage}=await import('../src/indexer/pending-embeddings');
 const {BackfillLeaseLost}=await import('../src/indexer/backfill-lock');
 const db=openIndex(':memory:');let calls=0;
 try {
  indexSession(db,fixture());
  for(const time of [1000,200000,500000])await pass(db,timeout,time);
  await expect(pass(db,{...provider,embed:()=>{calls++;return [1,0];}},600000,{
   retrySkipped:true,assertLease:()=> {
    if(pendingCoverage(db,provider).pending)throw new BackfillLeaseLost();
   },
  })).rejects.toThrow('backfill lease lost');
  expect(calls).toBe(0);
  expect(pendingCoverage(db,provider)).toMatchObject({pending:0,skipped:1});
 }finally{db.close();}
});
