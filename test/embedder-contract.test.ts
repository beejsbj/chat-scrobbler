import { test, expect } from "bun:test";
import { EmbeddingGemmaProvider } from "../src/indexer/embedding-providers";

test("Bun adapter and Python HTTP service agree on model, prefixes and chunked Unicode documents", async () => {
  const child=Bun.spawn(["python3","test/support/fake-embedder.py"],{stdout:"pipe",stderr:"pipe"});
  try {
    const reader=child.stdout.getReader();
    const {value}=await reader.read();
    if(!value) throw new Error("synthetic server did not start");
    const port=Number(new TextDecoder().decode(value).trim()); expect(port).toBeGreaterThan(0);
    reader.releaseLock();
    const provider=new EmbeddingGemmaProvider({baseUrl:`http://127.0.0.1:${port}`,model:"litert-community/embeddinggemma-2-740m-litert-lm"});
    const query=await provider.embed("find sourdough notes",{kind:"query"});
    const doc=await provider.embed("Bread notes. 漢🙂 \n\n".repeat(800),{kind:"document",title:"Recipes | text: archive"});
    expect(query).toHaveLength(768); expect(doc).toHaveLength(768);
    expect(doc[0]).toBe(1); expect(Math.hypot(...doc)).toBe(1);
    const health=await fetch(`${provider.baseUrl}/health`).then(res=>res.json()) as any;
    expect(health.model).toBe(provider.model); expect(health.loaded).toBe(true);
  } finally { child.kill("SIGTERM"); await child.exited; }
},15000);
