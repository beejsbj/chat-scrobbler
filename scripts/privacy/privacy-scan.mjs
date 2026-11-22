#!/usr/bin/env node
// Public-repo privacy gate: no personal paths, emails or identities in what a public repo
// publishes, and a licence file at its root.
//
//   node privacy-scan.mjs diff   scan the lines a PR adds (BASE_SHA...HEAD_SHA, default origin/main...HEAD)
//   node privacy-scan.mjs tree   scan every tracked file (push to the default branch, or by hand)
//   node privacy-scan.mjs text   scan stdin: a PR body, a commit log, a report you are about to post
//
// Where the list of personal identifiers lives (it must not be published by the repo that
// scans for it, so this file holds none):
//   1. structural rules, in this file: any /Users/<name> or /home/<name> path, a C:\Users\<name>
//      path, a /mnt/<disk> or /Volumes/<disk> mount, any email address. They name no one.
//   2. a private pattern list: the PRIVACY_PATTERNS environment variable (an Actions secret in
//      CI) or the file named by PRIVACY_PATTERNS_FILE (default ~/.config/privacy-scan/patterns).
//      One entry per line: a literal (matched case-insensitively, not inside a longer word) or
//      /regex/. Your real name, usernames, personal email, hostnames go here and nowhere else.
//   3. derived at run time, outside CI only: the OS username and home directory name (as a path
//      segment or ssh user) and the hostname.
//
// Output is redacted on purpose: CI logs on a public repo are public, so a finding names the
// file, line and rule and a masked excerpt, never the pattern or the value it matched.
//
// Environment: PRIVACY_REPO_PRIVATE=true skips the gate (a private repo may hold these);
// PRIVACY_REPO_OWNER (default GITHUB_REPOSITORY_OWNER) is the public login, never flagged.
//
// Exemptions go in .github/privacy-allow.txt: `<rule|*> <path-glob> [literal]` per line (the literal must equal the whole matched value).
// Like the PR gates this guards against accidents, not adversaries: a PR can edit it.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const ALLOW_FILE = '.github/privacy-allow.txt'
export const RULES = ['home-path', 'host-mount', 'email', 'private-list', 'derived', 'licence']

// ---------------------------------------------------------------------------
// Structural rules (name no one)
// ---------------------------------------------------------------------------

const PLACEHOLDER_NAMES = new Set([
  'user', 'username', 'you', 'yourname', 'your-name', 'your_name', 'your-username', 'your_username', 'yourusername',
  'name', 'me', 'someone', 'foo', 'bar', 'example', 'test', 'tester', 'dev', 'developer', 'john', 'jane', 'alice', 'bob',
  'node', 'app', 'appuser', 'runner', 'runneradmin', 'ubuntu', 'vscode', 'root', 'builder', 'build', 'git', 'docker',
  'www-data', 'circleci', 'jenkins', 'github', 'codespace', 'gitpod', 'public', 'default', 'shared', 'all',
])
const GENERIC_MOUNTS = new Set([
  'data', 'shared', 'share', 'host', 'disk', 'disks', 'cdrom', 'usb', 'volume', 'volumes', 'storage', 'workspace',
  'work', 'home', 'tmp', 'src', 'app', 'code', 'repo', 'project', 'wsl', 'wslg', 'macintosh', 'cache', 'mount',
])
// Never a person: robots and documentation placeholders. Role addresses (info@, hello@) are NOT here: the domain may
// be personal, so a real public contact address goes in the allowlist.
const ROLE_ADDRESSES = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'git', 'you', 'user', 'username', 'name', 'email', 'your-email',
  'youremail', 'yourname', 'me', 'someone', 'foo', 'bar', 'test', 'john', 'jane', 'john.doe', 'jane.doe', 'jdoe',
])
const FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'css', 'js', 'mjs', 'cjs', 'ts', 'json', 'html', 'woff', 'woff2'])
const SAFE_DOMAIN = /(^|\.)(example\.(com|org|net)|users\.noreply\.github\.com|noreply\.github\.com)$|\.(invalid|test|example|localhost)$/i

