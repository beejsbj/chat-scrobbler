import {expect,test} from 'bun:test';
import {openIndex,indexSession} from '../src/indexer/sqlite';
import {initializePendingEmbeddings,pendingEmbeddingRows,pendingCoverage} from '../src/indexer/pending-embeddings';
import {fixture} from './support/embedding-fixture';
const provider={kind:'test',model:'m',dimensions:2,embed:()=>[1,0]};

test('rollback executable session writes are caught through durable change revisions',async()=> {
 const db=openIndex(':memory:');const s=fixture('before');indexSession(db,s,{embeddingProvider:provider});
 try {
  await initializePendingEmbeddings(db,provider);
  db.transaction(()=>{
   db.run('UPDATE sessions SET updated_at=? WHERE id=?',['2026-10-14',s.id]);
   db.run('DELETE FROM messages_fts WHERE session_id=?',[s.id]);
   db.run('INSERT INTO messages_fts(text,session_id,message_id,title,source) VALUES (?,?,?,?,?)',['rollback edit',s.id,'m',s.title,s.source]);
  })();
  await initializePendingEmbeddings(db,provider,{yield:()=>Bun.sleep(0)});
  expect(pendingEmbeddingRows(db,provider,25)[0]).toMatchObject({text:'rollback edit',state:'pending',attempts:0});
  db.run('DELETE FROM sessions WHERE id=?',[s.id]);db.run('DELETE FROM messages_fts WHERE session_id=?',[s.id]);
  await initializePendingEmbeddings(db,provider);
  expect(pendingCoverage(db,provider)).toMatchObject({total:0});
 }finally{db.close();}
});

test('catch-up stops at its starting revision despite captures arriving on every yield',async()=> {
 const db=openIndex(':memory:');const s=fixture('before');indexSession(db,s);let yields=0;
 try {
  await initializePendingEmbeddings(db,provider);
  db.run('UPDATE sessions SET updated_at=? WHERE id=?',['2026-10-14',s.id]);
  await initializePendingEmbeddings(db,provider,{yield:async()=>{
   if(++yields>10)throw new Error('catch-up chased subsequent captures');
   s.updated_at='2026-10-15';s.messages[0].text='capture '+yields;indexSession(db,s);await Bun.sleep(0);
  }});
  expect(yields).toBeLessThanOrEqual(10);
  expect(pendingEmbeddingRows(db,provider,1)[0].text).toBe('capture '+yields);
 }finally{db.close();}
});

test('large changed sessions reconcile and prune in yielding pages',async()=> {
 const db=openIndex(':memory:');const s=fixture();
 s.messages=Array.from({length:130},(_,i)=>({...s.messages[0],id:String(i).padStart(3,'0'),text:'stored '+i}));
 indexSession(db,s,{embeddingProvider:provider});let yields=0;
 try {
  await initializePendingEmbeddings(db,provider);
  db.transaction(()=>{
   db.run('UPDATE sessions SET updated_at=? WHERE id=?',['2026-10-14',s.id]);
   db.run("DELETE FROM messages_fts WHERE session_id=? AND message_id='000'",[s.id]);
  })();
  await initializePendingEmbeddings(db,provider,{yield:async()=>{yields++;await Bun.sleep(0);}});
  expect(yields).toBeGreaterThanOrEqual(2);
  expect(pendingCoverage(db,provider)).toMatchObject({total:129,embedded:129});
  expect(db.query("SELECT 1 FROM message_vectors WHERE message_id='000'").get()).toBeNull();
 }finally{db.close();}
});
