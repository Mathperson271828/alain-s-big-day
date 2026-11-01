import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHandler } from '../server.js';
import { createStorage } from '../lib/storage.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
let server, base, dir;

async function start(opts) {
  const { handler } = createHandler({ storage: createStorage({ useBlob: false, dataDir: dir }), hostPassword: 'happy21', ...opts });
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, r));
  return { s, base: `http://127.0.0.1:${s.address().port}` };
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'alain-'));
  ({ s: server, base } = await start());
});
after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function login() {
  const res = await fetch(`${base}/api/host/login`, json({ password: 'happy21' }));
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

test('serves the friend page and host page', async () => {
  for (const p of ['/', '/host']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.ok(res.headers.get('content-security-policy'));
  }
});

test('friend can submit a note with a photo, but cannot read anything back', async () => {
  const up = await fetch(`${base}/api/photo`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: JPEG });
  assert.equal(up.status, 201);
  const { ref } = await up.json();
  assert.match(ref, /^\/media\/[0-9a-f-]+\.jpg$/);

  const sub = await fetch(`${base}/api/submit`, json({ name: 'Leo', message: 'Happy 21st, Alain!', photos: [ref] }));
  assert.equal(sub.status, 201);

  assert.equal((await fetch(`${base}/api/host/wall`)).status, 401);
  assert.equal((await fetch(base + ref)).status, 401);
});

test('rejects non-images, empty submissions, and made-up photo refs', async () => {
  const bad = await fetch(`${base}/api/photo`, { method: 'POST', body: Buffer.from('<script>alert(1)</script> hello') });
  assert.equal(bad.status, 415);
  assert.equal((await fetch(`${base}/api/submit`, json({ name: 'X', message: '   ' }))).status, 400);
  assert.equal((await fetch(`${base}/api/submit`, json({ name: '', message: 'hi' }))).status, 400);
  const fake = await fetch(`${base}/api/submit`, json({ name: 'X', message: 'hi', photos: ['/media/00000000-0000-0000-0000-000000000000.jpg'] }));
  assert.equal(fake.status, 400);
  const evil = await fetch(`${base}/api/submit`, json({ name: 'X', message: 'hi', photos: ['https://evil.example/a.jpg'] }));
  assert.equal(evil.status, 400);
});

test('rejects photos over the size limit', async () => {
  const big = Buffer.concat([JPEG, Buffer.alloc(4 * 1024 * 1024 + 10)]);
  const res = await fetch(`${base}/api/photo`, { method: 'POST', body: big });
  assert.equal(res.status, 413);
});

test('host login, wall, photo, and delete', async () => {
  assert.equal((await fetch(`${base}/api/host/login`, json({ password: 'nope' }))).status, 401);
  const cookie = await login();
  const wall = await (await fetch(`${base}/api/host/wall`, { headers: { cookie } })).json();
  const leo = wall.entries.find((e) => e.name === 'Leo');
  assert.equal(leo.message, 'Happy 21st, Alain!');
  const photo = await fetch(base + leo.photos[0], { headers: { cookie } });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');

  const forged = `host=${Date.now() + 1e9}.AAAA`;
  assert.equal((await fetch(`${base}/api/host/wall`, { headers: { cookie: forged } })).status, 401);

  assert.equal((await fetch(`${base}/api/host/entry/${leo.id}`, { method: 'DELETE', headers: { cookie } })).status, 200);
  const after = await (await fetch(`${base}/api/host/wall`, { headers: { cookie } })).json();
  assert.ok(!after.entries.some((e) => e.id === leo.id));
  assert.equal((await fetch(base + leo.photos[0], { headers: { cookie } })).status, 404);
});

test('birthday code is enforced when set', async () => {
  const { s, base: b } = await start({ submitCode: 'WU' });
  try {
    assert.deepEqual(await (await fetch(`${b}/api/config`)).json(), { codeRequired: true });
    assert.equal((await fetch(`${b}/api/submit`, json({ name: 'A', message: 'hi' }))).status, 403);
    assert.equal((await fetch(`${b}/api/photo`, { method: 'POST', body: JPEG })).status, 403);
    assert.equal((await fetch(`${b}/api/submit`, json({ name: 'A', message: 'hi', code: 'wu' }))).status, 201);
  } finally { s.close(); }
});

test('host is locked when no password is configured', async () => {
  const { s, base: b } = await start({ hostPassword: '' });
  try {
    assert.equal((await fetch(`${b}/api/host/login`, json({ password: '' }))).status, 401);
  } finally { s.close(); }
});
