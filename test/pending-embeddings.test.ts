import {expect,test} from 'bun:test';
import {openIndex,indexSession} from '../src/indexer/sqlite';
import {initializePendingEmbeddings,pendingEmbeddingRows,pendingCoverage,completePendingEmbedding,deferPendingEmbedding} from '../src/indexer/pending-embeddings';
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

test('registration reads each input and publishes its marker under one writer reservation',async()=> {
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {spyOn}=await import('bun:test');
 const root=mkdtempSync(join(tmpdir(),'pending-race-')),path=join(root,'index.db');
 const db=openIndex(path),writer=openIndex(path);indexSession(db,fixture());writer.run('PRAGMA busy_timeout=0');
 const query=db.query.bind(db);let raced=false;
 const spy=spyOn(db,'query').mockImplementation(((sql:string)=>{
  const statement=query(sql);
  if(sql.includes('SELECT f.rowid,f.*,s.updated_at'))return new Proxy(statement,{get(target,key){
   if(key==='all')return (...args:any[])=>{
    const rows=target.all(...args);
    if(!raced){raced=true;try{indexSession(writer,fixture('changed during seed'));}catch(error){
      if(!String(error).includes('locked'))throw error;
    }}
    return rows;
   };
   const value=Reflect.get(target,key);return typeof value==='function' ? value.bind(target) : value;
  }});
  return statement;
 }) as typeof db.query);
 try {
  await initializePendingEmbeddings(db,p);
  const rows=pendingEmbeddingRows(db,p,1,Date.now());
  expect(raced).toBe(true);
  const {textVectorHash}=await import('../src/indexer/vector-store');
  expect(rows[0].input_hash).toBe(textVectorHash(rows[0].text));
 }finally{spy.mockRestore();writer.close();db.close();rmSync(root,{recursive:true,force:true});}
});

test('CLI work estimates use pending size metadata, including the chunk cap',async()=> {
 const {pendingWorkEstimate}=await import('../src/indexer/pending-embeddings');
 const db=openIndex(':memory:');
 try {
  indexSession(db,fixture('x'.repeat(6000)));await initializePendingEmbeddings(db,p);
  expect(pendingWorkEstimate(db,p)).toBe(4);
  indexSession(db,fixture('x'.repeat(60000)));
  expect(pendingWorkEstimate(db,p)).toBe(16);
 }finally{db.close();}
});

test('completion and deferral cannot change an identical recapture with a newer FTS rowid',async()=> {
 const db=openIndex(':memory:');
 try {
  const s=fixture();indexSession(db,s);
  const other=fixture('other');other.id='chatgpt:other';other.source_id='other';indexSession(db,other);
  await initializePendingEmbeddings(db,p);
  const old=pendingEmbeddingRows(db,p,25).find(row=>row.session_id===s.id)!;
  indexSession(db,s);
  const fresh=pendingEmbeddingRows(db,p,25).find(row=>row.session_id===s.id)!;
  expect(fresh.fts_rowid).not.toBe(old.fts_rowid);
  completePendingEmbedding(db,old,true);
  expect(pendingEmbeddingRows(db,p,25).find(row=>row.session_id===s.id)).toMatchObject({state:'pending',attempts:0});
  expect(deferPendingEmbedding(db,old,{kind:'timeout',reason:'request_timeout'},1000)).toBeNull();
  expect(deferPendingEmbedding(db,fresh,{kind:'timeout',reason:'request_timeout'},1000)).toMatchObject({state:'deferred',attempts:1});
  completePendingEmbedding(db,fresh,true);
  expect(db.query('SELECT state,truncated,reason FROM embedding_pending WHERE session_id=?').get(s.id))
   .toEqual({state:'complete',truncated:1,reason:'chunk_limit_truncated'});
 }finally{db.close();}
});

test('late failures cannot demote completed work or reopen permanently skipped work',async()=> {
 const db=openIndex(':memory:');
 try {
  indexSession(db,fixture());await initializePendingEmbeddings(db,p);
  const selected=pendingEmbeddingRows(db,p,1)[0];
  completePendingEmbedding(db,selected);
  expect(deferPendingEmbedding(db,selected,{kind:'timeout',reason:'request_timeout'},1000)).toBeNull();
  expect(pendingCoverage(db,p)).toMatchObject({embedded:1,deferred:0});
  db.run("UPDATE embedding_pending SET state='skipped',attempts=3,reason='retry_exhausted_request_timeout'");
  expect(deferPendingEmbedding(db,selected,{kind:'connection',reason:'connection_unavailable'},1000)).toBeNull();
  expect(db.query('SELECT state,attempts,reason FROM embedding_pending').get()).toEqual({state:'skipped',attempts:3,reason:'retry_exhausted_request_timeout'});
 }finally{db.close();}
});