// A name must end at a non-name character and not at `*`, so the masked form we print (first letter, then stars) is itself safe to quote.
// Home directories, with the prefixes real machines add: WSL (/mnt/c), Git Bash (/c), Fedora Atomic (/var/home), FreeBSD (/usr/home), macOS data volume.
const HOME_PATH = /(?<![A-Za-z0-9_])(?:\/mnt\/[a-z]|\/[a-z]|\/var|\/usr|\/System\/Volumes\/Data)?\/(?:Users|home)\/([A-Za-z0-9._-]+)(?![A-Za-z0-9._*-])/g
// Windows drive paths, any case, and VS Code's file:///c%3A/ form.
const WINDOWS_HOME = /(?<![A-Za-z0-9_])[A-Za-z](?::|%3A)[\\/]{1,2}Users[\\/]{1,2}([A-Za-z0-9._-]+)(?![A-Za-z0-9._*-])/gi
const HOST_MOUNT = /(?<![A-Za-z0-9_])\/(?:mnt|Volumes)\/([A-Za-z0-9._-]{3,})(?![A-Za-z0-9._*-])/g
const EMAIL = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g

/** Structural hits in a line, and in the line after URL-decoding it (a %2F or %40 hides a path or address). */
function structuralHits(line) {
  const hits = structuralHitsOnce(line)
  if (line.includes('%')) {
    let decoded = null
    try { decoded = decodeURIComponent(line) } catch { /* not valid encoding */ }
    if (decoded && decoded !== line) {
      const seen = new Set(hits.map(h => h.key))
      for (const hit of structuralHitsOnce(decoded)) if (!seen.has(hit.key)) { seen.add(hit.key); hits.push(hit) }
    }
  }
  return hits
}

function structuralHitsOnce(line) {
  const hits = []
  for (const [re, rule] of [[HOME_PATH, 'home-path'], [WINDOWS_HOME, 'home-path']]) {
    for (const m of line.matchAll(re)) {
      const name = m[1].toLowerCase()
      if (PLACEHOLDER_NAMES.has(name) || /^\.+$/.test(name)) continue
      hits.push({ rule, key: `${rule}:${name}`, match: m[0], shown: m[0].slice(0, m[0].length - m[1].length) + mask(m[1]) })
    }
  }
  for (const m of line.matchAll(HOST_MOUNT)) {
    if (GENERIC_MOUNTS.has(m[1].toLowerCase())) continue
    hits.push({ rule: 'host-mount', key: `host-mount:${m[1].toLowerCase()}`, match: m[0], shown: m[0].slice(0, m[0].length - m[1].length) + mask(m[1]) })
  }
  for (const m of line.matchAll(EMAIL)) {
    const local = m[1].toLowerCase()
    const domain = m[2].toLowerCase()
    if (ROLE_ADDRESSES.has(local) || SAFE_DOMAIN.test(domain)) continue
    if (FILE_EXTENSIONS.has(domain.split('.').pop())) continue
    hits.push({ rule: 'email', key: `email:${m[0].toLowerCase()}`, match: m[0], shown: `${mask(m[1])}@***.${m[2].split('.').pop()}` })
  }
  return hits
}

/** First character and a mark: enough to find it, not enough to publish it. */
const escapeData = text => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const escapeProp = text => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C')
const mask = text => `${text[0]}***`

// ---------------------------------------------------------------------------
// Private and derived patterns (the only place identities appear, and never in the repo)
// ---------------------------------------------------------------------------

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Parse a pattern list. Throws with the entry's number, never its text, when a regex is invalid. */
export function parsePatterns(text) {
  const entries = []
  let n = 0
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    n += 1
    const regex = line.match(/^\/(.+)\/$/)
    try {
      const re = regex ? new RegExp(regex[1], 'gi') : new RegExp(`(?<![A-Za-z0-9])${escapeRe(line)}(?![A-Za-z0-9])`, 'gi')
      entries.push({ re, label: 'private pattern' })
    } catch {
      throw new Error(`private pattern #${n} is not a valid regular expression`)
    }
  }
  return entries
}

