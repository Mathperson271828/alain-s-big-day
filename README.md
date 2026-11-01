# Alain's Special Day 🎂

A birthday wall for **Alain Soto's 21st** (November 1).

- **Friends** go to `/`. They write a note (shown in handwriting) and upload photos with Alain. They can **only submit**. They never see anyone else's notes or photos, and they can't read their own back.
- **Alain** goes to `/host` and enters the host password. He gets a reveal screen with confetti and an interactive collage wall:
  - filters for everything, notes only or photos only
  - shuffle
  - a full-screen viewer with arrow-key and swipe navigation
  - a slideshow mode
  - a "remove from my wall" button, in case anything needs moderating

Photos are shrunk in the browser to 1800px JPEGs before upload, so big phone photos still upload fast. Photos and notes live in **private** storage. They are only ever served to a browser that is logged in as the host.

## Run it locally

```bash
npm install
HOST_PASSWORD=happy21 npm start      # http://localhost:3000  and  http://localhost:3000/host
npm test
```

Locally, everything is saved in `./data`.

## Deploy for free on Vercel (about 10 minutes)

1. Push this repo to GitHub, then on [vercel.com](https://vercel.com) choose **Add New → Project** and import it. Leave all build settings as they are.
2. In the project, open **Storage → Create → Blob**, choose **Private** access, and connect it to the project. This adds `BLOB_READ_WRITE_TOKEN` automatically.
3. In **Settings → Environment Variables**, add:
   - `HOST_PASSWORD`: the password you'll give Alain.
   - `SUBMIT_CODE` (optional): a code friends must type to submit, e.g. `WU`. Share it in the group chat with the link so random people can't post.
4. **Redeploy** (Deployments → ⋯ → Redeploy) so the variables take effect.
5. Send friends the main link. Send Alain `<your-link>/host` and the password.

If you created a *public* Blob store by mistake, also set `BLOB_ACCESS=public`. Blob names are random, so they still can't be guessed.

## How it's built

| Path | What |
| --- | --- |
| `public/index.html`, `submit.js` | Friend submission page |
| `public/host.html`, `host.js` | Alain's login and wall |
| `public/styles.css` | All styles. Fonts: Bricolage Grotesque and Caveat (handwriting) |
| `server.js` | One small request handler: API, static files, host auth (signed HttpOnly cookie) |
| `lib/storage.js` | Vercel Blob storage when deployed, local disk otherwise |
| `api/index.js` | Vercel entry point |

API: `POST /api/photo` (raw image, ≤4 MB, checked by file signature) → `{ref}`; `POST /api/submit` `{name, message, photos[], code?}`; `POST /api/host/login`; `GET /api/host/wall`; `DELETE /api/host/entry/:id`; `GET /media/:name` (host only).

## Changing settings later

Vercel only applies environment variable changes (like `HOST_PASSWORD` or `SUBMIT_CODE`) to new deploys. After changing one, either push any commit to `main` or click **Deployments → ⋯ → Redeploy** in Vercel.
