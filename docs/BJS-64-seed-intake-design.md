# BJS-64 Seed Intake Design

## Purpose

Design the first agent-ready flow for extracting possible seed work from
chat-scrobbler into Linear without bulk auto-creating issues.

The boundary is strict:

- chat-scrobbler is the neutral recall and provenance substrate.
- cockpit and Linear own workflow state, review state, duplicate decisions, and issue creation.
- The agent may propose candidate packets, but a human review decision gates every Linear write.
- No hidden backlog is stored in chat-scrobbler or in a sidecar file.

This note is research and design only. It does not create or update Linear records.

## Current Surfaces Confirmed

### CLI

`chat-scrobbler search <query>` searches the SQLite FTS index and returns message-level hits.

Fields returned by `--json`:

- `snippet`
- `session_id`
- `message_id`
- `role`
- `created_at`
- `source`
- `title`

Options:

- `--source <chatgpt|claude|gemini>`
- `--limit <n>`, default 20
- `--json`

`chat-scrobbler get <id>` fetches one canonical session.

Options:

- `--format json|markdown`, default json
- `--markdown`
- `--role <roles>`, comma-separated `user`, `assistant`, `system`, `tool`
- `--text-only`

Important behavior:

- `--role` filters the active conversation path, not the whole branch tree.
- `--text-only` strips reasoning and tool blocks after role filtering.
- Search indexes every message across branches, including edited-away branches.
- Markdown rendering uses the active path.

`chat-scrobbler list` browses session summaries.

Fields returned by `--json`:

- `id`
- `source`
- `title`
- `created_at`
- `updated_at`
- `message_count`

Options:

- `--source <chatgpt|claude|gemini>`
- `--title <substr>`
- `--limit <n>`, default 50
- `--json`

### MCP

The read-only MCP server exposes:

- `search(query, source?, limit?)`
- `get_session(id, format?)`
- `list_sessions(source?, titleContains?, limit?)`

The MCP `search` and `list_sessions` surfaces match the same core fields as the CLI.
The MCP `get_session` currently supports only full JSON or markdown. It does not expose
the CLI-only `--role` or `--text-only` narrowing. For seed intake, agents should prefer
CLI full JSON when running locally, then fetch role-filtered markdown only for readable
excerpts. This preserves branch `message_id` hits before narrowing output. When CLI
access is unavailable, fall back to MCP full JSON. Avoid MCP markdown for branch hits
because markdown rendering uses the active path and may miss messages found by search.

## Search Sample

Scope used for this note followed the issue limit:

- At most five searches.
- Limit 10 results each.
- Queries: `seed`, `"Linear issue"`, `"turn this into an issue"`, `"project idea"`, `backlog`.
- Stopped after finding plausible seed-like sessions.
- Fetched full JSON first to preserve branch `message_id` values, then fetched user-only
  markdown for readable excerpts.

Plausible sampled sessions:

| Session | Why it is seed-like | Linear duplicate signal |
| --- | --- | --- |
| `chatgpt:6a1c8a74-eb4c-83ea-9f7f-600b9395f7f6` | User explicitly called the Readwise/SuperMemo thought an idea seed and asked to put it in Linear. | Existing project `Readwise/SuperMemo Clone`, existing issue `BJS-13`, and adjacent digest issue `BJS-14`. |
| `chatgpt:6a31f3d3-c43c-83e8-a5f6-eecee32a7647` | User wanted NotebookLM podcast clusters to clear a reading backlog, plus direct-read shortlist routing. | Existing project `digest`, issues `BJS-14`, `BJS-47`, and `BJS-72`. |
| `chatgpt:6a3340c5-3574-83ea-837b-cb1ec3e1892a` | User asked how issues build up from inspiration, implementation discoveries, and loose ideas. | Existing cockpit/life-admin issues cover issue/session workflow, including `BJS-26`, `BJS-28`, `BJS-53`, and this `BJS-64`. |
| `claude:8bd8e79c-3d3b-45c8-be60-cad34ff2164f` | User described a personal-site architecture seed with experiments, project detail pages, and modular additions. | Existing project `personal-site`. A new issue may be valid only after checking exact title overlap. |
| `claude:1c78707b-882a-4693-8739-ae759a4ca6d0` | User explored a long-burn musical adaptation project. | Existing project `wok-musical` and issue `BJS-103`. Do not duplicate. |

