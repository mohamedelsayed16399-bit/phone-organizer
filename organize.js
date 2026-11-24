#!/usr/bin/env node
'use strict';
/*
 * phone-organizer: organize files on an Android phone from Termux.
 * Zero dependencies. Node 18+.
 *
 * Safety rules:
 *  - Never deletes anything. Files are only MOVED (and nothing is overwritten).
 *  - Default is a preview (dry run). Nothing moves until you confirm.
 *  - Every move is written to a log so `undo` can put everything back.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');

const VERSION = '1.0.0';
const ORG = 'Organized';
const DUPES_DIR = 'Duplicates-Review';

const CATEGORIES = {
  Images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'svg', 'tiff', 'raw', 'dng'],
  Videos: ['mp4', 'mkv', 'avi', 'mov', 'webm', '3gp', 'flv', 'wmv', 'm4v', 'ts'],
  Audio: ['mp3', 'm4a', 'wav', 'ogg', 'opus', 'aac', 'flac', 'amr', 'wma', 'mid'],
  Documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp', 'csv', 'epub', 'md', 'json', 'xml', 'html', 'htm'],
  Archives: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso'],
  Apps: ['apk', 'xapk', 'apks', 'aab', 'exe', 'msi', 'dmg'],
};
const EXT2CAT = {};
for (const [cat, exts] of Object.entries(CATEGORIES)) for (const e of exts) EXT2CAT[e] = cat;

// files that are probably still downloading or are junk markers: never touched
const PARTIAL_EXT = new Set(['crdownload', 'part', 'tmp', 'download', 'temp', 'partial', 'opdownload', 'nomedia']);

// ---------- helpers ----------
function parseArgs(argv) {
  const o = { _: [], folder: [], flags: new Set() };
  const withValue = new Set(['root', 'folder', 'min-age', 'top', 'log']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let [k, v] = a.slice(2).split(/=(.*)/s);
      if (withValue.has(k)) {
        if (v === undefined) v = argv[++i];
        if (v === undefined) fail('Missing value for --' + k);
        if (k === 'folder') o.folder.push(v);
        else o[k] = v;
      } else o.flags.add(k);
    } else o._.push(a);
  }
  return o;
}

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

function human(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}

function stamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function homeDir() {
  return process.env.ORGANIZER_HOME || path.join(os.homedir(), '.phone-organizer');
}

function findRoot(opts) {
  const cands = [];
  if (opts.root) cands.push(path.resolve(opts.root));
  else {
    cands.push(path.join(os.homedir(), 'storage', 'shared'), '/storage/emulated/0', '/sdcard');
  }
  for (const c of cands) {
    try {
      fs.readdirSync(c);
      return c;
    } catch (_) { /* try next */ }
  }
  console.error('Cannot read phone storage.');
  console.error('Run this once, tap ALLOW on the popup, then try again:');
  console.error('    termux-setup-storage');
  process.exit(1);
}

function resolveFolders(root, opts) {
  const list = opts.folder.length ? opts.folder : ['Download'];
  const out = [];
  for (const f of list) {
    const abs = path.resolve(root, f);
    if (abs !== root && !abs.startsWith(root + path.sep)) fail(`Folder "${f}" is outside the phone storage.`);
    const rel = path.relative(root, abs);
    if (rel === '' && !opts.flags.has('whole-storage')) {
      fail('Refusing to organize the whole storage by accident. Use --folder NAME, or add --whole-storage if you really mean it.');
    }
    if (rel.split(path.sep)[0] === 'Android') fail('The Android folder belongs to apps. Not touching it.');
    if (!fs.existsSync(abs)) fail(`Folder not found: ${abs}`);
    out.push(abs);
  }
  return out;
}

function categoryOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return EXT2CAT[ext] || 'Other';
}

// date from file name (IMG_20240315_..., 2024-03-15...) else modified time
function dateOf(name, stat) {
  const m = name.match(/(?:^|[^0-9])((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[^0-9]|$)/);
  if (m) {
    const y = +m[1];
    if (y >= 1990 && y <= new Date().getFullYear() + 1) return { y: m[1], m: m[2] };
  }
  const d = new Date(stat.mtimeMs);
  return { y: String(d.getFullYear()), m: String(d.getMonth() + 1).padStart(2, '0') };
}

function* walk(dir, deep, depth = 0) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  ents.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of ents) {
    if (e.name.startsWith('.')) continue; // hidden files/folders are left alone
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (e.name === ORG || e.name === DUPES_DIR) continue;
      if (deep && depth < 8) yield* walk(full, deep, depth + 1);
    } else if (e.isFile()) yield full;
  }
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  for (let i = 1; i < 100000; i++) {
    const c = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(c)) return c;
  }
  throw new Error('Could not find a free name for ' + p);
}

