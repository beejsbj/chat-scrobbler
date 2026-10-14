import {test,expect} from 'bun:test';
import { classifyEmbeddingFailure, failureRetry } from '../src/indexer/embedding-failures';

test('timeouts and content errors are item failures, connection failures are distinct',()=> {
 expect(classifyEmbeddingFailure(new DOMException('body','TimeoutError'))).toEqual({kind:'timeout',reason:'request_timeout'});
 expect(classifyEmbeddingFailure(Object.assign(new Error('private'),{code:'ECONNREFUSED'}))).toEqual({kind:'connection',reason:'connection_unavailable'});
 expect(classifyEmbeddingFailure(new Error('private text'))).toEqual({kind:'item',reason:'item_error'});
});
test('exhausted item attempts yield a stable reason for the queue timer',()=> {
 expect(failureRetry('timeout',1,1000)).toEqual({state:'deferred',retry_at:121000,reason:'request_timeout'});
 expect(failureRetry('timeout',3,1000)).toEqual({state:'skipped',retry_at:0,reason:'retry_exhausted_request_timeout'});
 // A provider being offline must not permanently discard messages.
 expect(failureRetry('connection',20,1000).state).toBe('deferred');
});
