const $ = (s) => document.querySelector(s);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const NOTE_COLORS = ['var(--note-1)', 'var(--note-2)', 'var(--note-3)', 'var(--note-4)', 'var(--note-5)'];
const SLIDE_MS = 6500;

let entries = [];
let items = [];    // [{ kind: 'note'|'photo', entry, src? }]
let visible = [];  // items after the filter
let filter = 'all';
let current = -1;
let playing = false;
let timer = null;

// Small deterministic random so each card keeps its look between renders.
function seeded(str) {
  let h = 2166136261;
  for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
}
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

async function api(path, init) {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
  return data;
}

// ---------------- gate ----------------
function showGate() {
  $('#gate').hidden = false;
  $('#intro').hidden = $('#wallSection').hidden = $('#logout').hidden = true;
  $('#pw').focus();
}

$('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = $('#loginStatus');
  s.textContent = 'Checking…';
  s.classList.remove('err');
  try {
    await api('/api/host/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) });
    s.textContent = '';
    $('#pw').value = '';
    await load();
  } catch (err) {
    s.textContent = err.message;
    s.classList.add('err');
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/host/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

// ---------------- load ----------------
async function load() {
  let data;
  try { data = await api('/api/host/wall'); }
  catch (err) { if (err.status === 401) return showGate(); throw err; }
  entries = data.entries;
  $('#gate').hidden = true;
  $('#logout').hidden = false;
  $('#intro').hidden = false;
  $('#wallSection').hidden = false;

  const people = new Set(entries.map((e) => e.name.trim().toLowerCase())).size;
  const notes = entries.filter((e) => e.message).length;
  const pics = entries.reduce((n, e) => n + e.photos.length, 0);
  const stats = $('#stats');
  stats.replaceChildren();
  const bit = (n, word) => { const b = document.createElement('b'); b.textContent = n; stats.append(b, ` ${word}${n === 1 ? '' : 's'}`); };
  if (!entries.length) stats.textContent = 'Your friends are still writing…';
  else { bit(people, 'friend'); stats.append(' · '); bit(notes, 'note'); stats.append(' · '); bit(pics, 'photo'); }

  // Notes and photos are separate cards so the wall feels like a real collage.
  items = [];
  for (const e of entries) {
    if (e.message) items.push({ kind: 'note', entry: e });
    for (const src of e.photos) items.push({ kind: 'photo', entry: e, src });
  }
  items = interleave(shuffle(items));
  render();
}

// Spread things out so two cards from the same friend rarely sit side by side.
function interleave(list) {
  const out = [];
  const pool = [...list];
  while (pool.length) {
    const last = out[out.length - 1];
    const prevKind = last?.kind;
    let i = pool.findIndex((it) => it.entry.id !== last?.entry.id && (pool.length < 3 || it.kind !== prevKind || Math.random() < .35));
    if (i < 0) i = 0;
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

// ---------------- render wall ----------------
function noteEl(entry, { clamp = false } = {}) {
  const rnd = seeded(entry.id);
  const n = document.createElement('div');
  n.className = 'note';
  n.style.setProperty('--bg', NOTE_COLORS[Math.floor(rnd() * NOTE_COLORS.length)]);
  n.style.setProperty('--tilt', `${(rnd() * 5 - 2.5).toFixed(2)}deg`);
  n.append(document.createTextNode(entry.message));
  const from = document.createElement('span');
  from.className = 'from';
  from.textContent = entry.name;
  n.append(from);
  if (clamp && entry.message.length > 420) n.classList.add('long');
  return n;
}

function photoEl(item) {
  const rnd = seeded(item.src);
  const f = document.createElement('figure');
  f.className = 'polaroid';
  f.style.setProperty('--tilt', `${(rnd() * 6 - 3).toFixed(2)}deg`);
  const img = document.createElement('img');
  img.src = item.src;
  img.alt = `Alain with ${item.entry.name}`;
  img.loading = 'lazy';
  img.decoding = 'async';
  const cap = document.createElement('figcaption');
  cap.textContent = `you + ${item.entry.name}`;
  f.append(img, cap);
  return f;
}

const cardObserver = new IntersectionObserver((es) => es.forEach((e) => {
  if (e.isIntersecting) { e.target.classList.add('in'); cardObserver.unobserve(e.target); }
}), { rootMargin: '0px 0px -40px 0px' });

function render() {
  visible = items.filter((it) => filter === 'all' || it.kind === filter);
  const wall = $('#wall');
  wall.replaceChildren();
  $('#emptyWall').hidden = visible.length > 0;
  visible.forEach((it, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'card';
    b.setAttribute('aria-label', it.kind === 'note' ? `Note from ${it.entry.name}` : `Photo with ${it.entry.name}`);
    b.append(it.kind === 'note' ? noteEl(it.entry, { clamp: true }) : photoEl(it));
    b.style.transitionDelay = `${(i % 6) * 60}ms`;
    b.addEventListener('click', () => openAt(i));
    wall.append(b);
    if (reduceMotion) b.classList.add('in'); else cardObserver.observe(b);
  });
}

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  filter = b.dataset.filter;
  document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  render();
}));
$('#shuffle').addEventListener('click', () => { items = interleave(shuffle(items)); render(); });
$('#play').addEventListener('click', () => { if (visible.length) { openAt(0); setPlaying(true); } });

$('#open').addEventListener('click', () => {
  confetti();
  setTimeout(() => $('#wallSection').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' }), 350);
});

// ---------------- lightbox ----------------
const lb = $('#lightbox');
const progress = document.createElement('div');
progress.className = 'lb-progress';
lb.append(progress);

function openAt(i) {
  if (!lb.open) lb.showModal();
  show(i);
}

function show(i) {
  if (!visible.length) return closeLb();
  current = (i + visible.length) % visible.length;
  const it = visible[current];
  const body = $('#lbBody');
  body.replaceChildren();
  body.classList.toggle('solo', it.kind === 'note' && !it.entry.photos.length);
  $('#lbCount').textContent = `${current + 1} / ${visible.length}`;

  if (it.kind === 'photo' || it.entry.photos.length) {
    const src = it.kind === 'photo' ? it.src : it.entry.photos[0];
    const wrap = document.createElement('div');
    wrap.className = 'lb-photo';
    const img = document.createElement('img');
    img.src = src;
    img.alt = `Alain with ${it.entry.name}`;
    wrap.append(img);
    body.append(wrap);

    const side = document.createElement('div');
    side.className = 'lb-side';
    const who = document.createElement('p');
    who.className = 'lb-who';
    const small = document.createElement('small');
    small.textContent = 'From';
    who.append(small, it.entry.name);
    side.append(who);
    if (it.entry.message) side.append(noteEl(it.entry));
    if (it.entry.photos.length > 1) {
      const strip = document.createElement('div');
      strip.className = 'lb-strip';
      for (const p of it.entry.photos) {
        const t = document.createElement('button');
        t.type = 'button';
        t.setAttribute('aria-label', 'Show this photo');
        t.setAttribute('aria-current', String(p === src));
        const ti = document.createElement('img');
        ti.src = p;
        ti.alt = '';
        t.append(ti);
        t.addEventListener('click', () => {
          const j = visible.findIndex((v) => v.kind === 'photo' && v.src === p);
          if (j >= 0) show(j);
          else { img.src = p; strip.querySelectorAll('button').forEach((x) => x.setAttribute('aria-current', String(x === t))); }
        });
        strip.append(t);
      }
      side.append(strip);
    }
    body.append(side);
  } else {
    body.append(noteEl(it.entry));
  }
  if (playing) restartTimer();
}

function closeLb() { setPlaying(false); if (lb.open) lb.close(); }

function setPlaying(on) {
  playing = on;
  $('#lbPlay').textContent = on ? '❚❚' : '▶';
  $('#lbPlay').setAttribute('aria-label', on ? 'Pause slideshow' : 'Play slideshow');
  clearTimeout(timer);
  progress.classList.remove('run');
  if (on) restartTimer();
}
function restartTimer() {
  clearTimeout(timer);
  progress.classList.remove('run');
  void progress.offsetWidth; // restart the CSS animation
  progress.style.animationDuration = `${SLIDE_MS}ms`;
  progress.classList.add('run');
  timer = setTimeout(() => show(current + 1), SLIDE_MS);
}

$('#lbPrev').addEventListener('click', () => show(current - 1));
$('#lbNext').addEventListener('click', () => show(current + 1));
$('#lbClose').addEventListener('click', closeLb);
$('#lbPlay').addEventListener('click', () => setPlaying(!playing));
lb.addEventListener('close', () => setPlaying(false));
lb.addEventListener('click', (e) => { if (e.target === lb || e.target === $('#lbBody')) closeLb(); });
document.addEventListener('keydown', (e) => {
  if (!lb.open) return;
  if (e.key === 'ArrowRight') show(current + 1);
  else if (e.key === 'ArrowLeft') show(current - 1);
  else if (e.key === ' ' && e.target === document.body) { e.preventDefault(); setPlaying(!playing); }
});
// swipe on phones
let touchX = null;
lb.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
lb.addEventListener('touchend', (e) => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 50) show(current + (dx < 0 ? 1 : -1));
  touchX = null;
});

$('#lbHide').addEventListener('click', async () => {
  const it = visible[current];
  if (!it) return;
  const what = it.entry.photos.length ? 'their note and all their photos' : 'their note';
  if (!confirm(`Remove ${it.entry.name}'s submission (${what}) from your wall for good?`)) return;
  try {
    await api(`/api/host/entry/${it.entry.id}`, { method: 'DELETE' });
    items = items.filter((x) => x.entry.id !== it.entry.id);
    entries = entries.filter((x) => x.id !== it.entry.id);
    render();
    show(Math.min(current, visible.length - 1));
  } catch (err) { alert(err.message); }
});

// ---------------- confetti ----------------
function confetti() {
  if (reduceMotion) return;
  const c = $('#confetti');
  const ctx = c.getContext('2d');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  c.width = innerWidth * dpr;
  c.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const colors = ['#1d4ed8', '#ff5b2e', '#ffd23f', '#15130f', '#7cc6fe', '#ff9fb2'];
  const parts = Array.from({ length: 180 }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * 200,
    y: innerHeight * .55,
    vx: (Math.random() - .5) * 18,
    vy: -Math.random() * 18 - 8,
    w: 6 + Math.random() * 8,
    h: 8 + Math.random() * 10,
    r: Math.random() * Math.PI,
    vr: (Math.random() - .5) * .35,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += .45; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
      ctx.restore();
    }
    if (t - start < 3200) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })(start);
}

load().catch((err) => {
  showGate();
  $('#loginStatus').textContent = err.message;
});
