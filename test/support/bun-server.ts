export function canBindBunServer(): boolean {
  try {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}