The sample suggests the first valuable behavior is not "find uncaptured ideas." It is
"present one grounded candidate and decide whether it is new, already captured, or should
attach to an existing Linear home."

## SeedCandidate Shape

```ts
type SeedCandidate = {
  id: string;
  source: {
    sessionId: string;
    messageIds: string[];
    source: "chatgpt" | "claude" | "gemini";
    title: string | null;
    createdAt: string | null;
    fetchedWith: string;
  };
  extractedAt: string;
  searchScope: {
    queries: string[];
    maxSearches: number;
    maxResultsPerSearch: number;
    stoppedBecause:
      | "candidate_cap_reached"
      | "search_cap_reached"
      | "no_usable_examples"
      | "human_stopped";
  };
  title: string;
  kind: "project_seed" | "issue_seed" | "research_seed" | "workflow_seed" | "parked_seed";
  summary: string;
  evidence: Array<{
    messageId: string;
    role: "user" | "assistant" | "system" | "tool";
    excerpt: string;
  }>;
  boundaries: string[];
  suggestedLinear: {
    action: "create_issue" | "attach_to_existing" | "create_project" | "park" | "ignore";
    teamKey: string;
    projectName?: string;
    labels: string[];
    priority?: "none" | "low" | "medium" | "high" | "urgent";
    proposedTitle?: string;
    proposedBody?: string;
  };
  duplicateCheck: {
    status: "not_checked" | "checked";
    exactMatches: LinearReference[];
    nearMatches: LinearReference[];
    projectMatches: LinearReference[];
    recommendation: "safe_to_create" | "attach_instead" | "needs_human" | "duplicate";
    rationale: string;
  };
  confidence: "low" | "medium" | "high";
  riskFlags: Array<
    | "private_or_sensitive"
    | "copyright_heavy"
    | "too_vague"
    | "already_workflow_state"
    | "assistant_inferred"
  >;
};

type LinearReference = {
  type: "issue" | "project";
  id: string;
  title: string;
  url: string;
  projectName?: string;
  status?: string;
  labels?: string[];
};
```

Evidence should privilege user-authored text. Assistant text may explain context, but it
should be flagged as inferred unless the user clearly accepted or corrected it.

## SeedReviewDecision Shape

```ts
type SeedReviewDecision = {
  candidateId: string;
  reviewer: "human";
  decidedAt: string;
  decision:
    | "create_issue"
    | "attach_to_existing"
    | "merge_with_existing"
    | "create_project"
    | "park"
    | "ignore"
    | "needs_more_context";
  target?: LinearReference;
  editedTitle?: string;
  editedBody?: string;
  labels?: string[];
  notes?: string;
  allowedWrites: Array<
    | "linear_create_issue"
    | "linear_update_issue"
    | "linear_create_project"
    | "linear_comment"
  >;
};
```

The decision object belongs to cockpit or the active agent session receipt, not
chat-scrobbler. If the decision results in a Linear write, Linear becomes the durable
state.

## Duplicate Detection Flow

Before suggesting create, the agent must check Linear.

1. Normalize the candidate title and key noun phrases.
   - Lowercase.
   - Strip punctuation.
   - Compare singular/plural and slash variants such as `Readwise/SuperMemo`.
   - Keep proper nouns intact as separate query terms.
2. Search Linear projects by the strongest project-shaped phrase.
   - Example: `Readwise SuperMemo`, `digest`, `personal site`, `wok musical`.
3. Search Linear issues by:
   - Candidate proposed title.
   - Two to four noun phrases from the user-authored seed.
   - Known labels when available, especially `type:seed`, `type:research`, `mode:hitl`.
4. Classify matches.
   - Exact duplicate: same object and same intended next action.
   - Near duplicate: same area but different unresolved slice.
   - Existing project home: create may still be valid as a child issue, but not as a new project.
   - No match: safe to offer create, still human gated.
5. Present duplicate evidence in the review packet.
   - Include issue or project id, title, project, status, labels, and URL.
   - Prefer "attach to existing" when a project already captures the seed.

Creation must be blocked when duplicate status is `not_checked`, unless the human
explicitly overrides it.

## Review UX

Recommended first UX: one candidate at a time with a small capped batch behind it.

