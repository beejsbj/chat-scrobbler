/** `rejected` is a permanent 4xx: the provider will not accept this input as sent. */
export type EmbeddingFailureKind='timeout'|'connection'|'item'|'rejected';
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
/** 4xx answers reject the input, except 408 and 429 which describe the moment. The reason carries the
 * status and the provider's error code (a short identifier, never its message or any input). */
export async function httpFailure(response:Response):Promise<EmbeddingFailure> {
  const status=response.status;
  if(status<400 || status>=500 || status===408 || status===429) {await response.body?.cancel();return {kind:'item',reason:`http_${status}`};}
  let code:unknown;
  try {code=((await response.json()) as {error?:{code?:unknown}}|null)?.error?.code;} catch {}
  return {kind:'rejected',reason:typeof code==='string' && /^[a-z][a-z0-9_]{0,39}$/.test(code) ? `rejected_${status}_${code}` : `rejected_${status}`};
}
export function failureRetry(kind:EmbeddingFailureKind,attempts:number,now:number,reason=kind==='timeout' ? 'request_timeout' : kind==='connection' ? 'connection_unavailable' : 'item_error') {
  if(kind==='rejected')return {state:'skipped' as const,retry_at:0,reason};
  if(kind!=='connection' && !/^http_(5\d\d|429)$/.test(reason) && attempts>=3) return {state:'skipped' as const,retry_at:0,reason:`retry_exhausted_${reason}`};
  return {state:'deferred' as const,retry_at:now+Math.min(3_600_000,120_000*2**Math.min(5,attempts-1)),reason};
}
export interface ConnectionSequence {count:number;lastItem:string|null;}
export function recordFailure(sequence:ConnectionSequence,item:string,failure:EmbeddingFailure) {
  if(failure.kind!=='connection') {sequence.count=0;sequence.lastItem=null;return false;}
  if(sequence.lastItem!==item)sequence.count++;
  sequence.lastItem=item;return sequence.count>=2;
}
