const $ = (s) => document.querySelector(s);
const form = $('#form');
const nameEl = $('#name');
const msgEl = $('#message');
const preview = $('#preview');
const previewFrom = $('#previewFrom');
const statusEl = $('#status');
const sendBtn = $('#send');
const filesEl = $('#files');
const drop = $('#drop');
const thumbs = $('#thumbs');

const MAX_PHOTOS = 8;
const MAX_EDGE = 1800;
const PLACEHOLDER = 'Happy 21st, Alain!…';
let photos = []; // { id, file, url, el }
let codeRequired = false;

// ---------- hero ticker ----------
const lines = [
  'makes everyone feel seen',
  'knows the WU staff by name',
  'turns strangers into friends',
  'introduces everyone to everyone',
  'always finds the bright side',
  'keeps God first',
  'makes the whole room laugh',
  'makes you feel at home',
];
const swap = $('#swap');
let li = 0;
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  setInterval(() => {
    swap.classList.add('out');
    setTimeout(() => { li = (li + 1) % lines.length; swap.textContent = lines[li]; swap.classList.remove('out'); }, 350);
  }, 2600);
}

// ---------- reveal on scroll ----------
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .2 });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

// ---------- config ----------
fetch('/api/config').then((r) => r.json()).then((c) => {
  codeRequired = c.codeRequired;
  $('#codeField').hidden = !codeRequired;
}).catch(() => {});

// ---------- live preview ----------
function renderPreview() {
  const text = msgEl.value.trim();
  preview.firstChild.nodeValue = text || PLACEHOLDER;
  preview.classList.toggle('empty', !text);
  previewFrom.textContent = nameEl.value.trim() || 'you';
  $('#count').textContent = msgEl.value.length;
}
msgEl.addEventListener('input', renderPreview);
nameEl.addEventListener('input', renderPreview);

document.querySelectorAll('.spark').forEach((b) => b.addEventListener('click', () => {
  const t = b.dataset.text;
  msgEl.value = msgEl.value.trim() ? `${msgEl.value.replace(/\s*$/, '')}\n\n${t}` : t;
  msgEl.focus();
  msgEl.setSelectionRange(msgEl.value.length, msgEl.value.length);
  renderPreview();
}));

// ---------- photos ----------
function addFiles(list) {
  const imgs = [...list].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  for (const file of imgs) {
    if (photos.length >= MAX_PHOTOS) { setStatus(`Up to ${MAX_PHOTOS} photos per note. Send this one, then add more!`, true); break; }
    const p = { id: crypto.randomUUID(), file, url: URL.createObjectURL(file) };
    const el = document.createElement('div');
    el.className = 'thumb';
    const img = document.createElement('img');
    img.alt = '';
    img.src = p.url;
    img.onerror = () => { img.remove(); el.classList.add('heic'); };
    const x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', 'Remove photo');
    x.textContent = '×';
    x.onclick = () => { photos = photos.filter((q) => q !== p); URL.revokeObjectURL(p.url); el.remove(); };
    el.append(img, x);
    p.el = el;
    thumbs.append(el);
    photos.push(p);
  }
}
filesEl.addEventListener('change', () => { addFiles(filesEl.files); filesEl.value = ''; });
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

// Shrink big phone photos to <= 1800px JPEG so uploads are quick and fit the server limit.
async function shrink(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    // Some browsers can only decode via <img> (and some formats, like HEIC on Chrome, not at all).
    bmp = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error(`“${file.name}” is a format this browser can't open. Try a screenshot or a JPG.`));
      i.src = URL.createObjectURL(file);
    });
  }
  const w = bmp.width || bmp.naturalWidth;
  const h = bmp.height || bmp.naturalHeight;
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.86));
}

async function api(path, init) {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function setStatus(text, err = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('err', err);
}

// ---------- submit ----------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = nameEl.value.trim();
  const message = msgEl.value.trim();
  const code = $('#code').value.trim();
  if (!name) { setStatus('Add your name so Alain knows who it is from.', true); nameEl.focus(); return; }
  if (!message && !photos.length) { setStatus('Write a note or add a photo (or both!).', true); msgEl.focus(); return; }
  if (codeRequired && !code) { setStatus('Add the birthday code from the group chat.', true); $('#code').focus(); return; }

  sendBtn.disabled = true;
  try {
    const refs = [];
    for (const [i, p] of photos.entries()) {
      setStatus(`Uploading photo ${i + 1} of ${photos.length}…`);
      p.el.classList.add('busy');
      p.el.classList.remove('failed');
      try {
        p.ref ??= (await api('/api/photo', {
          method: 'POST',
          headers: { 'Content-Type': 'image/jpeg', 'X-Submit-Code': code },
          body: await shrink(p.file),
        })).ref;
      } catch (err) {
        p.el.classList.add('failed');
        throw err;
      } finally {
        p.el.classList.remove('busy');
      }
      refs.push(p.ref);
    }
    setStatus('Sending your note…');
    await api('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, message, photos: refs, code, website: $('#website').value }),
    });
    setStatus('');
    $('#composeView').hidden = true;
    $('#doneView').hidden = false;
    $('#write').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    sendBtn.disabled = false;
  }
});

$('#again').addEventListener('click', () => {
  msgEl.value = '';
  photos.forEach((p) => URL.revokeObjectURL(p.url));
  photos = [];
  thumbs.replaceChildren();
  renderPreview();
  $('#doneView').hidden = true;
  $('#composeView').hidden = false;
  msgEl.focus();
});

renderPreview();
