import {expect,test} from 'bun:test';
import {openIndex,indexSession} from '../src/indexer/sqlite';
import {embedBackfill} from '../src/indexer/embed-backfill';
import {pendingEmbeddingRows,pendingCoverage} from '../src/indexer/pending-embeddings';
import {fixture} from './support/embedding-fixture';
const p={kind:'ollama',model:'test',dimensions:2,embed:async()=>[1,0]};

test('backfill stores separate bounded chunks and a timeout does not starve healthy messages',async()=> {
 const db=openIndex(':memory:');const sent:string[]=[];
 try {
  const s=fixture('old healthy');s.messages.push({...s.messages[0],id:'long',text:'x'.repeat(6000),created_at:'2026-10-12'});
  s.messages.push({...s.messages[0],id:'bad',text:'timeout',created_at:'2026-10-13'});indexSession(db,s);
  const report=await embedBackfill(db,{provider:{...p,embed:async text=>{
   sent.push(text);if(text==='timeout')throw new DOMException('timeout','TimeoutError');return [1,0];
  }},limit:25,background:{cursor:0,scanLimit:1000},sleep:async()=>{}});
  expect(sent.map(text=>text.length)).toEqual([7,1500,1500,1500,1500,11]);
  expect(report).toMatchObject({embedded:2,deferred:1,failed:0,provider_outage:false,attempted:3});
  expect(db.query('SELECT * FROM message_vector_chunks').all()).toHaveLength(3);
  expect(pendingCoverage(db,p)).toMatchObject({embedded:2,deferred:1});
  expect(pendingEmbeddingRows(db,p,25)).toHaveLength(0);
 }finally{db.close();}
});
test('only consecutive connection failures on different items cause an outage',async()=> {
 const db=openIndex(':memory:');
 try {
  const s=fixture();s.messages.push({...s.messages[0],id:'second',text:'second'});indexSession(db,s);
  const report=await embedBackfill(db,{provider:{...p,embed:async()=>{throw Object.assign(new Error('private'),{code:'ECONNREFUSED'});}},
   limit:25,background:{cursor:0,scanLimit:1000},sleep:async()=>{}});
  expect(report).toMatchObject({deferred:2,failed:0,provider_outage:true,attempted:2});
 }finally{db.close();}
});
