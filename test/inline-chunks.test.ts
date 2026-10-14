import {expect,test} from 'bun:test';
import {indexSession,indexSessionWithEmbeddings,openIndex,searchMessages} from '../src/indexer/sqlite';
import {fixture} from './support/embedding-fixture';

for(const asyncMode of [false,true])test(`inline indexing chunks new inputs and preserves reusable chunk sets (async=${asyncMode})`,async()=> {
 const db=openIndex(':memory:'),s=fixture('l'.repeat(750)+'r'.repeat(750)),sent:number[]=[];
 const provider={kind:'ollama',model:'fixture',dimensions:2,embed:(text:string,ctx?:{kind:string})=>{
  if(ctx?.kind==='document')sent.push(text.length);return text.startsWith('l') ? [1,0] : [0,1];
 }};
 const index=async()=>asyncMode ? indexSessionWithEmbeddings(db,s,{embeddingProvider:provider}) : indexSession(db,s,{embeddingProvider:provider});
 try {
  await index();expect(sent).toEqual([750,750]);
  expect(db.query('SELECT chunk_index FROM message_vector_chunks').all()).toEqual([{chunk_index:1}]);
  const hit=searchMessages(db,'needle',{embeddingProvider:provider});
  expect(hit[0]).toMatchObject({message_id:'m',provenance:'semantic'});
  await index();expect(sent).toEqual([750,750]);
  expect(db.query('SELECT chunk_index FROM message_vector_chunks').all()).toEqual([{chunk_index:1}]);
 }finally{db.close();}
});
