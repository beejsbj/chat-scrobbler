import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkLicence, derivedIdentities, parseAllow, parsePatterns, run, scanDiff, scanLine, scanTree } from './privacy-scan.mjs'

// Fixtures are joined from pieces so this file never contains a personal-looking value itself
// (the last test scans this directory and must find nothing).
const MAC = ['', 'Users', 'practice-user', 'code'].join('/')
const LINUX = ['', 'home', 'practice-user', 'app'].join('/')
const WIN = ['C:', 'Users', 'practice-user', 'code'].join('\\')
const MOUNT = ['', 'mnt', 'practice-disk', 'work'].join('/')
const MAIL = ['practice.person', 'fastmail.net'].join('@')
const CANARY = 'zq-canary-handle'

const scan = (line, options) => scanLine(line, 'a.md', 1, options)
const rules = (line, options) => scan(line, options).map(f => f.rule)

test('a home directory path on macOS, Linux or Windows is flagged, whoever it belongs to', () => {
  for (const path of [MAC, LINUX, WIN, WIN.replaceAll('\\', '\\\\')]) {
    assert.deepEqual(rules(`"cwd": "${path}"`), ['home-path'], path)
  }
})

test('placeholder users and URL routes are not flagged', () => {
  for (const line of [
    ['', 'Users', 'username', 'x'].join('/'), ['', 'home', 'runner', 'work'].join('/'), ['', 'home', 'node', 'app'].join('/'),
    ['', 'Users', '<you>', 'x'].join('/'), ['', 'home', '$USER'].join('/'), ['https://site.example', 'home', 'dashboard'].join('/'), ['localhost:3000', 'home', 'feed'].join('/'),
    ['C:', 'Users', 'Public', 'x'].join('\\'),
  ]) assert.deepEqual(rules(line), [], line)
})

test('a machine mount path is flagged; common generic ones are not', () => {
  assert.deepEqual(rules(`volume: ${MOUNT}:/data`), ['host-mount'])
  for (const generic of ['/mnt/c/Users', '/mnt/data/x', '/mnt/shared', '/Volumes/Macintosh HD']) assert.deepEqual(rules(generic), [], generic)
})

test('an email address is flagged; noreply, example, ssh remotes, role aliases and asset names are not', () => {
  assert.deepEqual(rules(`Author: ${MAIL}`), ['email'])
  for (const line of [
    ['12345+someone', 'users.noreply.github.com'].join('@'), ['a', 'example.com'].join('@'), ['git', 'github.com:owner/repo.git'].join('@'),
    ['hello', 'somesite.dev'].join('@'), 'icon@2x.png', 'react@18.2.0', ['noreply', 'anthropic.com'].join('@'), ['a.b', 'corp.invalid'].join('@'),
  ]) assert.deepEqual(rules(line), [], line)
})

test('the masked form we print is not itself a finding, so docs can quote it', () => {
  for (const f of [...scan(MAC), ...scan(MOUNT), ...scan(WIN)]) assert.deepEqual(rules(f.shown), [], f.shown)
})

test('output is masked: the matched value never appears in a finding\'s shown text', () => {
  for (const f of [...scan(MAC), ...scan(MAIL), ...scan(MOUNT)]) {
    assert.ok(!f.shown.includes('practice'), f.shown)
    assert.ok(f.shown.includes('***'))
  }
})

test('private patterns: a literal matches as a whole word, a /regex/ matches as written, comments are ignored', () => {
  const patterns = parsePatterns(`# my names\n${CANARY}\n/canary-host-\\d+/\n`)
  assert.deepEqual(rules(`user ${CANARY.toUpperCase()} wrote this`, { patterns }), ['private-list'])
  assert.deepEqual(rules('see canary-host-42', { patterns }), ['private-list'])
  assert.deepEqual(rules(`${CANARY}x and x${CANARY}`, { patterns }), [])
  assert.equal(scan(`name ${CANARY}`, { patterns })[0].shown, '[private pattern #1]')
})

test('an invalid pattern fails loudly and does not echo the entry', () => {
  assert.throws(() => parsePatterns('/(unclosed/'), error => error.message.includes('#1') && !error.message.includes('unclosed'))
})

test('derived identities come from the local machine, never in CI, and skip generic names and the repo owner', () => {
  const os = { userInfo: () => ({ username: 'practice-user' }), homedir: () => ['', 'home', 'practice-home'].join('/'), hostname: () => 'practice-box.local' }
  const names = env => derivedIdentities({ env, os, owner: 'Practice-Home' })
  assert.equal(names({}).length, 2) // user and hostname; the home dir name equals the owner login
  assert.equal(rules('ssh practice-box now', { patterns: names({}) })[0], 'derived')
  assert.deepEqual(rules('by practice-user, thanks', { patterns: names({}) }), []) // a login that is also a first name is not flagged in prose
  assert.deepEqual(rules(['ssh practice-user', 'box'].join('@'), { patterns: names({}) }), ['derived'])
  assert.deepEqual(names({ CI: 'true' }), [])
  assert.deepEqual(names({ GITHUB_ACTIONS: 'true' }), [])
  const generic = { userInfo: () => ({ username: 'admin' }), homedir: () => ['', 'home', 'admin'].join('/'), hostname: () => 'localhost' }
  assert.deepEqual(derivedIdentities({ env: {}, os: generic }), [])
})

