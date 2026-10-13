import type { EmbeddingContext, EmbeddingProvider } from "./sqlite";
import { EmbeddingGemmaProvider } from "./embedding-providers";

interface Work {
  call: () => number[] | Promise<number[]>;
  context?: EmbeddingContext;
  resolve: (vector: number[]) => void;
  reject: (error: unknown) => void;
  cancelled: boolean;
  detach: () => void;
}

/** Serial in-process inference for Ollama/Gemini/hash: finish the active document
 * call, then serve queries first. Gemma's native queue prioritizes each HTTP chunk;
 * serializing its whole document call here would hold queries across all chunks.
 * A Proxy preserves provider identity/prototype checks and forwards contexts,
 * including native request observers, untouched to the original instance. */
export function queryPriorityProvider(provider: EmbeddingProvider): EmbeddingProvider {
  if(provider instanceof EmbeddingGemmaProvider) return provider;
  const queries: Work[]=[], documents: Work[]=[];
  let busy=false, scheduled=false;
  const schedule=()=> {
    if(busy || scheduled) return;
    scheduled=true;
    queueMicrotask(()=>{scheduled=false;void drain();});
  };
  async function drain() {
    if(busy) return;
    const work=queries.shift() ?? documents.shift();
    if(!work) return;
    if(work.cancelled) {schedule();return;}
    busy=true;work.detach();
    try {work.context?.signal?.throwIfAborted();work.resolve(await work.call());}
    catch(error) {work.reject(error);}
    finally {busy=false;schedule();}
  }
  const enqueue=(call:Work["call"],context?:EmbeddingContext)=>new Promise<number[]>((resolve,reject)=> {
    if(context?.signal?.aborted) {reject(context.signal.reason);return;}
    const work:Work={call,context,resolve,reject,cancelled:false,detach:()=>{}};
    const abort=()=> {
      work.cancelled=true;work.detach();
      const queue=context?.kind==="query" ? queries:documents;
      const index=queue.indexOf(work);if(index>=0)queue.splice(index,1);
      reject(context?.signal?.reason);
    };
    work.detach=()=>context?.signal?.removeEventListener("abort",abort);
    context?.signal?.addEventListener("abort",abort,{once:true});
    (context?.kind==="query" ? queries:documents).push(work);schedule();
  });
  const embed:EmbeddingProvider["embed"]=(text,context)=>enqueue(()=>provider.embed(text,context),context);
  const embedAsset:EmbeddingProvider["embedAsset"]=provider.embedAsset
    ? (input,context)=>enqueue(()=>provider.embedAsset!(input,context),context) : undefined;
  return new Proxy(provider,{get(target,key,receiver) {
    if(key==="embed") return embed;
    if(key==="embedAsset") return embedAsset;
    return Reflect.get(target,key,receiver);
  }});
}
