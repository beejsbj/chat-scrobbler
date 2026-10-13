import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {openIndex,indexSession} from '../src/indexer/sqlite';
import {startHttpServer} from '../src/mcp/http';
import {fixture} from './support/embedding-fixture';

test('listening MCP answers literal searches before background warmup completes',async()=> {
 const root=mkdtempSync(join(tmpdir(),'mcp-warmup-')),path=join(root,'index.db');
 const db=openIndex(path),s=fixture();s.messages=Array.from({length:512},(_,i)=>({...s.messages[0],id:String(i)}));
 const provider={kind:'test',model:'http-warm',dimensions:2,embed:()=>[1,0]};indexSession(db,s,{embeddingProvider:provider});db.close();
 const server=await startHttpServer({port:0,indexPath:path,canonicalDir:root,embeddingProvider:provider,warmSearchCaches:true});
 const client=new Client({name:'warmup-test',version:'1'});
 try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  const result=await client.callTool({name:'search',arguments:{query:'archived',limit:1}});
  expect(result.structuredContent).toMatchObject({semantic:'warming',hits:[{message_id:expect.any(String),provenance:'literal'}]});
  let report=result.structuredContent as {semantic:string};
  for(let i=0;i<100 && report.semantic==='warming';i++) {
   await Bun.sleep(5);report=(await client.callTool({name:'search',arguments:{query:'unmatched'}})).structuredContent as {semantic:string};
  }
  expect(report.semantic).toBe('available');
 }finally {await client.close();await server.stop(true);rmSync(root,{recursive:true,force:true});}
});