// Move without ever overwriting. Falls back to copy+verify when rename crosses drives.
function safeMove(from, to, createdDirs) {
  const dir = path.dirname(to);
  if (!fs.existsSync(dir)) {
    // remember which directories we create so undo can remove the empty ones
    let d = dir;
    const chain = [];
    while (!fs.existsSync(d)) { chain.push(d); d = path.dirname(d); }
    fs.mkdirSync(dir, { recursive: true });
    for (const c of chain) createdDirs.add(c);
  }
  const final = uniquePath(to);
  try {
    fs.renameSync(from, final);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    const st = fs.statSync(from);
    fs.copyFileSync(from, final, fs.constants.COPYFILE_EXCL);
    if (fs.statSync(final).size !== st.size) throw new Error('copy size mismatch for ' + from);
    fs.utimesSync(final, st.atime, st.mtime);
    fs.unlinkSync(from); // only after a verified copy: this completes a move
  }
  return final;
}

async function confirm(question, opts) {
  if (opts.flags.has('yes')) return true;
  if (!process.stdin.isTTY) {
    console.log('(not interactive: preview only. Add --yes to apply.)');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((r) => rl.question(question + ' [type yes to continue]: ', r));
  rl.close();
  return ans.trim().toLowerCase() === 'yes' || ans.trim().toLowerCase() === 'y';
}

function writeLog(log, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(log, null, 1));
  fs.renameSync(file + '.tmp', file);
}

function newLog(kind, root) {
  const file = path.join(homeDir(), 'logs', `${stamp()}-${kind}.json`);
  return { file, log: { version: VERSION, kind, createdAt: new Date().toISOString(), root, undone: false, moves: [], createdDirs: [] } };
}

// run a list of planned moves with a log that is always saved (also on Ctrl+C)
function execute(plan, kind, root) {
  const { file, log } = newLog(kind, root);
  const created = new Set();
  let stop = false;
  const onInt = () => { stop = true; };
  process.on('SIGINT', onInt);
  let done = 0, failed = 0;
  try {
    for (const m of plan) {
      if (stop) { console.log('Stopped early. Moves so far are saved and can be undone.'); break; }
      try {
        const final = safeMove(m.from, m.to, created);
        log.moves.push({ from: m.from, to: final });
        done++;
      } catch (e) {
        failed++;
        console.log(`  skipped (${e.code || e.message}): ${path.basename(m.from)}`);
      }
      if (done % 25 === 0) { log.createdDirs = [...created]; writeLog(log, file); }
    }
  } finally {
    process.removeListener('SIGINT', onInt);
    log.createdDirs = [...created];
    if (log.moves.length) writeLog(log, file);
  }
  return { done, failed, file: log.moves.length ? file : null };
}

// ---------- commands ----------
function planOrganize(root, folders, opts) {
  const minAgeMs = (opts['min-age'] !== undefined ? +opts['min-age'] : 10) * 60 * 1000;
  const flat = opts.flags.has('flat');
  const deep = opts.flags.has('deep');
  const plan = [];
  const skipped = { partial: 0, recent: 0, hidden: 0 };
  const now = Date.now();
  for (const folder of folders) {
    for (const f of walk(folder, deep)) {
      const name = path.basename(f);
      const ext = path.extname(name).slice(1).toLowerCase();
      if (PARTIAL_EXT.has(ext)) { skipped.partial++; continue; }
      let st;
      try { st = fs.statSync(f); } catch (_) { continue; }
      if (now - st.mtimeMs < minAgeMs) { skipped.recent++; continue; }
      const cat = categoryOf(name);
      const parts = [folder, ORG, cat];
      if (!flat && (cat === 'Images' || cat === 'Videos' || cat === 'Documents' || cat === 'Audio' || cat === 'Other' || cat === 'Archives' || cat === 'Apps')) {
        const d = dateOf(name, st);
        parts.push(`${d.y}-${d.m}`);
      }
      parts.push(name);
      plan.push({ from: f, to: path.join(...parts), size: st.size, cat });
    }
  }
  return { plan, skipped };
}

