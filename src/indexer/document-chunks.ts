/** Storage chunks are independent vectors. Queries are never split or pooled. */
export function documentChunks(text:string,provider:{kind?:string;chunkChars?:number|null;maxChunks?:number|null}) {
  const room=provider.chunkChars ?? (provider.kind==='embeddinggemma' ? 1200 : 1500),cap=provider.maxChunks ?? 16;
  if(!Number.isInteger(room)||room<16||!Number.isInteger(cap)||cap<1||cap>16) throw new Error('invalid embedding chunk controls');
  const chunks:string[]=[];let start=0;
  while(start<text.length && chunks.length<cap) {
    let end=start,bytes=0;
    while(end<text.length) {
      const point=text.codePointAt(end)!,width=point>0xffff ? 2 : 1;
      const size=Buffer.byteLength(String.fromCodePoint(point));
      if(end-start+width>room || provider.kind==='embeddinggemma' && bytes+size>1200) break;
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