test('exemptions: by rule, path glob and optional literal; unknown rules are rejected', () => {
  const allow = parseAllow(`# intentional\nemail docs/**\nhome-path fixtures/*.json ${MAC.split('/').slice(0, 3).join('/')}\n`)
  assert.deepEqual(scanLine(MAIL, 'docs/deep/page.md', 1, { allow }), [])
  assert.deepEqual(scanLine(MAIL, 'src/page.md', 1, { allow }).map(f => f.rule), ['email'])
  assert.deepEqual(scanLine(MAC, 'fixtures/a.json', 1, { allow }), [])
  assert.deepEqual(scanLine(MAC.replace('practice-user', 'someone-else'), 'fixtures/a.json', 1, { allow }).map(f => f.rule), ['home-path'])
  assert.throws(() => parseAllow('nonsense a.md'), /unknown rule/)
})

const diffOf = (file, removed, added) => [
  `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -4,${removed.length} +4,${added.length} @@`,
  ...removed.map(l => `-${l}`), ...added.map(l => `+${l}`), '',
].join('\n')

test('diff mode flags only added lines, with their new line numbers', () => {
  const found = scanDiff(diffOf('src/a.ts', [`old ${MAC}`], ['clean line', `new ${MAC}`]), {})
  assert.deepEqual(found.map(f => [f.file, f.line, f.rule]), [['src/a.ts', 5, 'home-path']])
  assert.deepEqual(scanDiff(diffOf('src/a.ts', [`old ${MAC}`], ['clean line']), {}), []) // removing a leak passes
})

test('lockfiles, licence texts and vendored files are not scanned', () => {
  for (const file of ['package-lock.json', 'bun.lock', 'node_modules/x/package.json', 'LICENSE', 'licenses/mit.txt', 'NOTICE', 'AUTHORS.md']) {
    assert.deepEqual(scanDiff(diffOf(file, [], [`by ${MAIL}`]), {}), [], file)
  }
})

// ---- git-backed: tree mode, licence, the CLI ------------------------------------------------

const repo = files => {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'practice@example.com')
  git('config', 'user.name', 'practice')
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  git('add', '-A')
  git('commit', '-qm', 'base')
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
const LICENCE_TEXT = 'MIT License\n\nPermission is hereby granted, free of charge...\n'
const quiet = () => { const lines = []; return { log: line => lines.push(line), lines } }

test('tree mode scans tracked text files and skips binary ones', () => {
  const r = repo({ 'LICENSE': LICENCE_TEXT, 'README.md': `built in ${MAC}\n`, 'bin.dat': `\0${MAC}`, 'ok.md': 'nothing here\n' })
  try {
    assert.deepEqual(scanTree(r.dir, {}).map(f => `${f.file}:${f.line}`), ['README.md:1'])
  } finally { r.cleanup() }
})

test('licence: missing fails, empty fails, LICENSE, LICENSE.md and COPYING pass; a nested file does not count', () => {
  const none = repo({ 'README.md': 'x', 'docs/LICENSE': LICENCE_TEXT })
  const empty = repo({ 'LICENSE': '' })
  try {
    assert.equal(checkLicence(none.dir).ok, false)
    assert.match(checkLicence(none.dir).reason, /no LICENSE file/)
    assert.equal(checkLicence(empty.dir).ok, false)
  } finally { none.cleanup(); empty.cleanup() }
  for (const name of ['LICENSE', 'LICENSE.md', 'COPYING', 'LICENCE-MIT']) {
    const r = repo({ [name]: LICENCE_TEXT })
    try { assert.equal(checkLicence(r.dir).ok, true, name) } finally { r.cleanup() }
  }
})

