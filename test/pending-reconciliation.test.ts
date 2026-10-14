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
