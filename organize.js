#!/usr/bin/env node
'use strict';
/*
 * phone-organizer: organize files on an Android phone from Termux.
 * Zero dependencies. Node 18+.
 *
 * Safety rules:
 *  - Never deletes anything. Files are only MOVED (and nothing is overwritten).
 *  - Default is a preview (dry run). Nothing moves until you confirm.
 *  - A journal is opened and checked BEFORE anything moves. If it cannot be
 *    written, nothing is moved. Each move is recorded (and flushed to disk)
 *    BEFORE the file moves, so `undo` can always find it.
 *  - A run only counts as undone when every file is back. Anything that failed
 *    to restore stays in the journal, so running `undo` again retries it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');

const VERSION = '1.1.0';
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

// Work out where a move will land, and which folders it will have to create.
function prepareMove(to) {
  const dir = path.dirname(to);
  const chain = [];
  let d = dir;
  while (!fs.existsSync(d)) { chain.push(d); d = path.dirname(d); }
  return { dir, chain, final: uniquePath(to) };
}

// Move without ever overwriting. Falls back to copy+verify when rename crosses drives.
function commitMove(from, prep, createdDirs) {
  if (prep.chain.length) {
    fs.mkdirSync(prep.dir, { recursive: true });
    for (const c of prep.chain) createdDirs.add(c);
  }
  const final = prep.final;
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

function safeMove(from, to, createdDirs) {
  return commitMove(from, prepareMove(to), createdDirs);
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

// Legacy (v1.0) logs were one JSON file. Still read by undo.
function writeLog(log, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(log, null, 1));
  fs.renameSync(file + '.tmp', file);
}

// Journal: append-only JSON lines, each line flushed to disk before we go on.
// Throws if the line could not be written.
class Journal {
  constructor(file) { this.file = file; this.fd = null; }
  open(header) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.fd = fs.openSync(this.file, 'wx');
    this.add(header);
  }
  add(entry) {
    fs.writeSync(this.fd, JSON.stringify(entry) + '\n');
    fs.fsyncSync(this.fd);
  }
  close() { try { if (this.fd !== null) fs.closeSync(this.fd); } catch (_) { /* ignore */ } this.fd = null; }
}

function openJournal(kind, root) {
  const file = path.join(homeDir(), 'logs', `${stamp()}-${process.pid}-${kind}.jsonl`);
  const j = new Journal(file);
  j.open({ t: 'header', version: VERSION, kind, createdAt: new Date().toISOString(), root });
  return j;
}

// run a list of planned moves. The journal must be writable first; every move
// is journaled before it happens (also safe on Ctrl+C)
function execute(plan, kind, root) {
  let j;
  try {
    j = openJournal(kind, root);
  } catch (e) {
    console.error(`Cannot save the undo journal (${e.code || e.message}).`);
    console.error('Nothing was moved, because a move could not be undone without it.');
    return { done: 0, failed: 0, file: null, aborted: true };
  }
  const created = new Set();
  let stop = false;
  const onInt = () => { stop = true; };
  process.on('SIGINT', onInt);
  let done = 0, failed = 0, aborted = false;
  try {
    let id = 0;
    for (const m of plan) {
      if (stop) { console.log('Stopped early. Moves so far are saved and can be undone.'); break; }
      let prep;
      try {
        prep = prepareMove(m.to);
      } catch (e) {
        failed++;
        console.log(`  skipped (${e.code || e.message}): ${path.basename(m.from)}`);
        continue;
      }
      id++;
      try {
        // record the intent first: if the journal fails, this file does not move
        j.add({ t: 'intent', id, from: m.from, to: prep.final, dirs: prep.chain });
      } catch (e) {
        aborted = true;
        console.error(`\nStopped: the undo journal can no longer be written (${e.code || e.message}). No more files will be moved.`);
        break;
      }
      try {
        commitMove(m.from, prep, created);
        done++;
        try { j.add({ t: 'done', id }); } catch (_) { /* intent is already saved; undo checks the real state */ }
      } catch (e) {
        failed++;
        console.log(`  skipped (${e.code || e.message}): ${path.basename(m.from)}`);
      }
    }
  } finally {
    process.removeListener('SIGINT', onInt);
    j.close();
  }
  return { done, failed, file: j.file, aborted };
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
  if (r.aborted && !r.done) { process.exitCode = 1; return; }
  console.log(`\n${r.aborted ? 'Stopped early. ' : ''}Done. Moved ${r.done} files${r.failed ? `, ${r.failed} skipped` : ''}.`);
  if (r.done) console.log('To undo:  node organize.js undo');
  if (r.aborted) process.exitCode = 1;
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
  if (r.aborted && !r.done) { process.exitCode = 1; return; }
  console.log(`${r.aborted ? 'Stopped early. ' : ''}Done. Moved ${r.done} extra copies. Look through ${path.relative(root, dest)} and delete them yourself when you are sure.`);
  if (r.done) console.log('To undo:  node organize.js undo');
  if (r.aborted) process.exitCode = 1;
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
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl')).sort().map((f) => path.join(dir, f));
}

function rmdirIfEmpty(d, stopAt) {
  while (d.startsWith(stopAt + path.sep)) {
    try { fs.rmdirSync(d); } catch (_) { return; } // rmdir only works on EMPTY folders
    d = path.dirname(d);
  }
}

