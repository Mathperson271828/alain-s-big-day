// Encrypt the birthday film so it can live in a public repo.
//   VIDEO_KEY=<base64 key> node scripts/encrypt-film.js path/to/film.mp4
// Without VIDEO_KEY a new random key is generated and printed. Put that key in Vercel as VIDEO_KEY.
// Output: public/film/alain-21.bin = 12-byte IV + AES-256-GCM ciphertext (with its 16-byte tag).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, createCipheriv } from 'node:crypto';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/encrypt-film.js film.mp4'); process.exit(1); }
const key = process.env.VIDEO_KEY ? Buffer.from(process.env.VIDEO_KEY, 'base64') : randomBytes(32);
if (key.length !== 32) { console.error('VIDEO_KEY must be 32 bytes, base64-encoded'); process.exit(1); }
const iv = randomBytes(12);
const c = createCipheriv('aes-256-gcm', key, iv);
const body = Buffer.concat([c.update(await readFile(src)), c.final(), c.getAuthTag()]);
await mkdir('public/film', { recursive: true });
await writeFile('public/film/alain-21.bin', Buffer.concat([iv, body]));
console.log(`wrote public/film/alain-21.bin (${(body.length / 1e6).toFixed(1)} MB)`);
if (!process.env.VIDEO_KEY) console.log(`VIDEO_KEY=${key.toString('base64')}`);
