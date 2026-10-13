import {test,expect} from 'bun:test';
import {openIndex,indexSession,searchMessagesReport} from '../src/indexer/sqlite';
import {warmSearchCaches,searchWarmupStatus} from '../src/indexer/search-warmup';
import {fixture} from './support/embedding-fixture';

test('queries get literal recall while background caches warm, then semantic recall',async()=> {
 const db=openIndex(':memory:');let queryCalls=0,yields=0;
 const p={kind:'test',model:'warm',dimensions:2,embed:(_s:string,c?:{kind:string})=>{if(c?.kind==='query')queryCalls++;return [1,0];}};
 try {
  indexSession(db,fixture(),{embeddingProvider:p});
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const warming=warmSearchCaches(db,p,{batchSize:1,yield:async()=>{yields++;await gate;}});
  const report=await searchMessagesReport(db,'archived',{embeddingProvider:p});
  expect(report).toMatchObject({semantic:'warming',hits:[{provenance:'literal',message_id:'m'}]});
  expect(queryCalls).toBe(0);
  release();await warming;
  expect(yields).toBeGreaterThan(0);
  expect(searchWarmupStatus(db).state).toBe('ready');
  expect(await searchMessagesReport(db,'unmatched',{embeddingProvider:p})).toMatchObject({semantic:'available',hits:[{provenance:'semantic',message_id:'m'}]});
 }finally{db.close();}
});

test('warmup yields across batches and includes captures made while warming',async()=> {
 const db=openIndex(':memory:'),p={kind:'test',model:'warm-edit',dimensions:null,embed:()=>[1,0]};
 try {
  const s=fixture();s.messages=Array.from({length:25},(_,i)=>({...s.messages[0],id:String(i)}));
  indexSession(db,s,{embeddingProvider:p});let yields=0;
  await warmSearchCaches(db,p,{batchSize:5,yield:async()=> {
   if(++yields===3){const newer=fixture('captured during warmup');newer.messages[0].id='new';indexSession(db,newer,{embeddingProvider:p});}
   await Bun.sleep(0);
  }});
  expect(yields).toBeGreaterThan(5);
  expect((await searchMessagesReport(db,'unmatched',{embeddingProvider:p})).hits.map(h=>h.message_id)).toEqual(['new']);
  expect((await searchMessagesReport(db,'during warmup')).hits.map(h=>h.message_id)).toEqual(['new']);
 }finally{db.close();}
});

test('initial lookup warmup covers existing dirty sessions without rescanning FTS per session',async()=> {
 const db=openIndex(':memory:');
 try {
  // Simulate an older executable writing before the lookup has ever been built.
  for(let i=0;i<50;i++) {
   db.run('INSERT INTO sessions(id,source) VALUES (?,?)',[`chatgpt:${i}`,'chatgpt']);
   db.run('INSERT INTO messages_fts(session_id,message_id,text,source) VALUES (?,?,?,?)',[`chatgpt:${i}`,'m',`old writer ${i}`,'chatgpt']);
  }
  let yields=0;
  await warmSearchCaches(db,null,{batchSize:10,yield:async()=>{yields++;await Bun.sleep(0);}});
  expect(yields).toBeLessThan(20);
  expect((await searchMessagesReport(db,'writer')).hits).toHaveLength(20);
 }finally{db.close();}
});
