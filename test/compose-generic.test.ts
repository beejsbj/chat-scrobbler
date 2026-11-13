import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";

const read = (name: string) => readFileSync(join(import.meta.dir, "..", name), "utf8");
const parse = (text: string) => YAML.parse(text) as any;

/** The slice of Compose interpolation these files use: ${VAR}, ${VAR:-default}, ${VAR:?message}, nested defaults. */
function interpolate(text: string, env: Record<string, string>): string {
  const expand = (input: string): string => input.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::([-?])((?:[^${}]|\$\{[^}]*\})*))?\}/g, (_m, name, op, rest) => {
    const value = env[name];
    if (value) return value;
    if (op === "?") throw new Error(`${name}: ${rest}`);
    return op === "-" ? expand(rest) : "";
  });
  return expand(text);
}

// Values an operator whose data lives elsewhere sets in .env, taken from the existing deployment file.
const legacy = parse(read("docker-compose.bjslab.yml"));
const dataDir = (legacy.services.scrobbler.volumes[0] as string).split(":")[0];
const assetsDir = legacy.services.embedder.volumes[1].source as string;
const tokens = { MCP_AUTH_TOKEN: "m", INGEST_TOKEN: "i" };

test("the generic compose can express the existing deployment through env values alone", () => {
  const generic = parse(interpolate(read("docker-compose.yml"), { ...tokens, DATA_DIR: dataDir, ASSETS_DIR: assetsDir }));
  const existing = parse(interpolate(read("docker-compose.bjslab.yml"), tokens));
  expect(generic.services.embedder).toEqual(existing.services.embedder);
  expect(generic.services.scrobbler.volumes).toEqual(existing.services.scrobbler.volumes);
  expect(generic.services.scrobbler.build).toEqual(existing.services.scrobbler.build);
  expect(generic.services.scrobbler.depends_on).toEqual(existing.services.scrobbler.depends_on);
  expect(generic.services.scrobbler.networks).toEqual(existing.services.scrobbler.networks);
  expect(generic.services.scrobbler.restart).toBe(existing.services.scrobbler.restart);
  expect(generic.networks).toEqual(existing.networks);
  expect(Object.keys(generic.volumes)).toEqual(Object.keys(existing.volumes));
  for (const [key, value] of Object.entries(existing.services.scrobbler.environment)) {
    expect([key, generic.services.scrobbler.environment[key]]).toEqual([key, value]);
  }
  // Only the owner name is new, and it is empty (generic) unless set.
  expect(generic.services.scrobbler.environment.CHAT_SCROBBLER_OWNER_NAME).toBe("");
  // Neither file publishes ports; the ports overlay is separate.
  expect(generic.services.scrobbler.ports).toBeUndefined();
});

test("the generic compose runs on defaults: local data dir, derived asset mount, owner 999", () => {
  const plan = parse(interpolate(read("docker-compose.yml"), tokens));
  expect(plan.services.scrobbler.volumes).toEqual(["./data:/data"]);
  expect(plan.services.embedder.volumes[1].source).toBe("./data/canonical/assets");
  expect(plan.services.embedder.user).toBe("999:999");
  expect(plan.services.scrobbler.build.args).toEqual({ DATA_UID: 999, DATA_GID: 999 });
  expect(plan.services.embedder.build.args).toEqual({ DATA_UID: 999, DATA_GID: 999 });
});

test("the data owner and data directory come from one env value each", () => {
  const plan = parse(interpolate(read("docker-compose.yml"), { ...tokens, DATA_UID: "2000", DATA_GID: "2001", DATA_DIR: "/srv/scrobbler" }));
  expect(plan.services.embedder.user).toBe("2000:2001");
  expect(plan.services.embedder.build.args).toEqual({ DATA_UID: 2000, DATA_GID: 2001 });
  expect(plan.services.scrobbler.build.args).toEqual({ DATA_UID: 2000, DATA_GID: 2001 });
  expect(plan.services.scrobbler.volumes).toEqual(["/srv/scrobbler:/data"]);
  expect(plan.services.embedder.volumes[1].source).toBe("/srv/scrobbler/canonical/assets");
});

test("tokens come from .env and the compose refuses to start without them", () => {
  expect(() => interpolate(read("docker-compose.yml"), { INGEST_TOKEN: "i" })).toThrow("MCP_AUTH_TOKEN");
  expect(() => interpolate(read("docker-compose.yml"), { MCP_AUTH_TOKEN: "m" })).toThrow("INGEST_TOKEN");
});

test(".env.example documents every setting the compose reads and holds no secrets", () => {
  const example = read(".env.example");
  const compose = read("docker-compose.yml") + read("docker-compose.ports.yml");
  for (const name of ["MCP_AUTH_TOKEN", "INGEST_TOKEN", "DATA_DIR", "ASSETS_DIR", "DATA_UID", "DATA_GID", "BIND_ADDRESS", "INGEST_PORT", "MCP_PORT", "COMPOSE_FILE", "CHAT_SCROBBLER_OWNER_NAME"]) {
    expect(example).toContain(name);
  }
  for (const [, name] of compose.matchAll(/\$\{([A-Z_]+)/g)) {
    if (name.startsWith("CHAT_SCROBBLER_")) continue; // tuning knobs documented in the README
    expect(example).toContain(name);
  }
  expect(example).toMatch(/^MCP_AUTH_TOKEN=$/m);
  expect(example).toMatch(/^INGEST_TOKEN=$/m);
});

test("the ports overlay publishes loopback ports by default", () => {
  const ports = parse(interpolate(read("docker-compose.ports.yml"), {}));
  expect(ports.services.scrobbler.ports).toEqual(["127.0.0.1:4318:4318", "127.0.0.1:4319:4321"]);
});

test("the embedder overlay works with the generic compose too", () => {
  const overlay = parse(read("docker-compose.no-embedder.yml"));
  expect(overlay.services.embedder.profiles).toEqual(["embedder-disabled"]);
  expect(overlay.services.scrobbler.environment.CHAT_SCROBBLER_EMBED_PROVIDER).toBe("none");
});