const GENERIC_IDENTITIES = new Set([
  'admin', 'root', 'user', 'ubuntu', 'debian', 'runner', 'runneradmin', 'node', 'localhost', 'host', 'home', 'github',
  'codespace', 'gitpod', 'vscode', 'docker', 'build', 'builder', 'ci', 'test', 'dev', 'pi', 'guest', 'localdomain',
])

/** The local machine's identity, for pre-push use. Empty in CI, where it would only name the runner. */
export function derivedIdentities({ env = process.env, owner = '', os = { userInfo, homedir, hostname } } = {}) {
  if (env.CI || env.GITHUB_ACTIONS) return []
  const usable = value => {
    const v = String(value ?? '').trim()
    return v.length >= 4 && !/^\d+$/.test(v) && !GENERIC_IDENTITIES.has(v.toLowerCase()) && v.toLowerCase() !== owner.toLowerCase() ? v : null
  }
  // A login is often also your public first name, so it only counts as a path segment or an ssh user.
  const logins = new Set()
  try { logins.add(usable(os.userInfo().username)) } catch { /* no passwd entry */ }
  logins.add(usable(String(os.homedir()).split(/[\\/]/).filter(Boolean).pop()))
  const hosts = new Set([usable(String(os.hostname()).split('.')[0])])
  const out = []
  for (const name of logins) if (name) out.push({ re: new RegExp(`(?:(?<=[/\\\\~])${escapeRe(name)}(?![A-Za-z0-9])|(?<![A-Za-z0-9])${escapeRe(name)}(?=@))`, 'gi'), label: 'local identity' })
  for (const name of hosts) if (name) out.push({ re: new RegExp(`(?<![A-Za-z0-9])${escapeRe(name)}(?![A-Za-z0-9])`, 'gi'), label: 'local identity' })
  return out
}

export function loadPrivatePatterns({ env = process.env, home = homedir() } = {}) {
  const parts = []
  if (env.PRIVACY_PATTERNS) parts.push(env.PRIVACY_PATTERNS)
  const file = env.PRIVACY_PATTERNS_FILE || join(home, '.config', 'privacy-scan', 'patterns')
  if (existsSync(file)) parts.push(readFileSync(file, 'utf8'))
  return parsePatterns(parts.join('\n'))
}

// ---------------------------------------------------------------------------
// Exemptions
// ---------------------------------------------------------------------------

const globToRegExp = glob => new RegExp('^' + glob.split('**').map(part => part.split('*').map(p => p.split('?').map(escapeRe).join('[^/]')).join('[^/]*')).join('.*') + '$')

export function parseAllow(text) {
  return (text ?? '').split(/\r?\n/).map((raw, i) => ({ raw: raw.trim(), n: i + 1 })).filter(l => l.raw && !l.raw.startsWith('#')).map(({ raw, n }) => {
    const [rule, glob, ...rest] = raw.split(/\s+/)
    if (rule !== '*' && !RULES.includes(rule)) throw new Error(`${ALLOW_FILE} line ${n}: unknown rule "${rule}" (use ${RULES.join(', ')} or *)`)
    if (rule === 'licence') throw new Error(`${ALLOW_FILE} line ${n}: the licence check cannot be exempted; add a LICENSE`)
    if (!glob) throw new Error(`${ALLOW_FILE} line ${n}: add a path glob after the rule`)
    // A literal here would publish the private value it exempts, in a file that is public.
    if ((rule === 'private-list' || rule === 'derived') && rest.length) throw new Error(`${ALLOW_FILE} line ${n}: ${rule} entries take a path glob only, never the value`)
    return { rule, path: globToRegExp(glob), literal: rest.join(' ').toLowerCase() }
  })
}

