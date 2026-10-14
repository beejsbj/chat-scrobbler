// Copy-sized synthetic index only. Measures cooperative startup and dirty sessions.
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openIndex,searchMessagesReport} from '../src/indexer/sqlite';
import {encodeVector,putTextVector} from '../src/indexer/vector-store';
import {warmSearchCaches} from '../src/indexer/search-warmup';
import {activeVectorCacheStatus} from '../src/indexer/active-vector-cache';
const root=mkdtempSync(join(tmpdir(),'bjs548-round2-')),db=openIndex(join(root,'synthetic.db'));
const messages=35718,vectors=31143,dimension=768;
const vector=Array.from({length:dimension},(_,i)=>Math.sin(i+1)),blob=encodeVector(vector),json=JSON.stringify(vector);
const p={kind:'benchmark',model:'active',dimensions:dimension,embed:()=>vector};
const text='Synthetic archive content about a remembered project and its decisions. '.repeat(30);
const sid=(i:number)=>`chatgpt:${Math.floor(i/10)}`;
try {
 db.transaction(()=> {
  const session=db.prepare('INSERT INTO sessions(id,source,source_id,title,message_count) VALUES (?,\'chatgpt\',?,\'Benchmark\',10)');
  const fts=db.prepare('INSERT INTO messages_fts(text,message_id,session_id,role,source,title) VALUES (?,?,?,\'user\',\'chatgpt\',\'Benchmark\')');
  const binary=db.prepare('INSERT INTO message_vectors(session_id,message_id,embedding,text,title,provider_kind,provider_model,dimension) VALUES (?,?,?,?,\'Benchmark\',\'benchmark\',\'active\',?)');
  const legacy=db.prepare('INSERT INTO message_embeddings(session_id,message_id,embedding,text,title,provider_kind,provider_model,dimension) VALUES (?,?,?,?,\'Benchmark\',\'benchmark\',\'active\',?)');
  for(let i=0;i<messages;i++) {
   if(i%10===0)session.run(sid(i),String(Math.floor(i/10)));
   const body=`token${i} ${text}`,id=`m${i}`;fts.run(body,id,sid(i));
   if(i<vectors){binary.run(sid(i),id,blob,body,dimension);legacy.run(sid(i),id,json,body,dimension);}
  }
 })();
 let ticks=0,maxGap=0,last=performance.now();
 const interval=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;ticks++;},1);
 const started=performance.now(),warming=warmSearchCaches(db,p);
 const query=async(q='unmatched query')=> {
  const started=performance.now(),report=await searchMessagesReport(db,q,{embeddingProvider:p});
  return {ms:performance.now()-started,semantic:report.semantic,hits:report.hits.length};
 };
 const early=await query('token0');
 await warming;clearInterval(interval);
 const warmup=performance.now()-started;
 const warm=[];for(let i=0;i<5;i++)warm.push((await query()).ms);warm.sort((a,b)=>a-b);
 const refresh=[];
 for(const count of [5,30,300]) {
  db.transaction(()=>{for(let i=0;i<count;i++) {
   const n=i*10;putTextVector(db,{session_id:sid(n),message_id:`m${n}`,provider_kind:p.kind,provider_model:p.model,dimension,
    embedding:vector,text:`token${n} ${text}`,title:'Benchmark',role:'user',source:'chatgpt',created_at:null});
  }})();
  const before=activeVectorCacheStatus(db)!.session_refreshes,result=await query();
  refresh.push({dirty_sessions:count,search_ms:result.ms,refreshed_sessions:activeVectorCacheStatus(db)!.session_refreshes-before});
 }
 const before=activeVectorCacheStatus(db)!.session_refreshes;
 putTextVector(db,{session_id:sid(0),message_id:'m0',provider_kind:p.kind,provider_model:'other',dimension,embedding:vector,text:`token0 ${text}`,title:'Benchmark',role:'user',source:'chatgpt',created_at:null});
 const other=await query();
 const plans=['message_vectors','message_embeddings'].map(table=> {
  const binary=table==='message_vectors',index=binary ? 'message_vector_session' : 'legacy_vector_session';
  const rows=db.query(`EXPLAIN QUERY PLAN SELECT v.session_id,v.message_id,f.rowid FROM ${table} v INDEXED BY ${index}
    JOIN message_lookup k ON k.session_id=v.session_id AND k.message_id=v.message_id
    JOIN messages_fts f ON f.rowid=k.fts_rowid AND f.session_id=v.session_id AND f.message_id=v.message_id
    WHERE v.provider_kind=? AND ${binary ? 'v.provider_model' : "COALESCE(v.provider_model,'')"}=? AND v.dimension=? AND v.session_id=?`).all(p.kind,p.model,dimension,sid(0));
  return {table,plan:rows};
 });
 Bun.gc(true);
 console.log(JSON.stringify({messages,vectors,dimension,text_bytes:text.length*messages,warmup_ms:warmup,warmup_timer_ticks:ticks,max_timer_gap_ms:maxGap,
  early_query:early,warm_search_median_ms:warm[2],warm_search_max_ms:warm[4],refresh,other_model:{search_ms:other.ms,refreshed_sessions:activeVectorCacheStatus(db)!.session_refreshes-before},plans,rss_mib:process.memoryUsage().rss/1024**2}));
 if(early.semantic!=='warming' || early.hits!==1 || ticks<100 || warm[2]>=300 || refresh.some(row=>row.search_ms>=300 || row.refreshed_sessions!==row.dirty_sessions))throw new Error('round2 search performance regression');
}finally{db.close();rmSync(root,{recursive:true,force:true});}
