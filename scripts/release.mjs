#!/usr/bin/env node
// Cut a release: npm run release -- <x.y.z | patch | minor | major>
// Notes come from the matching "## x.y.z" section of CHANGELOG.md (bullet lines).
// Bumps package.json and package-lock.json, commits, makes an annotated tag vX.Y.Z holding the
// notes (the in-app updater reads them from there), pushes, and creates a GitHub release if gh is set up.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim();
const die = (m) => {
  console.error(`\n  ${m}\n`);
  process.exit(1);
};

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const arg = process.argv[2];
if (!arg) die('Usage: npm run release -- <x.y.z | patch | minor | major>');
const [ma, mi, pa] = pkg.version.split('.').map(Number);
const next = arg === 'major' ? `${ma + 1}.0.0` : arg === 'minor' ? `${ma}.${mi + 1}.0` : arg === 'patch' ? `${ma}.${mi}.${pa + 1}` : arg;
if (!/^\d+\.\d+\.\d+$/.test(next)) die(`Not a version: ${next}`);

const log = fs.readFileSync('CHANGELOG.md', 'utf8');
const m = log.match(new RegExp(`^## ${next.replace(/\./g, '\\.')}\\b.*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'));
const notes = (m?.[1] ?? '').split('\n').filter((l) => /^[-*] /.test(l.trim())).map((l) => l.trim());
if (!notes.length) die(`Add a "## ${next}" section with bullet notes to CHANGELOG.md first.`);
if (sh('git', ['tag', '-l', `v${next}`])) die(`v${next} already exists.`);
const dirty = sh('git', ['status', '--porcelain', '--untracked-files=no']).split('\n').filter((l) => l && !/ (CHANGELOG\.md|package(-lock)?\.json)$/.test(l));
if (dirty.length) die(`Commit these first:\n  ${dirty.join('\n  ')}`);

pkg.version = next;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
if (fs.existsSync('package-lock.json')) {
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  lock.version = next;
  if (lock.packages?.['']) lock.packages[''].version = next;
  fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
}
sh('git', ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
sh('git', ['commit', '-q', '-m', `Release ${next}`]);
const message = `Forkspace ${next}\n\n${notes.join('\n')}\n`;
sh('git', ['tag', '-a', `v${next}`, '-m', message]);
sh('git', ['push', '-q', 'origin', 'HEAD', `v${next}`]);
try {
  sh('gh', ['release', 'create', `v${next}`, '--title', `Forkspace ${next}`, '--notes', notes.join('\n')]);
} catch {
  console.log('  (No GitHub release made: gh is missing or not signed in. The tag is enough for updates.)');
}
console.log(`\n  Released ${next}. Everyone gets it from Settings → Update.\n`);