const isAllowed = (allow, finding) => allow.some(a =>
  (a.rule === '*' || a.rule === finding.rule) && a.path.test(finding.file) && (!a.literal || finding.match.toLowerCase() === a.literal))

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

// Third-party text that legitimately carries other people's emails and paths. First-party AUTHORS/CONTRIBUTORS files are
// scanned: they are where a personal email is most likely to be added. Source maps and svg are scanned: they embed build paths.
const SKIP_FILE = /(^|\/)node_modules\/|^(vendor|licenses?)\/|(^|\/)(licen[sc]e|notice|copying)(\.[a-z]+)?$|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$|\.(lock|min\.js)$/i
const isSkipped = file => file === ALLOW_FILE || SKIP_FILE.test(file)

/** Scan one line. */
export function scanLine(line, file, lineNo, { patterns = [], allow = [] } = {}) {
  const found = structuralHits(line)
  for (const { re, label } of patterns) {
    re.lastIndex = 0
    for (const m of line.matchAll(re)) found.push({ rule: label === 'local identity' ? 'derived' : 'private-list', match: m[0], shown: `[${label}]` })
  }
  return found.map(f => ({ ...f, file, line: lineNo })).filter(f => !isAllowed(allow, f))
}

const NAME_RULES = new Set(['email', 'private-list', 'derived'])

/** A personal value in a path itself (not its content). The home-directory rules do not apply to a relative path. */
export function scanName(file, options) {
  return scanLine(file, file, 0, options).filter(f => NAME_RULES.has(f.rule))
}

/** What to print for a file: its name, unless the name is itself the finding. */
const displayName = (file, options) => (scanName(file, options).length ? '[a file name]' : file)

/** Findings for text with no files, such as a PR body, a commit log or a report about to be posted. */
export function scanText(text, options) {
  return text.split('\n').flatMap((line, i) => scanLine(line, '(text)', i + 1, options))
}