async function cmdOrganize(opts) {
  const root = findRoot(opts);
  const folders = resolveFolders(root, opts);
  const { plan, skipped } = planOrganize(root, folders, opts);
  console.log(`Phone storage: ${root}`);
  console.log(`Looking in: ${folders.map((f) => path.relative(root, f) || '.').join(', ')}${opts.flags.has('deep') ? ' (including sub-folders)' : ' (top level only)'}`);
  if (!plan.length) {
    console.log('Nothing to organize. All clear.');
    return;
  }
  const byCat = {};
  for (const p of plan) { byCat[p.cat] = byCat[p.cat] || { n: 0, size: 0 }; byCat[p.cat].n++; byCat[p.cat].size += p.size; }
  console.log('\nPREVIEW (nothing has moved yet):');
  for (const [c, v] of Object.entries(byCat).sort()) console.log(`  ${c.padEnd(10)} ${String(v.n).padStart(5)} files  ${human(v.size)}`);
  console.log(`  TOTAL      ${String(plan.length).padStart(5)} files`);
  if (skipped.partial || skipped.recent) console.log(`  left alone: ${skipped.partial} unfinished downloads, ${skipped.recent} files changed in the last ${opts['min-age'] || 10} min`);
  const show = opts.flags.has('list') ? plan : plan.slice(0, 12);
  console.log('\nExamples:');
  for (const p of show) console.log(`  ${path.basename(p.from)}\n     -> ${path.relative(root, p.to)}`);
  if (show.length < plan.length) console.log(`  ... and ${plan.length - show.length} more (add --list to see all)`);
  console.log('\nNo file will be deleted or overwritten. You can undo everything with:  node organize.js undo');
  if (!(await confirm('\nMove these files now?', opts))) {
    console.log('Nothing was changed.');
    return;
  }
  const r = execute(plan, 'organize', root);
  console.log(`\nDone. Moved ${r.done} files${r.failed ? `, ${r.failed} skipped` : ''}.`);
  if (r.file) console.log('To undo:  node organize.js undo');
}

