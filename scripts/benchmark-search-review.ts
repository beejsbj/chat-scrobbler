// Synthetic copy-sized dataset. No archive content is read.
import { openIndex, searchMessages } from "../src/indexer/sqlite";
import { encodeVector } from "../src/indexer/vector-store";
const db = openIndex(":memory:");
const dimension = 768, messages = 35718, vectors = 31143;
const vector = Array.from({length: dimension}, (_, i) => Math.sin(i + 1));
const blob = encodeVector(vector), json = JSON.stringify(vector);
const provider = {kind:"benchmark",model:"synthetic",dimensions:dimension,embed:()=>vector};
const text = "Synthetic archive content about a remembered project and its decisions. ".repeat(30);
db.transaction(() => {
  db.run("INSERT INTO sessions VALUES ('chatgpt:bench','chatgpt','bench','Benchmark','2026-01-01','2026-01-02',?)",[messages]);
  const fts = db.prepare("INSERT INTO messages_fts(text,message_id,session_id,role,source,title) VALUES (?,?,'chatgpt:bench','user','chatgpt','Benchmark')");
  const legacy = db.prepare("INSERT INTO message_embeddings(session_id,message_id,embedding,text,title,provider_kind,provider_model,dimension) VALUES ('chatgpt:bench',?,?,?,'Benchmark','benchmark','synthetic',?)");
  const binary = db.prepare("INSERT INTO message_vectors(session_id,message_id,embedding,text,title,provider_kind,provider_model,dimension) VALUES ('chatgpt:bench',?,?,?,'Benchmark','benchmark','synthetic',?)");
  for(let i=0;i<messages;i++) {
    const body=`${i} ${text}`; const id=`m${i}`;
    const result=fts.run(body,id);
    db.run("INSERT INTO message_lookup VALUES ('chatgpt:bench',?,?)",[id,result.lastInsertRowid]);
    if(i<vectors){binary.run(id,blob,body,dimension);legacy.run(id,json,body,dimension);}
  }
})();
const time=(run:()=>unknown)=>{const start=performance.now();run();return performance.now()-start;};
const stage:Record<string,number>={};
stage.substring_sql_ms=time(()=>db.query("SELECT text FROM messages_fts WHERE instr(lower(text),'unmatched query')>0 LIMIT 20").all());
stage.binary_read_ms=time(()=>{for(const row of db.query("SELECT embedding FROM message_vectors").iterate()) void row;});
stage.validated_read_ms=time(()=>{for(const row of db.query(`SELECT v.embedding,f.text FROM message_vectors v JOIN message_lookup k ON k.session_id=v.session_id AND k.message_id=v.message_id JOIN messages_fts f ON f.rowid=k.fts_rowid WHERE v.text=f.text`).iterate()) void row;});
const cold=time(()=>searchMessages(db,"unmatched query",{embeddingProvider:provider}));
const warm=Array.from({length:5},()=>time(()=>searchMessages(db,"unmatched query",{embeddingProvider:provider}))).sort((a,b)=>a-b);
console.log(JSON.stringify({messages,vectors,dimension,text_bytes:text.length*messages,stages:stage,cold_ms:cold,warm_median_ms:warm[2],warm_max_ms:warm[4],rss_mib:process.memoryUsage().rss/1024**2}));
db.close();
if(process.argv.includes("--assert") && warm[2]>=300) throw new Error("copy-sized warm search exceeds 300ms");
