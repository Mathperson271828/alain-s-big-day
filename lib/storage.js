// Storage for submissions and photos. Nothing here is ever publicly readable:
// photos are only served through /media/<name>, which requires Alain's host login.
//
// - On Vercel (or whenever BLOB_READ_WRITE_TOKEN / BLOB_STORE_ID is set): a Vercel Blob store.
//   Both ways Vercel connects a store work: a read-write token, or a store id + Vercel's
//   built-in OIDC login. Private stores are preferred; a public store is detected and used too
//   (names are random UUIDs, so they still cannot be guessed).
// - Otherwise (local development): disk under DATA_DIR (default ./data).
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
  env = process.env,
  useBlob = Boolean(env.BLOB_READ_WRITE_TOKEN || env.BLOB_STORE_ID || env.VERCEL),
  blobToken = env.BLOB_READ_WRITE_TOKEN || undefined,
  blobAccess = env.BLOB_ACCESS === 'public' ? 'public' : 'private',
  dataDir = env.DATA_DIR || 'data',
} = {}) {
  return useBlob ? blobStorage(blobToken, blobAccess) : diskStorage(path.resolve(dataDir));
}

/** Turns SDK errors into something a person can act on. */
function explain(err) {
  const msg = String(err?.message || err);
  if (/credentials|token found|OIDC|oidc/i.test(msg)) {
    return new Error('Photo storage is not connected. In Vercel open Storage, connect your Blob store to this project, then redeploy.', { cause: err });
  }
  if (/store does not exist|suspended/i.test(msg)) {
    return new Error(`Photo storage problem: ${msg.replace(/^Vercel Blob: /, '')} Check Storage in Vercel, reconnect the Blob store, then redeploy.`, { cause: err });
  }
  return err;
}

function blobStorage(token, preferredAccess) {
  let sdk;
  let access = preferredAccess;
  const blob = async () => (sdk ??= await import('@vercel/blob'));
  const auth = token ? { token } : {}; // without a token the SDK uses BLOB_STORE_ID + Vercel OIDC

  // Run fn with the current access mode; if the store turns out to be the other kind
  // (public vs private), switch once and remember it.
  async function withAccess(fn) {
    try { return await fn(access); }
    catch (err) {
      const { BlobNotFoundError } = await blob();
      if (err instanceof BlobNotFoundError || /credentials|token found|OIDC/i.test(err?.message)) throw explain(err);
      const other = access === 'private' ? 'public' : 'private';
      try { const out = await fn(other); access = other; return out; }
      catch { throw explain(err); }
    }
  }

  async function listAll(prefix) {
    const { list } = await blob();
    const out = [];
    let cursor;
    try {
      do {
        const page = await list({ prefix, cursor, limit: 1000, ...auth });
        out.push(...page.blobs);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    } catch (err) { throw explain(err); }
    return out;
  }

  async function getStream(pathname, opts = {}) {
    const { get } = await blob();
    const res = await withAccess((a) => get(pathname, { access: a, ...opts, ...auth }));
    return res && res.statusCode === 200 ? res.stream : null;
  }

  async function readJson(pathname) {
    const stream = await getStream(pathname, { useCache: false });
    return stream ? JSON.parse(await new Response(stream).text()) : null;
  }

  return {
    get kind() { return `vercel-blob (${access}${token ? ', token' : ', oidc'})`; },
    async savePhoto(buffer, type) {
      const name = `${randomUUID()}.${EXT[type]}`;
      const { put } = await blob();
      await withAccess((a) => put(`photos/${name}`, buffer, { access: a, contentType: type, addRandomSuffix: false, ...auth }));
      return `/media/${name}`;
    },
    async hasPhoto(name) {
      const { head } = await blob();
      try { await head(`photos/${name}`, auth); return true; } catch { return false; }
    },
    async readPhoto(name) {
      const stream = await getStream(`photos/${name}`).catch(() => null);
      return stream ? { body: Readable.fromWeb(stream), type: TYPE[name.split('.').pop()] } : null;
    },
    async saveSubmission(record) {
      const { put } = await blob();
      await withAccess((a) => put(`submissions/${record.id}.json`, JSON.stringify(record), {
        access: a, contentType: 'application/json', addRandomSuffix: false, ...auth,
      }));
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
      await del([`submissions/${id}.json`, ...names], auth);
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
