export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function assertTokenForExposedBind(opts: {
  bindHost: string;
  token?: string | null;
  envVarName: string;
  serviceName: string;
}): void {
  if (isLoopbackHost(opts.bindHost)) return;
  if (opts.token && opts.token.trim() !== "") return;
  throw new Error(`${opts.serviceName} bound to ${opts.bindHost} requires ${opts.envVarName}`);
}