Why:

- Seed intake is judgment-heavy and easy to over-create.
- One-at-a-time review keeps provenance and duplicate evidence visible.
- A capped batch lets the human stop without losing the search context.

Default batch:

- Search cap: 5 queries.
- Result cap: 10 per query.
- Candidate cap: 3 to 5 per run.
- Display one active candidate.
- Show compact queue count, for example `2 of 4`.

Candidate screen:

- Candidate title.
- Source session id, title, source, date.
- Two to four short user-authored evidence excerpts.
- Proposed Linear action.
- Duplicate panel.
- Proposed issue body or attach note.
- Buttons: Create issue, Attach to existing, Merge, Park, Ignore, Needs more context.

Review table is useful only after the one-at-a-time flow has proven reliable. A table is
good for comparing many candidates, but it encourages fast triage before the duplicate
check and provenance have been read. Bulk creation should stay unavailable.

## Candidate Packet Examples

### Example 1: Attach to existing Readwise/SuperMemo project

```json
{
  "id": "seed:chatgpt:6a1c8a74:readwise-supermemo",
  "source": {
    "sessionId": "chatgpt:6a1c8a74-eb4c-83ea-9f7f-600b9395f7f6",
    "messageIds": ["bbb215a3-5355-4c6b-b61d-e9df352465b7"],
    "source": "chatgpt",
    "title": "Readwise Clone & Incremental Reading",
    "createdAt": "2026-06-16T14:43:36.873Z",
    "fetchedWith": "chat-scrobbler get <id> --format json, then chat-scrobbler get <id> --markdown --role user --text-only"
  },
  "extractedAt": "2026-06-30T00:00:00.000Z",
  "searchScope": {
    "queries": ["seed", "\"Linear issue\"", "\"turn this into an issue\"", "\"project idea\"", "backlog"],
    "maxSearches": 5,
    "maxResultsPerSearch": 10,
    "stoppedBecause": "candidate_cap_reached"
  },
  "title": "Readwise/SuperMemo recurrence seed",
  "kind": "project_seed",
  "summary": "A local-first resurfacing and incremental reading system focused on cognitive atoms, environmental shaping, and lock-screen style passive memory stimulation.",
  "evidence": [
    {
      "messageId": "bbb215a3-5355-4c6b-b61d-e9df352465b7",
      "role": "user",
      "excerpt": "User called the idea a seed and asked to put it in Linear so it would not keep floating in chats."
    }
  ],
  "boundaries": [
    "Do not create a new Linear issue for an already captured seed.",
    "Use chat-scrobbler only for provenance, not review state."
  ],
  "suggestedLinear": {
    "action": "attach_to_existing",
    "teamKey": "BJS",
    "projectName": "Readwise/SuperMemo Clone",
    "labels": ["type:seed", "mode:hitl"]
  },
  "duplicateCheck": {
    "status": "checked",
    "exactMatches": [
      {
        "type": "issue",
        "id": "BJS-13",
        "title": "Shape seed into MVP: returns, atoms, and widget loop",
        "url": "https://linear.app/bjs-projects/issue/BJS-13/shape-seed-into-mvp-returns-atoms-and-widget-loop",
        "projectName": "Readwise/SuperMemo Clone",
        "status": "Inbox",
        "labels": ["type:seed"]
      }
    ],
    "nearMatches": [],
    "projectMatches": [
      {
        "type": "project",
        "id": "65668fdd-4144-4ef6-bb99-2502c5b6c635",
        "title": "Readwise/SuperMemo Clone",
        "url": "https://linear.app/bjs-projects/project/readwisesupermemo-clone-96dba78408d0"
      }
    ],
    "recommendation": "attach_instead",
    "rationale": "The seed and first MVP shaping issue already exist."
  },
  "confidence": "high",
  "riskFlags": []
}
```

Example Linear body if a human chose to comment or attach rather than create:

```md
## Source

chat-scrobbler session: `chatgpt:6a1c8a74-eb4c-83ea-9f7f-600b9395f7f6`

## Added context

The user framed this as a seed for a Readwise/SuperMemo-inspired system: passive resurfacing, incremental reading, and cognitive atoms. The existing project and `BJS-13` already capture the main lane.

## Suggested action

No new issue. Attach this source session as provenance to the existing Readwise/SuperMemo project or `BJS-13`.
```

