export type EmbeddingFailureKind='timeout'|'connection'|'item';
export interface EmbeddingFailure {kind:EmbeddingFailureKind;reason:string;}
export class EmbeddingRequestError extends Error {
  constructor(readonly failure:EmbeddingFailure) {super(failure.reason);}
}
export function classifyEmbeddingFailure(error:unknown):EmbeddingFailure {
  if(error instanceof EmbeddingRequestError)return error.failure;
  for(let cause:any=error,depth=0;cause && depth<4;cause=cause.cause,depth++) {
    if(cause.name==='TimeoutError' || ['ETIMEDOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(cause.code))
      return {kind:'timeout',reason:'request_timeout'};
    if(['ECONNREFUSED','ECONNRESET','ENOTFOUND','EHOSTUNREACH','ENETUNREACH','EPIPE','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','ConnectionRefused','ConnectionClosed','SocketConnectionClosed'].includes(cause.code))
      return {kind:'connection',reason:'connection_unavailable'};
  }
  return {kind:'item',reason:'item_error'};
}
export function failureRetry(kind:EmbeddingFailureKind,attempts:number,now:number,reason=kind==='timeout' ? 'request_timeout' : kind==='connection' ? 'connection_unavailable' : 'item_error') {
  if(kind!=='connection' && !/^http_(5\d\d|429)$/.test(reason) && attempts>=3) return {state:'skipped' as const,retry_at:0,reason:`retry_exhausted_${reason}`};
  return {state:'deferred' as const,retry_at:now+Math.min(3_600_000,120_000*2**Math.min(5,attempts-1)),reason};
}
export interface ConnectionSequence {count:number;lastItem:string|null;}
export function recordFailure(sequence:ConnectionSequence,item:string,failure:EmbeddingFailure) {
  if(failure.kind!=='connection') {sequence.count=0;sequence.lastItem=null;return false;}
  if(sequence.lastItem!==item)sequence.count++;
  sequence.lastItem=item;return sequence.count>=2;
}
