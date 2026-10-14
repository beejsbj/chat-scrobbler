import { test,expect } from 'bun:test';
import { documentChunks } from '../src/indexer/document-chunks';
import { loadConfig,DEFAULT_CONFIG } from '../src/config';
import { embeddingProviderFromConfig } from '../src/indexer/embedding-providers';

test('every provider gets bounded, word-aware chunks with a capped tail',()=> {
 for(const kind of ['ollama','embeddinggemma','gemini','hash']) {
  const result=documentChunks('notes '.repeat(6000),{kind});
  expect(result.chunks.length).toBe(16);expect(result.truncated).toBe(true);
  expect(result.chunks.every(chunk=>chunk.length<=1500)).toBe(true);
 }
 expect(documentChunks('brief',{kind:'ollama'})).toEqual({chunks:['brief'],truncated:false});
});
test('unicode chunks preserve code points and the Gemma native request byte budget',()=> {
 const text='🪷'.repeat(1200),result=documentChunks(text,{kind:'embeddinggemma',maxChunks:16});
 expect(result.chunks.join('')).toBe(text);
 expect(result.chunks.every(chunk=>Buffer.byteLength(chunk)<=1200 && !chunk.includes('\ufffd'))).toBe(true);
});
test('chunk controls are provider configurable through config and environment',()=> {
 const cfg=loadConfig({configPath:null,env:{CHAT_SCROBBLER_EMBED_PROVIDER:'ollama',CHAT_SCROBBLER_EMBED_CHUNK_CHARS:'500',CHAT_SCROBBLER_EMBED_MAX_CHUNKS:'4'}});
 const provider=embeddingProviderFromConfig(cfg)!;
 expect(documentChunks('x'.repeat(4000),provider)).toEqual({chunks:Array(4).fill('x'.repeat(500)),truncated:true});
 expect(DEFAULT_CONFIG.embeddingChunkChars).toBeNull();
});
