import {expect,test} from 'bun:test';
import {openIndex,indexSession} from '../src/indexer/sqlite';
import {initializePendingEmbeddings,pendingEmbeddingRows,pendingCoverage,deferPendingEmbedding} from '../src/indexer/pending-embeddings';
import {fixture} from './support/embedding-fixture';
const p={kind:'test',model:'m',dimensions:2,embed:()=>[1,0]};

test('pending preparation yields once, reuses existing vectors, and newest messages win',async()=> {
 const db=openIndex(':memory:');let yields=0;
 try {
  indexSession(db,fixture(),{embeddingProvider:p});
  const s=fixture();s.messages.push({...s.messages[0],id:'new',created_at:'2026-10-13',text:'new notes'});indexSession(db,s);
  await initializePendingEmbeddings(db,p,{batchSize:1,yield:async()=>{yields++;}});
  expect(yields).toBeGreaterThan(0);
  expect(pendingCoverage(db,p)).toMatchObject({total:2,embedded:1,pending:1});
  expect(pendingEmbeddingRows(db,p,25,Date.now()).map(row=>row.message_id)).toEqual(['new']);
  const before=yields;
  await initializePendingEmbeddings(db,p,{yield:async()=>{yields++;}});expect(yields).toBe(before);
  const plan=db.query(`EXPLAIN QUERY PLAN SELECT * FROM embedding_pending WHERE provider_kind='test' AND provider_model='m'
    AND state IN ('pending','deferred') AND retry_at<=1 ORDER BY priority DESC LIMIT 25`).all() as Array<{detail:string}>;
  expect(plan.some(row=>row.detail.includes('embedding_pending_due'))).toBe(true);
 }finally{db.close();}
});
test('item deferrals survive runs, skip after three failures, and reset when captured text changes',async()=> {
 const db=openIndex(':memory:');
 try {
  indexSession(db,fixture());await initializePendingEmbeddings(db,p);
  const row=pendingEmbeddingRows(db,p,1,1000)[0];
  for(const now of [1000,200000,500000])deferPendingEmbedding(db,row,{kind:'timeout',reason:'request_timeout'},now);
  expect(pendingCoverage(db,p)).toMatchObject({skipped:1,pending:0,deferred:0});
  expect(pendingEmbeddingRows(db,p,1,999999)).toHaveLength(0);
  indexSession(db,fixture('changed'));
  expect(pendingEmbeddingRows(db,p,1,999999)[0]).toMatchObject({text:'changed',attempts:0,state:'pending'});
 }finally{db.close();}
});