// Read a log into { entries: [{id, from, to, state}], dirs, root, kind, createdAt, undone }.
// state: 'moved' (or unknown) | 'restored' | 'gone'. Unreadable lines are skipped.
function loadLog(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const l = JSON.parse(text);
    return { legacy: true, raw: l, root: l.root, kind: l.kind, createdAt: l.createdAt, undone: !!l.undone,
      dirs: l.createdDirs || [], entries: (l.moves || []).map((m, i) => ({ id: i + 1, from: m.from, to: m.to, state: 'moved' })) };
  }
  const out = { legacy: false, root: null, kind: '?', createdAt: '?', undone: false, dirs: [], entries: [] };
  const byId = new Map();
  let sawHeader = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    if (r.t === 'header') { sawHeader = true; out.root = r.root; out.kind = r.kind; out.createdAt = r.createdAt; }
    else if (r.t === 'intent') {
      const e = { id: r.id, from: r.from, to: r.to, state: 'moved' };
      byId.set(r.id, e); out.entries.push(e);
      for (const d of r.dirs || []) out.dirs.push(d);
    } else if ((r.t === 'restored' || r.t === 'gone') && byId.has(r.id)) byId.get(r.id).state = r.t;
    else if (r.t === 'undone') out.undone = true;
  }
  if (!sawHeader) throw new Error('not a journal');
  return out;
}

async function cmdUndo(opts) {
  let files = listLogs();
  if (opts.log) files = [path.resolve(opts.log)];
  let file = null, log = null;
  for (const f of files.reverse()) {
    try {
      const l = loadLog(f);
      if (!l.undone && l.entries.some((e) => e.state === 'moved')) { file = f; log = l; break; }
    } catch (_) { /* skip broken log */ }
  }
  if (!log) { console.log('Nothing to undo.'); return; }
  const pending = log.entries.filter((e) => e.state === 'moved');
  console.log(`Last run: ${log.kind} on ${log.createdAt} (${pending.length} files to put back)`);
  if (!(await confirm('Put all those files back where they were?', opts))) { console.log('Nothing was changed.'); return; }
  let jr = null;
  if (!log.legacy) {
    try { jr = new Journal(file); jr.fd = fs.openSync(file, 'a'); } catch (e) {
      console.log(`Note: cannot write to the journal (${e.code || e.message}); files will still be restored, but a retry may re-check them.`);
    }
  }
  const mark = (e, t) => { e.state = t; if (jr) { try { jr.add({ t, id: e.id }); } catch (_) { /* state is re-checked from disk on retry */ } } };
  let back = 0, missing = 0, renamed = 0, errors = 0, ambiguous = 0;
  const created = new Set();
  const forget = opts.flags.has('forget-missing');
  for (const m of pending.slice().reverse()) {
    const toThere = fs.existsSync(m.to);
    const fromThere = fs.existsSync(m.from);
    if (!toThere) {
      if (fromThere) { mark(m, 'restored'); continue; } // the move never happened, or it is already back
      if (forget) { mark(m, 'gone'); continue; }
      missing++; continue;
    }
    if (fromThere && !log.legacy) {
      // both exist: an interrupted cross-drive copy. Do not guess, do not touch.
      const a = fs.statSync(m.to), b = fs.statSync(m.from);
      if (a.size === b.size) { ambiguous++; console.log(`  left alone (the file exists in both places, check by hand): ${m.to}`); continue; }
    }
    try {
      const target = uniquePath(m.from);
      if (target !== m.from) renamed++;
      safeMove(m.to, target, created);
      mark(m, 'restored');
      back++;
    } catch (e) {
      errors++;
      console.log(`  could not restore ${path.basename(m.to)}: ${e.code || e.message}`);
    }
  }
  // clean up empty folders that this tool created (never non-empty ones)
  for (const d of [...new Set(log.dirs)].sort((a, b) => b.length - a.length)) rmdirIfEmpty(d, log.root);
  const left = log.entries.filter((e) => e.state === 'moved').length;
  if (left === 0) {
    if (log.legacy) { log.raw.undone = true; log.raw.undoneAt = new Date().toISOString(); writeLog(log.raw, file); }
    else if (jr) { try { jr.add({ t: 'undone', at: new Date().toISOString() }); } catch (_) { /* ignore */ } }
  } else if (log.legacy) {
    // keep only what is still unresolved, so a retry picks up exactly those
    log.raw.moves = log.entries.filter((e) => e.state === 'moved').map((e) => ({ from: e.from, to: e.to }));
    try { writeLog(log.raw, file); } catch (_) { /* original log is left untouched */ }
  }
  if (jr) jr.close();
  console.log(`Restored ${back} files.${renamed ? ` ${renamed} got a (1) suffix because the original name was taken.` : ''}`);
  if (left) {
    console.log(`${left} file(s) are NOT restored yet${errors ? ` (${errors} errors)` : ''}${missing ? ` (${missing} not found: moved or removed by you?)` : ''}${ambiguous ? ` (${ambiguous} need a manual look)` : ''}. They are still in the journal: run undo again to retry.`);
    if (missing) console.log('If those files are gone for good, run:  node organize.js undo --forget-missing');
    process.exitCode = 1;
  }
}

function help() {
  console.log(`phone-organizer ${VERSION}  (never deletes anything)

Usage:  node organize.js [command] [options]

Commands:
  organize   (default) sort files into Organized/<Type>/<Year-Month>. Preview first.
  dupes      find exact duplicate files. Add --move-dupes to gather extra copies for review.
  big        list the biggest files on the phone (read-only).
  undo       put back everything moved by the last run (run again to retry any that failed).

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
module.exports = { categoryOf, dateOf, planOrganize, findDupes, execute, cmdUndo, parseArgs };