### Example 2: Attach NotebookLM podcast backlog work to digest

```json
{
  "id": "seed:chatgpt:6a31f3d3:notebooklm-podcast-backlog",
  "source": {
    "sessionId": "chatgpt:6a31f3d3-c43c-83e8-a5f6-eecee32a7647",
    "messageIds": ["bbb21a33-79d7-408b-af0e-eb438795dce1"],
    "source": "chatgpt",
    "title": "Readwise Document Access",
    "createdAt": "2026-06-17T01:14:18.866Z",
    "fetchedWith": "chat-scrobbler get <id> --format json, then chat-scrobbler get <id> --markdown --role user --text-only"
  },
  "extractedAt": "2026-06-30T00:00:00.000Z",
  "searchScope": {
    "queries": ["seed", "\"Linear issue\"", "\"turn this into an issue\"", "\"project idea\"", "backlog"],
    "maxSearches": 5,
    "maxResultsPerSearch": 10,
    "stoppedBecause": "candidate_cap_reached"
  },
  "title": "NotebookLM-style backlog clusters",
  "kind": "research_seed",
  "summary": "Cluster saved reading backlog into notebooks or audio-overview batches, while separating items that should stay on a direct-read shortlist.",
  "evidence": [
    {
      "messageId": "bbb21a33-79d7-408b-af0e-eb438795dce1",
      "role": "user",
      "excerpt": "User wanted clusters for NotebookLM podcasts to clear backlog, with direct-read items singled out separately."
    }
  ],
  "boundaries": [
    "Keep backlog clustering under digest unless review finds a stronger home.",
    "Do not ingest the whole reading backlog before selection rules are named."
  ],
  "suggestedLinear": {
    "action": "attach_to_existing",
    "teamKey": "BJS",
    "projectName": "digest",
    "labels": ["type:research", "type:seed"]
  },
  "duplicateCheck": {
    "status": "checked",
    "exactMatches": [
      {
        "type": "issue",
        "id": "BJS-72",
        "title": "Shape Reader or NotebookLM-style saved-content pipeline",
        "url": "https://linear.app/bjs-projects/issue/BJS-72/shape-reader-or-notebooklm-style-saved-content-pipeline",
        "projectName": "digest",
        "status": "Inbox",
        "labels": ["mode:hitl", "type:seed"]
      }
    ],
    "nearMatches": [
      {
        "type": "issue",
        "id": "BJS-14",
        "title": "Research feed: generate audio digests from saved sources",
        "url": "https://linear.app/bjs-projects/issue/BJS-14/research-feed-generate-audio-digests-from-saved-sources",
        "projectName": "digest",
        "status": "Inbox",
        "labels": ["type:research", "type:seed"]
      }
    ],
    "projectMatches": [
      {
        "type": "project",
        "id": "5bccc248-2ded-4fbb-9523-08ef1f4b3acd",
        "title": "digest",
        "url": "https://linear.app/bjs-projects/project/digest-47ca75ff5c81"
      }
    ],
    "recommendation": "attach_instead",
    "rationale": "The digest project and saved-content pipeline issue already cover this seed."
  },
  "confidence": "high",
  "riskFlags": []
}
```

Example Linear body if a human wanted a new child issue after reading duplicates:

```md
## Goal

Define the first clustering pass for saved reading backlog so some sources become NotebookLM-style audio batches and others remain direct-read shortlist items.

## Source

chat-scrobbler session: `chatgpt:6a31f3d3-c43c-83e8-a5f6-eecee32a7647`

## Known constraints

- Adjacent to Readwise/SuperMemo recurrence work, but not the same project.
- Should live under `digest` unless review finds a stronger home.
- Do not ingest the whole reading backlog until the cluster size and selection rules are named.

## Done when

- Candidate input source is chosen.
- Cluster size guidance exists.
- Direct-read shortlist rule exists.
- The next implementation issue is either created or consciously parked.
```

### Example 3: New personal-site child issue only after duplicate check

