'use strict';
// Run: node test.js   (uses a fake phone folder, never touches real files)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const SCRIPT = path.join(__dirname, 'organize.js');

function snapshot(root) {
  const out = {};
  (function w(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) w(f);
      else out[path.relative(root, f)] = crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
    }
  })(root);
  return out;
}
function mk(root, rel, content, ageDays = 30) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  const t = new Date(Date.now() - ageDays * 86400000);
  fs.utimesSync(f, t, t);
}
function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-'));
  const root = path.join(base, 'shared');
  const home = path.join(base, 'home');
  mk(root, 'Download/photo1.jpg', 'AAA');
  mk(root, 'Download/IMG_20230415_101010.jpg', 'BBB');
  mk(root, 'Download/IMG_20230415_101010 (copy).jpg', 'BBB'); // duplicate of previous
  mk(root, 'Download/song.mp3', 'music');
  mk(root, 'Download/cv.pdf', 'pdf1');
  mk(root, 'Download/app.apk', 'apk');
  mk(root, 'Download/data.zip', 'zip');
  mk(root, 'Download/weird.xyz', 'x');
  mk(root, 'Download/video.mp4', 'vid');
  mk(root, 'Download/unfinished.crdownload', 'half');
  mk(root, 'Download/new.pdf', 'fresh', 0); // just created: must be left alone
  mk(root, 'Download/.hidden', 'h');
  mk(root, 'Download/sub/deep.png', 'png');
  mk(root, 'Download/sub/cv.pdf', 'pdf2');
  mk(root, 'DCIM/Camera/cam.jpg', 'camera');
  mk(root, 'Android/data/x/y.txt', 'app data');
  mk(root, 'WhatsApp/Media/a.jpg', 'wa');
  return { base, root, home };
}
function run(ctx, args, input) {
  return spawnSync('node', [SCRIPT, ...args, '--root', ctx.root], { env: { ...process.env, ORGANIZER_HOME: ctx.home }, encoding: 'utf8', input });
}

test('preview changes nothing (default, non-interactive)', () => {
  const c = setup(); const before = snapshot(c.root);
  const r = run(c, []);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREVIEW/);
  assert.deepStrictEqual(snapshot(c.root), before);
  assert.ok(!fs.existsSync(path.join(c.home, 'logs')));
});

test('organize moves files by type, leaves others, never loses data, undo restores exactly', () => {
  const c = setup(); const before = snapshot(c.root);
  const r = run(c, ['--yes']);
  assert.strictEqual(r.status, 0, r.stderr);
  const after = snapshot(c.root);
  assert.strictEqual(Object.keys(after).length, Object.keys(before).length, 'file count unchanged');
  assert.deepStrictEqual(Object.values(after).sort(), Object.values(before).sort(), 'same contents');
  const has = (p) => fs.existsSync(path.join(c.root, p));
  assert.ok(has('Download/Organized/Images/2023-04/IMG_20230415_101010.jpg'), 'date from file name');
  assert.ok(has('Download/Organized/Audio'));
  assert.ok(has('Download/Organized/Apps'));
  assert.ok(has('Download/Organized/Archives'));
  assert.ok(has('Download/Organized/Videos'));
  assert.ok(has('Download/Organized/Other'));
  assert.ok(has('Download/unfinished.crdownload'), 'partial download untouched');
  assert.ok(has('Download/new.pdf'), 'fresh file untouched');
  assert.ok(has('Download/.hidden'), 'hidden untouched');
  assert.ok(has('Download/sub/deep.png'), 'subfolder untouched without --deep');
  assert.ok(has('DCIM/Camera/cam.jpg') && has('WhatsApp/Media/a.jpg') && has('Android/data/x/y.txt'));
  const u = run(c, ['undo', '--yes']);
  assert.strictEqual(u.status, 0, u.stderr);
  assert.deepStrictEqual(snapshot(c.root), before, 'exactly the original tree');
  assert.ok(!has('Download/Organized'), 'empty folders removed');
});

test('--deep handles name collisions without overwriting, and is idempotent', () => {
  const c = setup(); const before = snapshot(c.root);
  run(c, ['--deep', '--yes']);
  const mid = snapshot(c.root);
  assert.strictEqual(Object.keys(mid).length, Object.keys(before).length);
  assert.deepStrictEqual(Object.values(mid).sort(), Object.values(before).sort());
  const pdfs = Object.keys(mid).filter((k) => k.endsWith('.pdf') && k.includes('cv'));
  assert.strictEqual(pdfs.length, 2, 'both cv.pdf kept: ' + pdfs);
  const r2 = run(c, ['--deep', '--yes']);
  assert.match(r2.stdout, /Nothing to organize/);
  run(c, ['undo', '--yes']);
  assert.deepStrictEqual(snapshot(c.root), before);
});

test('undo when original name is taken in the meantime keeps both', () => {
  const c = setup();
  run(c, ['--yes']);
  mk(c.root, 'Download/photo1.jpg', 'NEWER FILE'); // user created same name after
  const u = run(c, ['undo', '--yes']);
  assert.match(u.stdout, /\(1\) suffix/);
  assert.strictEqual(fs.readFileSync(path.join(c.root, 'Download/photo1.jpg'), 'utf8'), 'NEWER FILE');
  assert.strictEqual(fs.readFileSync(path.join(c.root, 'Download/photo1 (1).jpg'), 'utf8'), 'AAA');
});

test('dupes: reports without touching; --move-dupes moves extras, undo restores', () => {
  const c = setup(); const before = snapshot(c.root);
  const r = run(c, ['dupes']);
  assert.match(r.stdout, /1 sets of duplicates/);
  assert.deepStrictEqual(snapshot(c.root), before);
  const m = run(c, ['dupes', '--move-dupes', '--yes']);
  assert.strictEqual(m.status, 0, m.stderr);
  assert.strictEqual(Object.keys(snapshot(c.root)).length, Object.keys(before).length);
  assert.ok(fs.readdirSync(path.join(c.root, 'Duplicates-Review')).length === 1);
  run(c, ['undo', '--yes']);
  assert.deepStrictEqual(snapshot(c.root), before);
});

test('safety: refuses whole storage, Android folder, path escape', () => {
  const c = setup();
  assert.notStrictEqual(run(c, ['--folder', '.', '--yes']).status, 0);
  assert.notStrictEqual(run(c, ['--folder', 'Android', '--yes']).status, 0);
  assert.notStrictEqual(run(c, ['--folder', '../..', '--yes']).status, 0);
  assert.notStrictEqual(run(c, ['--folder', 'Nope', '--yes']).status, 0);
});

test('big lists files; missing storage gives the setup hint', () => {
  const c = setup();
  assert.match(run(c, ['big']).stdout, /Biggest/);
  const r = spawnSync('node', [SCRIPT, '--root', '/nonexistent-xyz'], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /termux-setup-storage/);
});

test('empty folder & many files', () => {
  const c = setup(); fs.rmSync(path.join(c.root, 'Download'), { recursive: true });
  fs.mkdirSync(path.join(c.root, 'Download'));
  assert.match(run(c, ['--yes']).stdout, /Nothing to organize/);
  for (let i = 0; i < 600; i++) mk(c.root, `Download/f${i}.txt`, 'c' + i);
  const before = snapshot(c.root);
  run(c, ['--yes']);
  assert.strictEqual(Object.keys(snapshot(c.root)).length, 603);
  run(c, ['undo', '--yes']);
  assert.deepStrictEqual(snapshot(c.root), before);
});
