type ChunkProvider={kind?:string;chunkChars?:number|null;maxChunks?:number|null};
export function documentChunkBudget(provider:ChunkProvider) {
 const chars=provider.chunkChars ?? (provider.kind==='ollama' ? 750 : provider.kind==='embeddinggemma' ? 1200 : 1500);
 return {chars,bytes:provider.kind==='embeddinggemma' ? 1200 : chars,maxChunks:provider.maxChunks ?? 16};
}
/** Storage chunks are independent vectors. Queries are never split or pooled. */
export function documentChunks(text:string,provider:ChunkProvider) {
  const budget=documentChunkBudget(provider),room=budget.chars,cap=budget.maxChunks;
  if(!Number.isInteger(room)||room<16||!Number.isInteger(cap)||cap<1||cap>16) throw new Error('invalid embedding chunk controls');
  const chunks:string[]=[];let start=0;
  while(start<text.length && chunks.length<cap) {
    let end=start,bytes=0;
    while(end<text.length) {
      const point=text.codePointAt(end)!,width=point>0xffff ? 2 : 1;
      const size=Buffer.byteLength(String.fromCodePoint(point));
      if(end-start+width>room || bytes+size>budget.bytes) break;
      bytes+=size;end+=width;
    }
    if(end<text.length) {
      const head=text.slice(start,end),boundary=[...head.matchAll(/\s+/g)].at(-1);
      if(boundary && boundary.index>=head.length*0.75) end=start+boundary.index+boundary[0].length;
    }
    chunks.push(text.slice(start,end));start=end;
  }
  return {chunks:chunks.length ? chunks : [''],truncated:start<text.length};
}
