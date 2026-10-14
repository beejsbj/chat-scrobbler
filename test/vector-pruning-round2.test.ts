import {test,expect} from 'bun:test';
import {openIndex,indexSession} from '../src/indexer/sqlite';
import {fixture} from './support/embedding-fixture';

test('capture without inference deletes disappeared message vectors in every model set',()=> {
  const db=openIndex(':memory:');
  try {
    const session=fixture();session.messages.push({...session.messages[0],id:'gone',text:'removed words'});
    for(const model of ['a','b'])indexSession(db,session,{embeddingProvider:{kind:'test',model,dimensions:2,embed:()=>[1,0]}});
    db.run(`INSERT INTO message_embeddings(session_id,message_id,embedding,text,provider_kind,provider_model,dimension) VALUES (?,?,?,?,?,?,?)`,[session.id,'gone','[1,0]','removed words','ollama','old',2]);
    session.messages.pop();indexSession(db,session);
    expect(db.query('SELECT message_id,provider_model FROM message_vectors ORDER BY provider_model').all()).toEqual([{message_id:'m',provider_model:'a'},{message_id:'m',provider_model:'b'}]);
    expect(db.query('SELECT message_id FROM message_embeddings').all()).toEqual([]);
  }finally{db.close();}
});

test('a message that becomes empty loses vectors and its old pending marker',async()=> {
 const {initializePendingEmbeddings,pendingCoverage}=await import('../src/indexer/pending-embeddings');
 const db=openIndex(':memory:');const p={kind:'test',model:'m',dimensions:2,embed:()=>[1,0]};
 try {
  indexSession(db,fixture('old'),{embeddingProvider:p});await initializePendingEmbeddings(db,p);
  indexSession(db,fixture(''));
  expect(db.query('SELECT message_id FROM message_vectors').all()).toHaveLength(0);
  expect(pendingCoverage(db,p)).toMatchObject({total:0,embedded:0});
 }finally{db.close();}
});