```json
{
  "id": "seed:claude:8bd8e79c:personal-site-architecture",
  "source": {
    "sessionId": "claude:8bd8e79c-3d3b-45c8-be60-cad34ff2164f",
    "messageIds": ["019bb3ac-4fe2-77c5-b72f-0a1ae68c2b56"],
    "source": "claude",
    "title": "Redesigning a personal portfolio site architecture",
    "createdAt": "2026-01-12T19:26:12.983Z",
    "fetchedWith": "chat-scrobbler get <id> --format json, then chat-scrobbler get <id> --markdown --role user --text-only"
  },
  "extractedAt": "2026-06-30T00:00:00.000Z",
  "searchScope": {
    "queries": ["seed", "\"Linear issue\"", "\"turn this into an issue\"", "\"project idea\"", "backlog"],
    "maxSearches": 5,
    "maxResultsPerSearch": 10,
    "stoppedBecause": "candidate_cap_reached"
  },
  "title": "Shape personal-site architecture",
  "kind": "issue_seed",
  "summary": "Clarify whether the personal site should be one page or many, and how projects, experiments, skills, theme switching, and living-home-on-the-internet ideas fit together.",
  "evidence": [
    {
      "messageId": "019bb3ac-4fe2-77c5-b72f-0a1ae68c2b56",
      "role": "user",
      "excerpt": "User wanted a new personal-site architecture with project detail pages, experiments, modular additions, and a more alive home on the internet."
    }
  ],
  "boundaries": [
    "Create only a child issue under personal-site after duplicate review.",
    "Do not create a new project from this session alone."
  ],
  "suggestedLinear": {
    "action": "create_issue",
    "teamKey": "BJS",
    "projectName": "personal-site",
    "labels": ["type:seed", "mode:hitl"],
    "priority": "low",
    "proposedTitle": "Shape personal-site architecture"
  },
  "duplicateCheck": {
    "status": "checked",
    "exactMatches": [],
    "nearMatches": [],
    "projectMatches": [
      {
        "type": "project",
        "id": "4a6a1a52-3230-4acb-9be1-d1dbe2b41419",
        "title": "personal-site",
        "url": "https://linear.app/bjs-projects/project/personal-site-2a8d76027e28"
      }
    ],
    "recommendation": "needs_human",
    "rationale": "The project home exists. A child issue may be appropriate if no existing issue already covers architecture."
  },
  "confidence": "medium",
  "riskFlags": []
}
```

Example Linear issue body:

```md
## Goal

Shape the personal-site architecture before implementation: one-page vs multi-page, project detail pages, experiments, theme switching, and a modular way to add new skills or artifacts.

## Source

chat-scrobbler session: `claude:8bd8e79c-3d3b-45c8-be60-cad34ff2164f`

## Context

The seed is not just a portfolio refresh. The user described the site as a living internet home, with experiments, projects, skills, content they follow, and a unique layout.

## Done when

- The first navigation shape is chosen.
- The first content types are named.
- The theme-switching idea is either included in v1 or deferred.
- There is a small implementation slice ready for an agent.
```

## Stop Conditions

Search stop conditions:

- Stop after five focused searches.
- Stop after 3 to 5 plausible seed-like sessions.
- Stop if all five searches produce no usable examples.
- Stop immediately if results become sensitive, copyright-heavy, or mostly assistant-inferred.

Candidate stop conditions:

- Do not produce a candidate without at least one user-authored evidence point.
- Do not suggest creation until Linear duplicate check has run.
- Do not continue mining once the review queue is full.
- Do not store unresolved review state in chat-scrobbler.

Write stop conditions:

- Never create Linear issues in the research flow.
- In a future execution flow, create only after an explicit `SeedReviewDecision`.
- Do not bulk-create.
- Do not create a project from one chat unless the human explicitly chooses that path.

## Open Questions

- Should cockpit store transient review decisions as session receipts, local ephemeral state, or only as Linear comments after approval?
- Should chat-scrobbler MCP add role/text-only narrowing so remote agents can avoid fetching full sessions?
- What is the canonical label set for seed candidates: `type:seed`, `type:research`, `mode:hitl`, or a future `source:chat-scrobbler` label?
- Should duplicate detection search archived and duplicate issues by default? The safer default may be yes for detection, no for routing.
- Should candidate IDs be deterministic from `sessionId + messageIds + normalizedTitle`, or generated per review run?
- How much user-authored excerpt is acceptable in Linear bodies when sessions contain copyrighted or private source material?
