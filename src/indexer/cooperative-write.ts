import type {Database} from 'bun:sqlite';

/** SQLite's busy handler sleeps synchronously on Bun's request thread. Bulk
 * writers instead retry whole, rolled-back transactions after yielding. */
export async function cooperativeWrite<T>(db:Database,run:()=>T,signal?:AbortSignal):Promise<T> {
 for(;;) {
  signal?.throwIfAborted();
  const timeout=(db.query('PRAGMA busy_timeout').get() as {timeout:number}).timeout;
  db.run('PRAGMA busy_timeout=0');
  try {return run();}
  catch(error) {
   if(!String((error as {code?:unknown})?.code ?? '').startsWith('SQLITE_BUSY'))throw error;
  } finally {db.run(`PRAGMA busy_timeout=${timeout}`);}
  await Bun.sleep(5);
 }
}
