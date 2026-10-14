import {test,expect} from "bun:test";
import {openIndex,indexSession,indexSessionWithEmbeddings,searchMessages} from "../src/indexer/sqlite";
import {fixture} from "./support/embedding-fixture";
test("one failed message remains pending while successful session vectors survive and resume", async()=> {
  for(const mode of ["sync","async"]) {
    const db=openIndex(":memory:"),session=fixture("first");
    session.messages.push({...session.messages[0],id:"bad",text:"second"},{...session.messages[0],id:"last",text:"third"});
    let fail=true,calls:string[]=[];
    const p={kind:"test",model:"partial",dimensions:2,embed:(text:string)=>{calls.push(text);if(fail && text==="second")throw new Error("bad message");return [1,0];}};
    try {
      if(mode==="sync")indexSession(db,session,{embeddingProvider:p});
      else expect(await indexSessionWithEmbeddings(db,session,{embeddingProvider:p})).toBe("failed");
      expect(searchMessages(db,"unmatched",{embeddingProvider:p}).map(h=>h.message_id).sort()).toEqual(["last","m"]);
      fail=false;calls=[];
      await indexSessionWithEmbeddings(db,session,{embeddingProvider:p});
      expect(calls).toEqual(["second"]);
      expect(searchMessages(db,"unmatched",{embeddingProvider:p})).toHaveLength(3);
    } finally {db.close();}
  }
});
