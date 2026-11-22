#!/usr/bin/env node
// Public-repo privacy gate: no personal paths, emails or identities in what a public repo
// publishes, and a licence file at its root.
//
//   node privacy-scan.mjs diff   scan the lines a PR adds (BASE_SHA...HEAD_SHA, default origin/main...HEAD)
//   node privacy-scan.mjs tree   scan every tracked file (push to the default branch, or by hand)
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
// Exemptions go in .github/privacy-allow.txt: `<rule|*> <path-glob> [literal]` per line.
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
const ROLE_ADDRESSES = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'git', 'info', 'contact', 'hello', 'support', 'admin', 'security',
  'press', 'team', 'sales', 'abuse', 'you', 'user', 'username', 'name', 'email', 'your-email', 'youremail', 'yourname',
  'me', 'someone', 'foo', 'bar', 'test', 'john', 'jane', 'john.doe', 'jane.doe', 'jdoe',
])
const FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'css', 'js', 'mjs', 'cjs', 'ts', 'json', 'md', 'html', 'woff', 'woff2'])
const SAFE_DOMAIN = /(^|\.)(example\.(com|org|net)|users\.noreply\.github\.com|noreply\.github\.com)$|\.(invalid|test|example|localhost|local)$/i

// A name must end at a non-name character and not at `*`, so the masked form we print (/Users/p***) is itself safe to quote.
const HOME_PATH = /(?<![A-Za-z0-9_])\/(?:Users|home)\/([A-Za-z0-9._-]+)(?![A-Za-z0-9._*-])/g
const WINDOWS_HOME = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}([A-Za-z0-9._-]+)(?![A-Za-z0-9._*-])/g
const HOST_MOUNT = /(?<![A-Za-z0-9_])\/(?:mnt|Volumes)\/([A-Za-z0-9._-]{3,})(?![A-Za-z0-9._*-])/g
const EMAIL = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g

function structuralHits(line) {
  const hits = []
  for (const [re, rule] of [[HOME_PATH, 'home-path'], [WINDOWS_HOME, 'home-path']]) {
    for (const m of line.matchAll(re)) {
      const name = m[1].toLowerCase()
      if (PLACEHOLDER_NAMES.has(name) || /^\.+$/.test(name)) continue
      hits.push({ rule, match: m[0], shown: m[0].slice(0, m[0].length - m[1].length) + mask(m[1]) })
    }
  }
  for (const m of line.matchAll(HOST_MOUNT)) {
    if (GENERIC_MOUNTS.has(m[1].toLowerCase())) continue
    hits.push({ rule: 'host-mount', match: m[0], shown: m[0].slice(0, m[0].length - m[1].length) + mask(m[1]) })
  }
  for (const m of line.matchAll(EMAIL)) {
    const local = m[1].toLowerCase()
    const domain = m[2].toLowerCase()
    if (ROLE_ADDRESSES.has(local) || SAFE_DOMAIN.test(domain)) continue
    if (FILE_EXTENSIONS.has(domain.split('.').pop())) continue
    hits.push({ rule: 'email', match: m[0], shown: `${mask(m[1])}@${m[2]}` })
  }
  return hits
}

/** First character and a mark: enough to find it, not enough to publish it. */
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
      entries.push({ re, label: `private pattern #${n}` })
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
    if (!glob) throw new Error(`${ALLOW_FILE} line ${n}: add a path glob after the rule`)
    return { rule, path: globToRegExp(glob), literal: rest.join(' ').toLowerCase() }
  })
}

const isAllowed = (allow, finding) => allow.some(a =>
  (a.rule === '*' || a.rule === finding.rule) && a.path.test(finding.file) && (!a.literal || finding.match.toLowerCase().includes(a.literal)))

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

// Third-party text that legitimately carries other people's emails and paths.
const SKIP_FILE = /(^|\/)(node_modules|vendor|licenses?)\/|(^|\/)(licen[sc]e|notice|copying|authors|contributors)[^/]*$|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$|\.(lock|min\.js|map|svg)$/i
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

/** Findings for the lines a unified=0 diff adds. */
export function scanDiff(diff, options) {
  const findings = []
  let file = null
  let lineNo = 0
  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ ')) { file = row === '+++ /dev/null' ? null : row.replace(/^\+\+\+ b\//, ''); continue }
    const hunk = row.match(/^@@ -\S+ \+(\d+)/)
    if (hunk) { lineNo = Number(hunk[1]); continue }
    if (file === null || isSkipped(file)) continue
    if (row.startsWith('+') && !row.startsWith('+++')) { findings.push(...scanLine(row.slice(1), file, lineNo, options)); lineNo += 1 }
  }
  return findings
}

const isBinary = buffer => buffer.subarray(0, 8000).includes(0)

/** Findings for every tracked text file under `cwd`. */
export function scanTree(cwd, options) {
  const names = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-z'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
  const findings = []
  for (const file of names) {
    if (isSkipped(file)) continue
    let buffer
    try { if (statSync(join(cwd, file)).size > 4 * 1024 * 1024) continue; buffer = readFileSync(join(cwd, file)) } catch { continue }
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

export function run({ mode = 'tree', cwd = process.cwd(), env = process.env, base, head, patterns, allow, log = console.log } = {}) {
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
  if (!configured && env.GITHUB_ACTIONS) log('::notice title=Privacy scan::No private pattern list (PRIVACY_PATTERNS) configured: only the structural rules ran.')

  let findings
  if (mode === 'diff') {
    base ??= env.BASE_SHA || 'origin/main'
    head ??= env.HEAD_SHA || 'HEAD'
    findings = scanDiff(git(cwd, 'diff', '--unified=0', '--no-color', '--no-renames', '--diff-filter=AM', `${base}...${head}`), options)
  } else {
    findings = scanTree(cwd, options)
  }
  const licence = checkLicence(cwd)

  const lines = findings.map(f => `${f.file}:${f.line}  ${f.rule}  ${f.shown}`)
  for (const f of findings) log(`::error file=${f.file},line=${f.line},title=Privacy ${f.rule}::${f.rule}: ${f.shown}`)
  if (!licence.ok) log(`::error title=Licence::${licence.reason}`)
  const summary = [
    findings.length ? `${findings.length} personal detail(s) found (${mode === 'diff' ? 'added lines' : 'tracked files'}); values are masked:\n\n${lines.map(l => `- ${l}`).join('\n')}\n\nRemove them, or exempt a real public one in ${ALLOW_FILE}.` : `No personal paths, emails or identities in the ${mode === 'diff' ? 'added lines' : 'tracked files'}.`,
    licence.ok ? `Licence: ${licence.file}.` : `Licence: ${licence.reason}`,
  ].join('\n\n')
  log(summary)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Privacy scan\n${summary}\n`)
  return findings.length || !licence.ok ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] === 'diff' ? 'diff' : 'tree'
  process.exitCode = run({ mode })
}
