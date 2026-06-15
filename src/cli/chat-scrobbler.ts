// src/cli/chat-scrobbler.ts
// CLI entrypoint for the chat-scrobbler tool.
// Subcommands: search, get, list, unify, serve, backup, backups, restore
// Arg parsing: manual / node:util parseArgs (no extra packages).

import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config";
import {
  runSearch,
  runGet,
  runList,
  runUnifyCmd,
  runInit,
  runBackup,
  runBackups,
  runRestore,
  runConnect,
  startServe,
  printServeInfo,
} from "./commands";

const USAGE = `
chat-scrobbler -- your AI chat history, captured and queryable.

It scrobbles every conversation you have with ChatGPT, Claude, and Gemini into a
local store you own: one canonical JSON file per session (the source of truth),
indexed in SQLite FTS5 (a rebuildable view). The exact same search/get/list
surface is exposed over a read-only MCP server, so agents and MCP clients query
precisely what this CLI returns.

Mental model
  - A session id is "<source>:<source_id>", e.g. chatgpt:abc123, claude:cl-xyz.
  - Sources are: chatgpt | claude | gemini.
  - search spans every message in every branch, including edited and abandoned
    forks, not just the visible path.
  - Data lives in ~/.local/share/chat-scrobbler/ (override with CANONICAL_DIR);
    the SQLite index is a throwaway view rebuilt by 'unify'.

Recall workflow (the two steps an agent follows)
  1. chat-scrobbler search "<terms>" --json      # find candidate sessions
  2. chat-scrobbler get <source>:<source_id> --markdown   # read the full thread
  Pass --json to search/get/list for machine-readable output.

Usage: chat-scrobbler <command> [options]

Recall
  search <query>         Full-text search across all messages
    --source <s>           Filter to chatgpt|claude|gemini
    --limit <n>            Max results (default 20)
    --json                 Output raw JSON array

  get <id>               Fetch one session by id (e.g. claude:cl-xyz)
    --format json|markdown Output format (default json)
    --markdown             Shorthand for --format markdown
    --role <roles>         Keep only these turn roles along the conversation,
                           comma-separated: user,assistant,system,tool
                           (e.g. --role user = just your prompts)
    --text-only            Strip reasoning and tool blocks, keep only prose

  list                   List sessions (newest first)
    --source <s>           Filter by source
    --title <substr>       Filter by title substring
    --limit <n>            Max results (default 50)
    --json                 Output raw JSON array

Operate
  init                   Scaffold data dirs + a starter config file
    --config <path>        Where to write it (default ~/.config/chat-scrobbler/config.json)

  serve                  Start the ingest receiver + MCP HTTP connector (always-on capture)

  mcp                    Run the read-only MCP server over stdio (for Claude Desktop)

  connect                Print the MCP endpoint + how to wire it into clients

  unify                  Rebuild the SQLite index from canonical/

Backup
  backup                 Snapshot canonical/ (+ config) to every configured target
    --target <path>        Back up only to this one target
    --config <path>        Include a specific config file in the snapshot

  backups                List snapshots in the primary (first) backup target
    --target <path>        Use a different target
    --json                 Output raw JSON array

  restore <snapshot>     Restore a snapshot from the primary (first) backup target
    --target <path>        Restore from a different target
    --force                Overwrite a non-empty canonical dir

  --help                 Show this help

Docs: https://github.com/beejsbj/chat-scrobbler  (see ARCHITECTURE.md, ROADMAP.md)
`.trim();

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE + "\n");
    process.exit(0);
  }

  const [command, ...rest] = argv;
  const cfg = loadConfig();
  const write = (s: string) => process.stdout.write(s + "\n");

  try {
    switch (command) {
      case "search": {
        const { positionals, values } = parseArgs({
          args: rest,
          options: {
            source: { type: "string" },
            limit: { type: "string" },
            json: { type: "boolean", default: false },
          },
          allowPositionals: true,
          strict: false,
        });
        const query = positionals[0] ?? "";
        await runSearch({
          query,
          cfg,
          source: values.source as string | undefined,
          limit: values.limit ? Number(values.limit) : undefined,
          json: values.json as boolean | undefined,
          write,
        });
        break;
      }

      case "get": {
        const { positionals, values } = parseArgs({
          args: rest,
          options: {
            format: { type: "string" },
            markdown: { type: "boolean", default: false },
            role: { type: "string" },
            "text-only": { type: "boolean", default: false },
          },
          allowPositionals: true,
          strict: false,
        });
        const id = positionals[0];
        if (!id) {
          process.stderr.write("Error: get requires a session id\n");
          process.exit(1);
        }
        const fmt = values.markdown
          ? "markdown"
          : (values.format as "json" | "markdown" | undefined) ?? "json";
        const roles = values.role
          ? (values.role as string).split(",").map((r) => r.trim()).filter(Boolean)
          : undefined;
        const textOnly = values["text-only"] as boolean | undefined;
        await runGet({ id, cfg, format: fmt, roles, textOnly, write });
        break;
      }

      case "list": {
        const { values } = parseArgs({
          args: rest,
          options: {
            source: { type: "string" },
            title: { type: "string" },
            limit: { type: "string" },
            json: { type: "boolean", default: false },
          },
          strict: false,
        });
        await runList({
          cfg,
          source: values.source as string | undefined,
          titleContains: values.title as string | undefined,
          limit: values.limit ? Number(values.limit) : undefined,
          json: values.json as boolean | undefined,
          write,
        });
        break;
      }

      case "unify": {
        await runUnifyCmd({ cfg, write });
        break;
      }

      case "init": {
        const { values } = parseArgs({
          args: rest,
          options: { config: { type: "string" } },
          strict: false,
        });
        const configFilePath =
          (values.config as string | undefined) ??
          join(homedir(), ".config", "chat-scrobbler", "config.json");
        await runInit({ cfg, configFilePath, write });
        break;
      }

      case "serve": {
        const handles = await startServe(cfg);
        printServeInfo(cfg, handles);
        // Keep alive indefinitely until the process is terminated.
        await new Promise<void>(() => {});
        break;
      }

      case "mcp": {
        // Read-only MCP over stdio. Imported lazily so the common CLI paths do
        // not pull in the MCP SDK.
        const { buildServer } = await import("../mcp/server");
        const { StdioServerTransport } = await import(
          "@modelcontextprotocol/sdk/server/stdio.js"
        );
        const server = buildServer({ indexPath: cfg.indexPath, canonicalDir: cfg.canonicalDir });
        await server.connect(new StdioServerTransport());
        // connect() keeps the process alive on stdio.
        break;
      }

      case "connect": {
        runConnect({ cfg, write });
        break;
      }

      case "backup": {
        const { values } = parseArgs({
          args: rest,
          options: {
            target: { type: "string" },
            config: { type: "string" },
          },
          strict: false,
        });
        await runBackup({
          cfg,
          targetSpec: values.target as string | undefined,
          configPath: values.config as string | undefined,
          write,
        });
        break;
      }

      case "backups": {
        const { values } = parseArgs({
          args: rest,
          options: {
            target: { type: "string" },
            json: { type: "boolean", default: false },
          },
          strict: false,
        });
        await runBackups({
          cfg,
          targetSpec: values.target as string | undefined,
          json: values.json as boolean | undefined,
          write,
        });
        break;
      }

      case "restore": {
        const { positionals, values } = parseArgs({
          args: rest,
          options: {
            target: { type: "string" },
            force: { type: "boolean", default: false },
          },
          allowPositionals: true,
          strict: false,
        });
        const snapshot = positionals[0];
        if (!snapshot) {
          process.stderr.write("Error: restore requires a snapshot name (see: chat-scrobbler backups)\n");
          process.exit(1);
        }
        await runRestore({
          cfg,
          snapshot,
          targetSpec: values.target as string | undefined,
          force: values.force as boolean | undefined,
          write,
        });
        break;
      }

      default: {
        process.stderr.write(`Unknown command: "${command}"\n\n${USAGE}\n`);
        process.exit(2);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
