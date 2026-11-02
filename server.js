// Alain's Special Day — one request handler used both locally (node server.js) and on Vercel (api/index.js).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createStorage, photoName } from './lib/storage.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_PHOTO_BYTES = 4 * 1024 * 1024; // Vercel functions accept bodies up to ~4.5 MB
const MAX_PHOTOS = 8;
const SESSION_DAYS = 30;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/host': ['host.html', 'text/html; charset=utf-8'],
  '/host.html': ['host.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/submit.js': ['submit.js', 'text/javascript; charset=utf-8'],
  '/host.js': ['host.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/film/alain-21.bin': ['film/alain-21.bin', 'application/octet-stream'],
};

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
};

const sha256 = (s) => createHash('sha256').update(String(s)).digest();

export function createHandler(opts = {}) {
  const storage = opts.storage ?? createStorage();
  const hostPassword = opts.hostPassword ?? process.env.HOST_PASSWORD ?? '';
  const submitCode = (opts.submitCode ?? process.env.SUBMIT_CODE ?? '').trim();
  const secret = opts.sessionSecret ?? process.env.SESSION_SECRET ?? createHash('sha256').update(`alain-21:${hostPassword}`).digest('hex');
  const publicDir = opts.publicDir ?? path.join(ROOT, 'public');
  const videoKey = (opts.videoKey ?? process.env.VIDEO_KEY ?? '').trim();

  const sign = (value) => createHmac('sha256', secret).update(value).digest('base64url');

  function isHost(req) {
    const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('host='));
    if (!cookie || !hostPassword) return false;
    const [exp, sig] = cookie.slice(5).split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const expected = Buffer.from(sign(`host.${exp}`));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store',
      ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  async function readBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error('too_large'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function readJson(req) {
    try { return JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); }
    catch (e) { if (e.status) throw e; throw Object.assign(new Error('bad_json'), { status: 400 }); }
  }

  function sniffImage(buf) {
    if (buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
    return null;
  }

  const clean = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max);

  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;

    // ---- public ----
    if (m === 'GET' && p === '/api/config') return send(res, 200, { codeRequired: Boolean(submitCode) });

    if (m === 'POST' && p === '/api/photo') {
      if (submitCode && clean(req.headers['x-submit-code'], 100).toLowerCase() !== submitCode.toLowerCase()) {
        return send(res, 403, { error: 'Wrong birthday code.' });
      }
      const buf = await readBody(req, MAX_PHOTO_BYTES);
      const type = sniffImage(buf);
      if (!type) return send(res, 415, { error: 'That file does not look like a photo (JPG, PNG, WebP or GIF).' });
      const ref = await storage.savePhoto(buf, type);
      return send(res, 201, { ref });
    }

    if (m === 'POST' && p === '/api/submit') {
      const body = await readJson(req);
      if (body.website) return send(res, 201, { ok: true }); // honeypot: quietly drop bots
      if (submitCode && clean(body.code, 100).toLowerCase() !== submitCode.toLowerCase()) {
        return send(res, 403, { error: 'Wrong birthday code.' });
      }
      const name = clean(body.name, 60);
      const message = clean(body.message, 3000);
      const refs = Array.isArray(body.photos) ? body.photos.slice(0, MAX_PHOTOS) : [];
      if (!name) return send(res, 400, { error: 'Please add your name so Alain knows who it is from.' });
      if (!message && !refs.length) return send(res, 400, { error: 'Write a note or add a photo (or both!).' });
      const photos = [];
      for (const r of refs) {
        const n = photoName(r);
        if (n && !photos.includes(r) && await storage.hasPhoto(n)) photos.push(r);
      }
      if (photos.length !== refs.length) return send(res, 400, { error: 'One of the photos did not upload. Please try again.' });
      await storage.saveSubmission({ id: randomUUID(), name, message, photos, createdAt: new Date().toISOString() });
      return send(res, 201, { ok: true });
    }

    // ---- host ----
    if (m === 'POST' && p === '/api/host/login') {
      const { password } = await readJson(req);
      const ok = hostPassword && timingSafeEqual(sha256(password ?? ''), sha256(hostPassword));
      if (!ok) {
        await new Promise((r) => setTimeout(r, 400));
        return send(res, 401, { error: hostPassword ? 'That is not it. Try again!' : 'HOST_PASSWORD is not set on the server yet.' });
      }
      const exp = Date.now() + SESSION_DAYS * 86400e3;
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, {
        'Set-Cookie': `host=${exp}.${sign(`host.${exp}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`,
      });
    }
    if (m === 'POST' && p === '/api/host/logout') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'host=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
    }
    if (p.startsWith('/api/host/') || p.startsWith('/media/')) {
      if (!isHost(req)) return send(res, 401, { error: 'Only Alain can see this.' });
      if (m === 'GET' && p === '/api/host/wall') {
        const entries = (await storage.listSubmissions())
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map(({ id, name, message, photos, createdAt }) => ({ id, name, message, photos, createdAt }));
        return send(res, 200, { entries });
      }
      if (m === 'GET' && p === '/api/host/film') {
        // The film is a public static file, but AES-GCM encrypted; only the host gets the key.
        return send(res, 200, videoKey ? { url: '/film/alain-21.bin', key: videoKey } : { url: null });
      }
      const del = p.match(/^\/api\/host\/entry\/([0-9a-f-]{36})$/);
      if (m === 'DELETE' && del) {
        const ok = await storage.deleteSubmission(del[1]);
        return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Not found' });
      }
      if (m === 'GET' && p.startsWith('/media/')) {
        const name = photoName(p);
        const photo = name && await storage.readPhoto(name);
        if (!photo) return send(res, 404, { error: 'Not found' });
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': photo.type, 'Cache-Control': 'private, max-age=604800, immutable' });
        if (Buffer.isBuffer(photo.body)) return res.end(photo.body);
        return void (await new Promise((resolve, reject) => photo.body.on('error', reject).pipe(res).on('finish', resolve)));
      }
      return send(res, 404, { error: 'Not found' });
    }

    // ---- static ----
    if (m === 'GET' || m === 'HEAD') {
      const hit = STATIC[p];
      if (hit) {
        const buf = await readFile(path.join(publicDir, hit[0]));
        return send(res, 200, buf, { 'Content-Type': hit[1], 'Cache-Control': 'no-cache' });
      }
    }
    return send(res, 404, { error: 'Not found' });
  }

  async function handler(req, res) {
    try { await route(req, res); }
    catch (err) {
      if (!err.status) console.error(err);
      let msg = err.status === 413 ? 'That photo is too big even after shrinking. Try another one.' : err.status ? 'Bad request.' : 'Something went wrong. Please try again.';
      // Setup problems are worth showing to anyone; full details only to the logged-in host.
      if (!err.status && /^Photo storage/.test(err.message)) msg = err.message;
      else if (!err.status && isHost(req)) msg = `Something went wrong: ${err.message}`;
      if (!res.headersSent) send(res, err.status || 500, { error: msg });
      else res.end();
    }
  }
  return { handler, storage };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { handler, storage } = createHandler();
  const port = Number(process.env.PORT) || 3000;
  http.createServer(handler).listen(port, () => {
    console.log(`Alain's Special Day running at http://localhost:${port}  (storage: ${storage.kind})`);
    console.log(`Host wall: http://localhost:${port}/host${process.env.HOST_PASSWORD ? '' : '  (set HOST_PASSWORD to enable)'}`);
  });
}