/** Findings for the lines a unified=0 diff adds. */
export function scanDiff(diff, options) {
  const findings = []
  let file = null
  let lineNo = 0
  let remaining = 0 // added lines still to read in the current hunk: a content line may start with "++"
  for (const row of diff.split('\n')) {
    if (remaining > 0 && row.startsWith('+')) {
      if (file !== null && !isSkipped(file)) findings.push(...scanLine(row.slice(1), file, lineNo, options))
      lineNo += 1
      remaining -= 1
      continue
    }
    if (row.startsWith('diff --git ')) { remaining = 0; continue }
    if (row.startsWith('+++ ')) {
      file = row === '+++ /dev/null' ? null : row.replace(/^\+\+\+ b\//, '')
      if (file !== null && !isSkipped(file)) findings.push(...scanName(file, options))
      continue
    }
    const hunk = row.match(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/)
    if (hunk) { lineNo = Number(hunk[1]); remaining = hunk[2] === undefined ? 1 : Number(hunk[2]) }
  }
  return findings
}

const isBinary = buffer => buffer.subarray(0, 8000).includes(0)

/** Findings for every tracked text file under `cwd`. */
export function scanTree(cwd, options) {
  const names = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-z'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
  const findings = []
  findings.skipped = []
  for (const file of names) {
    if (isSkipped(file)) continue
    findings.push(...scanName(file, options))
    let buffer
    try { if (statSync(join(cwd, file)).size > 4 * 1024 * 1024) { findings.skipped.push(file); continue }; buffer = readFileSync(join(cwd, file)) } catch { continue }
    if (isBinary(buffer)) continue
    buffer.toString('utf8').split('\n').forEach((line, i) => findings.push(...scanLine(line, file, i + 1, options)))
  }
  return findings
}

/** A public repo needs a licence file at its root: without one nobody may legally reuse it. */
export function checkLicence(cwd) {
  const names = execFileSync('git', ['ls-files', '-z', '--', ':(top)*'], { cwd, encoding: 'utf8' }).split('\0').filter(n => n && !n.includes('/'))
  const candidates = names.filter(n => /^(licen[sc]e|copying|unlicen[sc]e)([-._].*)?$/i.test(n))
  const usable = candidates.filter(n => { try { return statSync(join(cwd, n)).size >= 20 } catch { return false } })
  if (usable.length) return { ok: true, file: usable[0] }
  return {
    ok: false,
    reason: candidates.length
      ? `The licence file ${candidates[0]} is empty. Put the licence text in it.`
      : 'This public repo has no LICENSE file at its root, so nobody may legally reuse it. Choose a licence (https://choosealicense.com) and add LICENSE; the choice is the owner\'s.',
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

export function run({ mode = 'tree', cwd = process.cwd(), env = process.env, base, head, patterns, allow, text, log = console.log } = {}) {
  if (String(env.PRIVACY_REPO_PRIVATE).toLowerCase() === 'true') {
    log('Private repository: privacy scan skipped.')
    return 0
  }
  const owner = env.PRIVACY_REPO_OWNER || env.GITHUB_REPOSITORY_OWNER || ''
  let options
  try {
    const allowPath = join(cwd, ALLOW_FILE)
    options = {
      patterns: patterns ?? [...loadPrivatePatterns({ env }), ...derivedIdentities({ env, owner })],
      allow: allow ?? (existsSync(allowPath) ? parseAllow(readFileSync(allowPath, 'utf8')) : []),
    }
  } catch (error) {
    log(`::error title=Privacy scan configuration::${error.message}`)
    return 2
  }
  const configured = options.patterns.some(p => p.label.startsWith('private pattern'))
  if (!configured) {
    const message = 'No private pattern list (PRIVACY_PATTERNS or ~/.config/privacy-scan/patterns): only the structural rules ran.'
    if (String(env.PRIVACY_REQUIRE_PATTERNS).toLowerCase() === 'true') { log(`::error title=Privacy scan configuration::${message} PRIVACY_REQUIRE_PATTERNS is set.`); return 2 }
    log(env.GITHUB_ACTIONS ? `::notice title=Privacy scan::${message}` : message)
  }

  let findings
  if (mode === 'text') {
    findings = scanText(text ?? '', options)
  } else if (mode === 'diff') {
    base ??= env.BASE_SHA || 'origin/main'
    head ??= env.HEAD_SHA || 'HEAD'
    findings = scanDiff(git(cwd, 'diff', '--unified=0', '--no-color', '--no-renames', '--diff-filter=AM', base, head), options)
  } else {
    findings = scanTree(cwd, options)
  }
  const licence = mode === 'text' ? { ok: true, file: 'not checked' } : checkLicence(cwd)
  const where = mode === 'text' ? 'text' : mode === 'diff' ? 'added lines' : 'tracked files'

  const lines = findings.map(f => `${displayName(f.file, options)}:${f.line}  ${f.rule}  ${f.shown}`)
  for (const f of findings) log(`::error file=${escapeProp(displayName(f.file, options))},line=${f.line},title=Privacy ${f.rule}::${escapeData(`${f.rule}: ${f.shown}`)}`)
  if (!licence.ok) log(`::error title=Licence::${licence.reason}`)
  const summary = [
    findings.length ? `${findings.length} personal detail(s) found (${where}); values are masked:\n\n${lines.map(l => `- ${l}`).join('\n')}\n\nRemove them, or exempt a real public one in ${ALLOW_FILE}.` : `No personal paths, emails or identities in the ${where}.`,
    ...(findings.skipped?.length ? [`Not scanned (over 4 MB): ${findings.skipped.length} file(s).`] : []),
    ...(mode === 'text' ? [] : [licence.ok ? `Licence present: ${licence.file} (presence only; the content is not checked).` : `Licence: ${licence.reason}`]),
  ].join('\n\n')
  log(summary)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Privacy scan\n${summary}\n`)
  return findings.length || !licence.ok ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = ['diff', 'text'].includes(process.argv[2]) ? process.argv[2] : 'tree'
  process.exitCode = run({ mode, text: mode === 'text' ? readFileSync(0, 'utf8') : undefined })
}
