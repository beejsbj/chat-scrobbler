// Synthetic only. Compare the complete search scan with identical 768d data.
// Run in disposable compute, not alongside the model on a busy bjslab.
import { openIndex, indexSession, searchMessages } from "../src/indexer/sqlite";
import type { Session } from "../src/schema/types";
const size = 4096, dimension = 768;
const db = openIndex(":memory:");
const provider = { kind: "benchmark", model: "synthetic", dimensions: dimension, embed: () => vector };
let vector = Array.from({length:dimension},(_,i)=>Math.sin(i+1));
const norm = Math.hypot(...vector); vector=vector.map(value=>value/norm);
const session: Session = {id:"chatgpt:synthetic",source:"chatgpt",source_id:"synthetic",title:"Synthetic",capture_method:"api",created_at:"2026-01-01",updated_at:"2026-01-02",default_model:null,account:null,raw_ref:"synthetic",schema_version:1,
  messages:Array.from({length:size},(_,i)=>({id:`m${i}`,text:`Synthetic content ${i}`,blocks:[],role:"user",created_at:null,parent_id:null,model:null}))};
try {
  indexSession(db,session,{embeddingProvider:provider});
  db.run(`INSERT INTO message_embeddings(session_id,message_id,embedding,text,role,created_at,source,title,provider_kind,provider_model,dimension)
    SELECT session_id,message_id,?,text,role,created_at,source,title,provider_kind,provider_model,dimension FROM message_vectors`,[JSON.stringify(vector)]);
  const measure = () => { const times:number[]=[]; for(let i=0;i<3;i++){const start=performance.now(); searchMessages(db,"unmatched query",{embeddingProvider:provider});times.push(performance.now()-start);} return times.sort((a,b)=>a-b)[1]; };
  const bytes=(table:string)=>(db.query(`SELECT SUM(length(embedding)) AS bytes FROM ${table}`).get() as {bytes:number}).bytes;
  const binaryBytes=bytes("message_vectors"), jsonBytes=bytes("message_embeddings");
  const binaryMs=measure(); db.run("DELETE FROM message_vectors"); const jsonMs=measure();
  console.log(JSON.stringify({synthetic_messages:size,dimension,binary_bytes:binaryBytes,json_bytes:jsonBytes,binary_search_median_ms:binaryMs,json_search_median_ms:jsonMs}));
} finally {db.close();}