function hashFile(f) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(f, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function findDupes(root, folders, opts) {
  const deep = !opts.flags.has('top-only');
  const bySize = new Map();
  for (const folder of folders) {
    for (const f of walk(folder, deep)) {
      let st;
      try { st = fs.statSync(f); } catch (_) { continue; }
      if (st.size === 0) continue;
      const k = st.size;
      if (!bySize.has(k)) bySize.set(k, []);
      bySize.get(k).push({ f, size: st.size, mtime: st.mtimeMs });
    }
  }
  const groups = [];
  for (const arr of bySize.values()) {
    if (arr.length < 2) continue;
    const byHash = new Map();
    for (const it of arr) {
      let h;
      try { h = hashFile(it.f); } catch (_) { continue; }
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(it);
    }
    for (const g of byHash.values()) {
      if (g.length < 2) continue;
      // keep the oldest file; ties: shortest path
      g.sort((a, b) => a.mtime - b.mtime || a.f.length - b.f.length || (a.f < b.f ? -1 : 1));
      groups.push({ keep: g[0], extra: g.slice(1), size: g[0].size });
    }
  }
  groups.sort((a, b) => b.size * b.extra.length - a.size * a.extra.length);
  return groups;
}

async function cmdDupes(opts) {
  const root = findRoot(opts);
  const folders = resolveFolders(root, opts);
  console.log(`Searching for exact duplicates (same content) in: ${folders.map((f) => path.relative(root, f)).join(', ')}`);
  const groups = findDupes(root, folders, opts);
  if (!groups.length) { console.log('No duplicates found.'); return; }
  let wasted = 0, extras = 0;
  const lines = [];
  for (const g of groups) {
    wasted += g.size * g.extra.length; extras += g.extra.length;
    lines.push(`KEEP  ${path.relative(root, g.keep.f)}  (${human(g.size)})`);
    for (const e of g.extra) lines.push(`COPY  ${path.relative(root, e.f)}`);
    lines.push('');
  }
  const rep = path.join(homeDir(), `duplicates-${stamp()}.txt`);
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(rep, lines.join('\n'));
  console.log(`\nFound ${groups.length} sets of duplicates: ${extras} extra copies wasting ${human(wasted)}.`);
  for (const l of lines.slice(0, 30)) console.log('  ' + l);
  if (lines.length > 30) console.log('  ...');
  console.log(`Full list saved: ${rep}`);
  if (!opts.flags.has('move-dupes')) {
    console.log('\nNothing was moved or deleted. To gather the extra copies in one folder for you to review:');
    console.log('    node organize.js dupes --move-dupes');
    return;
  }
  const dest = path.join(root, DUPES_DIR, stamp());
  console.log(`\nThe extra copies would be MOVED (not deleted) to: ${path.relative(root, dest)}`);
  if (!(await confirm('Move them now?', opts))) { console.log('Nothing was changed.'); return; }
  const plan = [];
  for (const g of groups) for (const e of g.extra) plan.push({ from: e.f, to: path.join(dest, path.basename(e.f)) });
  const r = execute(plan, 'dupes', root);
  console.log(`Done. Moved ${r.done} extra copies. Look through ${path.relative(root, dest)} and delete them yourself when you are sure.`);
  console.log('To undo:  node organize.js undo');
}

function cmdBig(opts) {
  const root = findRoot(opts);
  const folders = opts.folder.length ? resolveFolders(root, opts) : [root];
  const top = +(opts.top || 20);
  const all = [];
  for (const folder of folders) {
    for (const f of walk(folder, true)) {
      if (path.relative(root, f).split(path.sep)[0] === 'Android') continue;
      try { all.push({ f, size: fs.statSync(f).size }); } catch (_) { /* ignore */ }
    }
  }
  all.sort((a, b) => b.size - a.size);
  console.log(`Biggest ${Math.min(top, all.length)} files (read-only list, nothing changes):`);
  for (const a of all.slice(0, top)) console.log(`  ${human(a.size).padStart(9)}  ${path.relative(root, a.f)}`);
}

function listLogs() {
  const dir = path.join(homeDir(), 'logs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f));
}

function rmdirIfEmpty(d, stopAt) {
  while (d.startsWith(stopAt + path.sep)) {
    try { fs.rmdirSync(d); } catch (_) { return; } // rmdir only works on EMPTY folders
    d = path.dirname(d);
  }
}

async function cmdUndo(opts) {
  let files = listLogs();
  if (opts.log) files = [path.resolve(opts.log)];
  let file = null, log = null;
  for (const f of files.reverse()) {
    try {
      const l = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!l.undone) { file = f; log = l; break; }
    } catch (_) { /* skip broken log */ }
  }
  if (!log) { console.log('Nothing to undo.'); return; }
  console.log(`Last run: ${log.kind} on ${log.createdAt} (${log.moves.length} files moved)`);
  if (!(await confirm('Put all those files back where they were?', opts))) { console.log('Nothing was changed.'); return; }
  let back = 0, missing = 0, renamed = 0;
  const created = new Set();
  for (const m of log.moves.slice().reverse()) {
    if (!fs.existsSync(m.to)) { missing++; continue; }
    try {
      const target = uniquePath(m.from);
      if (target !== m.from) renamed++;
      safeMove(m.to, target, created);
      back++;
    } catch (e) {
      console.log(`  could not restore ${path.basename(m.to)}: ${e.code || e.message}`);
    }
  }
  // clean up empty folders that this tool created (never non-empty ones)
  for (const d of (log.createdDirs || []).sort((a, b) => b.length - a.length)) rmdirIfEmpty(d, log.root);
  if (missing === 0) { log.undone = true; log.undoneAt = new Date().toISOString(); writeLog(log, file); }
  console.log(`Restored ${back} files.${missing ? ` ${missing} not found (you moved or removed them yourself); run undo again if needed.` : ''}${renamed ? ` ${renamed} got a (1) suffix because the original name was taken.` : ''}`);
}

function help() {
  console.log(`phone-organizer ${VERSION}  (never deletes anything)

Usage:  node organize.js [command] [options]

Commands:
  organize   (default) sort files into Organized/<Type>/<Year-Month>. Preview first.
  dupes      find exact duplicate files. Add --move-dupes to gather extra copies for review.
  big        list the biggest files on the phone (read-only).
  undo       put back everything moved by the last run.

Options:
  --folder NAME   folder inside phone storage (default: Download). Can repeat.
  --deep          also look inside sub-folders (organize)
  --flat          Organized/<Type> only, without Year-Month
  --list          show every planned move in the preview
  --yes           do not ask for confirmation
  --min-age MIN   skip files changed in the last MIN minutes (default 10)
  --top N         how many files for "big" (default 20)
  --root PATH     use another storage root (for testing)
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0] || 'organize';
  if (opts.flags.has('help') || cmd === 'help') return help();
  if (opts.flags.has('version')) return console.log(VERSION);
  if (cmd === 'organize') return cmdOrganize(opts);
  if (cmd === 'dupes') return cmdDupes(opts);
  if (cmd === 'big') return cmdBig(opts);
  if (cmd === 'undo') return cmdUndo(opts);
  console.error(`Unknown command: ${cmd}`);
  help();
  process.exit(1);
}

if (require.main === module) main().catch((e) => { console.error('ERROR: ' + (e && e.message ? e.message : e)); process.exit(1); });
module.exports = { categoryOf, dateOf, planOrganize, findDupes };
