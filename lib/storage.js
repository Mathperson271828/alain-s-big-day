// Storage for submissions and photos. Nothing here is ever publicly readable:
// photos are only served through /media/<name>, which requires Alain's host login.
//
// - With BLOB_READ_WRITE_TOKEN set (Vercel): a Vercel Blob store. Create it as a *Private*
//   store (or set BLOB_ACCESS=public if you made a public one; names stay unguessable either way).
// - Otherwise: local disk under DATA_DIR (default ./data).
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));
const PHOTO_NAME = /^[A-Za-z0-9-]{36,80}\.(?:jpg|png|webp|gif)$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** "/media/<name>" -> "<name>" when it is a well-formed photo reference. */
export function photoName(ref) {
  const m = typeof ref === 'string' && ref.match(/^\/media\/([^/]+)$/);
  return m && PHOTO_NAME.test(m[1]) ? m[1] : null;
}

export function createStorage({
  blobToken = process.env.BLOB_READ_WRITE_TOKEN,
  blobAccess = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private',
  dataDir = process.env.DATA_DIR || 'data',
} = {}) {
  return blobToken ? blobStorage(blobToken, blobAccess) : diskStorage(path.resolve(dataDir));
}

function blobStorage(token, access) {
  let sdk;
  const blob = async () => (sdk ??= await import('@vercel/blob'));

  async function listAll(prefix) {
    const { list } = await blob();
    const out = [];
    let cursor;
    do {
      const page = await list({ prefix, cursor, token, limit: 1000 });
      out.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  }

  async function readJson(pathname) {
    const { get } = await blob();
    const res = await get(pathname, { access, token, useCache: false });
    if (!res || res.statusCode !== 200) return null;
    return JSON.parse(await new Response(res.stream).text());
  }

  return {
    kind: `vercel-blob (${access})`,
    async savePhoto(buffer, type) {
      const name = `${randomUUID()}.${EXT[type]}`;
      const { put } = await blob();
      await put(`photos/${name}`, buffer, { access, contentType: type, token, addRandomSuffix: false });
      return `/media/${name}`;
    },
    async hasPhoto(name) {
      const { head } = await blob();
      try { await head(`photos/${name}`, { token }); return true; } catch { return false; }
    },
    async readPhoto(name) {
      const { get } = await blob();
      const res = await get(`photos/${name}`, { access, token });
      if (!res || res.statusCode !== 200) return null;
      return { body: Readable.fromWeb(res.stream), type: TYPE[name.split('.').pop()] };
    },
    async saveSubmission(record) {
      const { put } = await blob();
      await put(`submissions/${record.id}.json`, JSON.stringify(record), {
        access, contentType: 'application/json', token, addRandomSuffix: false,
      });
    },
    async listSubmissions() {
      const blobs = await listAll('submissions/');
      const records = await Promise.all(blobs.map((b) => readJson(b.pathname).catch(() => null)));
      return records.filter(Boolean);
    },
    async deleteSubmission(id) {
      if (!ID.test(id)) return false;
      const rec = await readJson(`submissions/${id}.json`).catch(() => null);
      if (!rec) return false;
      const { del } = await blob();
      const names = (rec.photos || []).map(photoName).filter(Boolean).map((n) => `photos/${n}`);
      await del([`submissions/${id}.json`, ...names], { token });
      return true;
    },
  };
}

function diskStorage(root) {
  const subDir = path.join(root, 'submissions');
  const photoDir = path.join(root, 'photos');
  const ensure = () => Promise.all([mkdir(subDir, { recursive: true }), mkdir(photoDir, { recursive: true })]);

  return {
    kind: `disk (${root})`,
    async savePhoto(buffer, type) {
      await ensure();
      const name = `${randomUUID()}.${EXT[type]}`;
      await writeFile(path.join(photoDir, name), buffer);
      return `/media/${name}`;
    },
    async hasPhoto(name) {
      try { await readFile(path.join(photoDir, name), { flag: 'r' }); return true; } catch { return false; }
    },
    async readPhoto(name) {
      try { return { body: await readFile(path.join(photoDir, name)), type: TYPE[name.split('.').pop()] }; }
      catch { return null; }
    },
    async saveSubmission(record) {
      await ensure();
      await writeFile(path.join(subDir, `${record.id}.json`), JSON.stringify(record));
    },
    async listSubmissions() {
      await ensure();
      const files = (await readdir(subDir)).filter((f) => f.endsWith('.json'));
      const out = [];
      for (const f of files) {
        try { out.push(JSON.parse(await readFile(path.join(subDir, f), 'utf8'))); } catch { /* skip */ }
      }
      return out;
    },
    async deleteSubmission(id) {
      if (!ID.test(id)) return false;
      const file = path.join(subDir, `${id}.json`);
      let rec;
      try { rec = JSON.parse(await readFile(file, 'utf8')); } catch { return false; }
      for (const ref of rec.photos || []) {
        const name = photoName(ref);
        if (name) await unlink(path.join(photoDir, name)).catch(() => {});
      }
      await unlink(file);
      return true;
    },
  };
}
