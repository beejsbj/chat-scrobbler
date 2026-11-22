# Privacy and licence gate

This repo is public, so CI fails a PR that adds a personal path, email or identity, or that leaves the repo without a `LICENSE` (`.github/workflows/privacy.yml`, job `privacy-scan`, script `scripts/privacy/privacy-scan.mjs`).

| What it flags | How |
|---|---|
| a home directory path (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`) or a machine mount (`/mnt/<disk>`, `/Volumes/<disk>`) | built into the script; any name, placeholders such as `runner` or `username` excepted |
| any email address | built into the script; `noreply`, `example.*`, role aliases (`info@`, `hello@`), `git@` remotes excepted |
| the owner's own names, hostnames and usernames | the `PRIVACY_PATTERNS` Actions secret (one literal or `/regex/` per line), and on a developer machine `~/.config/privacy-scan/patterns` plus the local login and hostname |
| no `LICENSE` file at the root | always |

On a PR it scans the lines the PR adds; on a push to `main` and on manual runs it scans every tracked file. The script holds no personal identifier, because this repo is public: the list of what is private lives in the secret. Log output is masked (`/Users/p***`), because CI logs on a public repo are public.

A real exception (a container user, a fixture path) goes in `.github/privacy-allow.txt` with the narrowest rule, path and literal. The gate guards against accidents, not adversaries: a PR can edit the script or the allowlist, so review must catch that. It does not scan git history, images or binaries, and without the secret it knows only the structural rules. `test/no-host-paths.test.ts` is an older, narrower guard for the same mistake; it can go once this gate is required.
