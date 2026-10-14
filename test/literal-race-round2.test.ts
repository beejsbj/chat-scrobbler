import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {indexSession,openIndex,searchMessages} from '../src/indexer/sqlite';
import {ensureMessageLookup} from '../src/indexer/message-lookup';
import {warmLiteralCache} from '../src/indexer/literal-cache';
import {fixture} from './support/embedding-fixture';

for(const mode of ['sync','background'] as const)test(`${mode} literal refresh does not mark unseen concurrent text as cached`,async()=> {
 const root=mkdtempSync(join(tmpdir(),'literal-race-')),path=join(root,'index.db');
 const writer=openIndex(path),reader=openIndex(path),query=reader.query.bind(reader);
 try {
  indexSession(writer,fixture('original'));ensureMessageLookup(reader);
  const newer=fixture('prefixneedleSuffix');newer.id='chatgpt:new';newer.source_id='new';
  let reads=0,committed=false;
  // Commit through a real second connection at the revision publication boundary.
  // All reads still execute against SQLite; no row/revision results are mocked.
  reader.query=((sql,...args)=> {
   const statement=query(sql,...args);
   if(sql!=='SELECT revision FROM search_revision WHERE id=1')return statement;
   return new Proxy(statement,{get(target,key) {
    if(key==='get')return (...params:unknown[])=> {
     const commit=()=>{indexSession(writer,newer);committed=true;};
     const boundary=++reads===2;
     if(boundary && mode==='sync')commit();
     const value=target.get(...params as any[]);
     if(boundary && mode==='background')commit();
     return value;
    };
    const value=Reflect.get(target,key);return typeof value==='function' ? value.bind(target):value;
   }});
  }) as typeof reader.query;
  if(mode==='sync')searchMessages(reader,'unmatched');
  else await warmLiteralCache(reader,{batchSize:64,yield:async()=>{}},()=>{});
  reader.query=query;
  expect(committed).toBe(true);
  expect(searchMessages(reader,'needle').map(hit=>hit.session_id)).toEqual(['chatgpt:new']);
  expect(searchMessages(reader,'needle').map(hit=>hit.session_id)).toEqual(['chatgpt:new']);
 }finally{reader.query=query;reader.close();writer.close();rmSync(root,{recursive:true,force:true});}
});
