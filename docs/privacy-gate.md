# Privacy and licence gate

This repo is public, so CI fails a PR that adds a personal path, email or identity, or that leaves the repo without a `LICENSE` (`.github/workflows/privacy.yml`, job `privacy-scan`, script `scripts/privacy/privacy-scan.mjs`).

| What it flags | How |
|---|---|
| a home directory path (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`) or a machine mount (`/mnt/<disk>`, `/Volumes/<disk>`) | built into the script; any name, placeholders such as `runner` or `username` excepted |
| a Tailscale machine name (`*.ts.net`) | built into the script |
| any email address | built into the script; `noreply`, the `example.com/.org/.net` domains, the `.example`, `.invalid`, `.test`, `.localhost` TLDs, and `git@` remotes excepted; a real public contact address (`info@`, `hello@`) goes in the allowlist |
| the owner's own names, hostnames and usernames | the `PRIVACY_PATTERNS` Actions secret (one literal or `/regex/` per line), and on a developer machine `~/.config/privacy-scan/patterns` plus the local login and hostname |
| no `LICENSE` file at the root | always (presence only; the content is not checked) |
| personal values in file names, commit authors and messages, and the PR description | the same rules, scanned in CI on pull requests |

On a PR it scans the lines each commit of the PR adds (a value added and then removed in a later commit is still found: the merge publishes both); on a push to `main` and on manual runs it scans every tracked file. The script holds no personal identifier, because this repo is public: the list of what is private lives in the secret. Log output is masked (a name is cut to its first letter), because CI logs on a public repo are public.

With the secret in place, set `PRIVACY_REQUIRE_PATTERNS: true` in the workflow so a missing list fails instead of noticing. Before adding the secret, run `node scripts/privacy/privacy-scan.mjs tree` locally with the list in `~/.config/privacy-scan/patterns` and clean what it finds: the first CI scan after the secret exists prints, in a public log kept about 90 days, which files hold private words. A real exception (a container user, a fixture path) goes in `.github/privacy-allow.txt` with the narrowest rule, path and literal (the literal must equal the whole matched value). The gate guards against accidents, not adversaries: a PR can edit the script or the allowlist, and the workflow runs the PR's own copy of the script with the secret in its environment, so anyone who can push a branch here could read it: review must catch that, and the secret should hold names, not credentials. It does not scan git history (removing a leak does not purge it from history or forks), images or binaries, and without the secret it knows only the structural rules. `test/no-host-paths.test.ts` is an older, narrower guard for the same mistake; it can go once this gate is required.
