import {test,expect} from 'bun:test';
import {openIndex,indexSession,searchMessages} from '../src/indexer/sqlite';
import {activeVectorCacheStatus} from '../src/indexer/active-vector-cache';
import {putTextVector} from '../src/indexer/vector-store';
import {fixture} from './support/embedding-fixture';

test('session vector refresh can use indexes on both binary and retained JSON rows',()=> {
 const db=openIndex(':memory:');
 try {
  for(const [table,index] of [['message_vectors','message_vector_session'],['message_embeddings','legacy_vector_session']]) {
   const plan=db.query(`EXPLAIN QUERY PLAN SELECT * FROM ${table} INDEXED BY ${index} WHERE session_id=? AND provider_kind=? AND dimension=?`).all('chatgpt:test','test',2) as Array<{detail:string}>;
   expect(plan.map(p=>p.detail).join('\n')).toContain('session_id=?');
  }
 }finally{db.close();}
});

test('writing another model does not refresh the active matrix sessions',()=> {
 const db=openIndex(':memory:'),s=fixture(),p={kind:'test',model:'active',dimensions:2,embed:()=>[1,0]};
 try {
  indexSession(db,s,{embeddingProvider:p});searchMessages(db,'unmatched',{embeddingProvider:p});
  const before=activeVectorCacheStatus(db);
  putTextVector(db,{session_id:s.id,message_id:'m',provider_kind:'test',provider_model:'other',dimension:2,embedding:[0,1],text:'archived words',title:'T',role:'user',created_at:null,source:'chatgpt'});
  expect(searchMessages(db,'unmatched',{embeddingProvider:p})).toHaveLength(1);
  expect(activeVectorCacheStatus(db)).toEqual(before);
  putTextVector(db,{session_id:s.id,message_id:'m',provider_kind:'test',provider_model:'active',dimension:2,embedding:[0,1],text:'archived words',title:'T',role:'user',created_at:null,source:'chatgpt'});
  expect(searchMessages(db,'unmatched',{embeddingProvider:p})).toHaveLength(0);
  expect(activeVectorCacheStatus(db)?.session_refreshes).toBe(1);
 }finally{db.close();}
});

test('one vector write refreshes only that message, keeping other session vectors cached',()=> {
 const db=openIndex(':memory:'),s=fixture(),p={kind:'test',model:'message-refresh',dimensions:2,embed:()=>[1,0]};
 try {
  s.messages.push({...s.messages[0],id:'second',text:'second words'});indexSession(db,s,{embeddingProvider:p});
  searchMessages(db,'unmatched',{embeddingProvider:p});
  const before=activeVectorCacheStatus(db)!;
  putTextVector(db,{session_id:s.id,message_id:'m',provider_kind:p.kind,provider_model:p.model,dimension:2,embedding:[0,1],text:'archived words',title:'T',role:'user',created_at:null,source:'chatgpt'});
  expect(searchMessages(db,'unmatched',{embeddingProvider:p}).map(h=>h.message_id)).toEqual(['second']);
  expect(activeVectorCacheStatus(db)?.message_refreshes).toBe(before.message_refreshes+1);
 }finally{db.close();}
});

test('asset vector writes do not rebuild the unrelated text matrix',()=> {
 const db=openIndex(':memory:'),s=fixture(),p={kind:'test',model:'text',dimensions:2,embed:()=>[1,0]};
 try {
  indexSession(db,s,{embeddingProvider:p});searchMessages(db,'unmatched',{embeddingProvider:p});
  const before=activeVectorCacheStatus(db);
  db.run('INSERT INTO asset_vectors(sha256,provider_kind,provider_model,dimension,embedding) VALUES (?,?,?,?,?)',['a'.repeat(64),'test','other',2,new Uint8Array([0,0,128,63,0,0,0,0])]);
  expect(searchMessages(db,'unmatched',{embeddingProvider:p})).toHaveLength(1);
  expect(activeVectorCacheStatus(db)).toEqual(before);
 }finally{db.close();}
});