test('run: a clean public repo passes; a leak or a missing licence each fail; a private repo is skipped', () => {
  const clean = repo({ LICENSE: LICENCE_TEXT, 'README.md': 'hello\n' })
  const noLicence = repo({ 'README.md': 'hello\n' })
  const leaky = repo({ LICENSE: LICENCE_TEXT, 'README.md': `see ${MAIL}\n` })
  try {
    const env = { PRIVACY_PATTERNS_FILE: join(clean.dir, 'none') }
    assert.equal(run({ mode: 'tree', cwd: clean.dir, env, ...quiet() }), 0)
    assert.equal(run({ mode: 'tree', cwd: noLicence.dir, env, ...quiet() }), 1)
    const out = quiet()
    assert.equal(run({ mode: 'tree', cwd: leaky.dir, env, log: out.log }), 1)
    assert.ok(!out.lines.join('\n').includes('practice.person'), 'the log must not repeat the email')
    assert.equal(run({ mode: 'tree', cwd: noLicence.dir, env: { ...env, PRIVACY_REPO_PRIVATE: 'true' }, ...quiet() }), 0)
  } finally { clean.cleanup(); noLicence.cleanup(); leaky.cleanup() }
})

test('run in diff mode: the practice cases fail, the fixed case passes, a private pattern from the environment is honoured', () => {
  const r = repo({ LICENSE: LICENCE_TEXT, 'README.md': 'hello\n' })
  const env = { PRIVACY_PATTERNS_FILE: join(r.dir, 'none') }
  const attempt = (name, text, extraEnv = {}) => {
    r.git('checkout', '-q', '-b', name, 'main')
    writeFileSync(join(r.dir, 'notes.md'), text)
    r.git('add', '-A'); r.git('commit', '-qm', name)
    const code = run({ mode: 'diff', cwd: r.dir, base: 'main', head: name, env: { ...env, ...extraEnv }, ...quiet() })
    r.git('checkout', '-q', 'main')
    return code
  }
  try {
    assert.equal(attempt('path', `cd ${MAC}\n`), 1)
    assert.equal(attempt('email', `mail ${MAIL}\n`), 1)
    assert.equal(attempt('username', `by ${CANARY}\n`), 0) // no private list: only the structural rules ran
    assert.equal(attempt('username-listed', `by ${CANARY}\n`, { PRIVACY_PATTERNS: CANARY }), 1)
    assert.equal(attempt('clean', 'just prose\n'), 0)
    assert.equal(run({ mode: 'diff', cwd: r.dir, base: 'main', head: 'main', env: { PRIVACY_PATTERNS: '/(oops/' }, ...quiet() }), 2) // bad config fails closed
  } finally { r.cleanup() }
})

test('this directory scans clean: the scanner and its tests publish no personal value', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const r = repo({ LICENSE: LICENCE_TEXT })
  try {
    for (const file of ['privacy-scan.mjs', 'privacy-scan.test.mjs']) {
      writeFileSync(join(r.dir, file), readFileSync(join(here, file)))
    }
    r.git('add', '-A')
    assert.deepEqual(scanTree(r.dir, {}), [])
  } finally { r.cleanup() }
})

test('the allowlist literal must equal the whole match, so a longer name cannot ride on a short entry', () => {
  const allow = parseAllow(['home-path', 'Dockerfile', ['', 'home', 'appuser'].join('/')].join(' '))
  assert.deepEqual(scanLine(['', 'home', 'appuser'].join('/'), 'Dockerfile', 1, { allow }), [])
  assert.deepEqual(scanLine(['', 'home', 'appuser-two'].join('/'), 'Dockerfile', 1, { allow }).map(f => f.rule), ['home-path'])
})

test('a WSL home path (a Windows drive mounted under /mnt) is flagged', () => {
  assert.deepEqual(rules(['', 'mnt', 'c', 'Users', 'practice-user', 'code'].join('/')), ['home-path'])
})

test('source maps and svg files are scanned; only exact licence-type filenames are skipped', () => {
  for (const file of ['dist/app.js.map', 'public/logo.svg', 'license-check.js', 'notice-board.md']) {
    assert.equal(scanDiff(diffOf(file, [], [`at ${MAC}`]), {}).length, 1, file)
  }
  for (const file of ['LICENSE', 'LICENSE.md', 'docs/NOTICE.txt']) assert.equal(scanDiff(diffOf(file, [], [`at ${MAC}`]), {}).length, 0, file)
})

test('an added line whose content starts with ++ is still scanned', () => {
  const diff = ['diff --git a/a.md b/a.md', '--- a/a.md', '+++ b/a.md', '@@ -1,0 +1,2 @@', `+++ ${MAC}`, '+second', ''].join('\n')
  assert.deepEqual(scanDiff(diff, {}).map(f => [f.file, f.line]), [['a.md', 1]])
})

test('annotations escape workflow-command characters in file names', () => {
  const lines = []
  const r = repo({ LICENSE: LICENCE_TEXT, ['a,b:c.md']: `at ${MAC}\n` })
  try {
    run({ mode: 'tree', cwd: r.dir, env: { PRIVACY_PATTERNS_FILE: join(r.dir, 'none') }, log: l => lines.push(l) })
    assert.ok(lines.some(l => l.startsWith('::error file=a%2Cb%3Ac.md,')), lines.join('\n'))
  } finally { r.cleanup() }
})
