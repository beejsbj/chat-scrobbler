# Privacy and licence gate

This repo is public, so CI fails a PR that adds a personal path, email or identity, or that leaves the repo without a `LICENSE` (`.github/workflows/privacy.yml`, job `privacy-scan`, script `scripts/privacy/privacy-scan.mjs`).

| What it flags | How |
|---|---|
| a home directory path (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`) or a machine mount (`/mnt/<disk>`, `/Volumes/<disk>`) | built into the script; any name, placeholders such as `runner` or `username` excepted |
| any email address | built into the script; `noreply`, the `example.com/.org/.net` domains, the `.example`, `.invalid`, `.test`, `.local` and `.localhost` TLDs, role aliases (`info@`, `hello@`) and `git@` remotes excepted |
| the owner's own names, hostnames and usernames | the `PRIVACY_PATTERNS` Actions secret (one literal or `/regex/` per line), and on a developer machine `~/.config/privacy-scan/patterns` plus the local login and hostname |
| no `LICENSE` file at the root | always |

On a PR it scans the lines the PR adds; on a push to `main` and on manual runs it scans every tracked file. The script holds no personal identifier, because this repo is public: the list of what is private lives in the secret. Log output is masked (a name is cut to its first letter), because CI logs on a public repo are public.

A real exception (a container user, a fixture path) goes in `.github/privacy-allow.txt` with the narrowest rule, path and literal (the literal must equal the whole matched value). The gate guards against accidents, not adversaries: a PR can edit the script or the allowlist, and the workflow runs the PR's own copy of the script with the secret in its environment, so anyone who can push a branch here could read it: review must catch that, and the secret should hold names, not credentials. It does not scan git history, images or binaries, and without the secret it knows only the structural rules. `test/no-host-paths.test.ts` is an older, narrower guard for the same mistake; it can go once this gate is required.
