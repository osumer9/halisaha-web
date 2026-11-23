'use strict';

const API = (window.HALISAHA_CONFIG?.apiUrl || '').replace(/\/$/, '');
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const state = {
  matches: [],
  tab: 'upcoming',
  unlocked: new Map(),  // maç id -> { data, key, proof, revision }
  views: new Map(),     // maç id -> 'pitch' | 'list'
  pendingId: null,
  sheet: null,          // açık oyuncu penceresi: { mid, pid }
  busy: false,
  loadError: ''
};

const TEAMS = {
  A: { label: 'Takım A', emoji: '🟠' },
  B: { label: 'Takım B', emoji: '🔵' },
  bench: { label: 'Bekleyenler', emoji: '⏳' }
};

// ---------- Yardımcılar ----------
const enc = new TextEncoder(), dec = new TextDecoder();
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bytesToB64 = arr => btoa(String.fromCharCode(...arr));
const b64ToBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const money = v => new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 0 }).format(v);
const when = m => new Date(m.dateTime);
const isPast = m => when(m).getTime() < Date.now();
const fmt = (d, o) => d.toLocaleString('tr-TR', o);
const clock = d => fmt(d, { hour: '2-digit', minute: '2-digit' });
const longDay = d => fmt(d, { day: 'numeric', month: 'long', weekday: 'long' });
const byDate = (a, b) => a.dateTime.localeCompare(b.dateTime);
const findMatch = id => state.matches.find(m => m.id === id);
// Takım listesi: kaleci her zaman en üstte.
const teamOf = (d, team) => d.players.filter(p => p.team === team).sort((a, b) => Number(!!b.goalkeeper) - Number(!!a.goalkeeper));

// Saha ücreti kapasiteye değil kayıtlı oyuncu sayısına bölünür; ücret eksik kalmasın diye yukarı yuvarlanır.
function priceText(d) {
  if (!(d.price > 0)) return '';
  const n = d.players.length;
  return n ? `Kişi başı ${money(Math.ceil(d.price / n))}` : `Saha ücreti ${money(d.price)}`;
}

// ---------- Diziliş ----------
// Her saha oyuncusunun bir mevkisi var: D (defans), M (orta saha), F (forvet).
// Takımın dizilişi bu sayılardan oluşur; hazır diziliş seçilince mevkiler sırayla yeniden dağıtılır.
const LINES = ['D', 'M', 'F'];
const LINE_NAMES = { D: 'Defans', M: 'Orta saha', F: 'Forvet' };
const PRESETS = {
  1: [[0, 1, 0]],
  2: [[1, 0, 1]],
  3: [[1, 1, 1], [2, 0, 1], [1, 0, 2]],
  4: [[2, 1, 1], [1, 2, 1], [2, 0, 2], [1, 1, 2]],
  5: [[2, 2, 1], [3, 1, 1], [2, 1, 2], [1, 3, 1], [1, 2, 2]],
  6: [[3, 2, 1], [2, 3, 1], [3, 1, 2], [2, 2, 2], [1, 3, 2]],
  7: [[3, 3, 1], [3, 2, 2], [2, 3, 2], [3, 1, 3], [2, 4, 1]],
  8: [[3, 4, 1], [4, 3, 1], [3, 3, 2], [4, 2, 2], [3, 2, 3]],
  9: [[4, 4, 1], [3, 4, 2], [4, 3, 2], [3, 3, 3], [4, 2, 3]],
  10: [[4, 4, 2], [4, 3, 3], [3, 5, 2], [4, 5, 1], [3, 4, 3]]
};
const shapeKey = shape => shape.join('-');
// Orta sahasız dizilişler kısaca yazılır (2-0-1 → 2-1); diğer boş hatlar karışmasın diye 0 olarak kalır.
const shapeLabel = ([back, mid, front]) => (mid === 0 && back > 0 && front > 0 ? `${back}-${front}` : [back, mid, front].join('-'));

function presetsFor(n) {
  if (n < 1) return [];
  if (PRESETS[n]) return PRESETS[n];
  const back = Math.ceil(n * 0.4), front = Math.max(1, Math.round(n * 0.2));
  return [[back, n - back - front, front]];
}

// Takımı kaleci + üç hatta ayırır. Mevkisi olmayan (yeni gelen ya da eski kayıtlı) oyuncular
// varsayılan dizilişte en çok eksiği olan hatta yerleşir.
function lineup(d, team) {
  const people = d.players.filter(p => p.team === team);
  const gk = people.find(p => p.goalkeeper);
  const outfield = people.filter(p => p !== gk);
  const lines = { D: [], M: [], F: [] };
  const loose = [];
  for (const p of outfield) (LINES.includes(p.pos) ? lines[p.pos] : loose).push(p);
  const target = presetsFor(outfield.length)[0] || [0, 0, 0];
  const gap = k => target[LINES.indexOf(k)] - lines[k].length;
  for (const p of loose) lines[LINES.reduce((best, k) => (gap(k) > gap(best) ? k : best), 'M')].push(p);
  return { gk, lines, shape: LINES.map(k => lines[k].length) };
}

const orderedTeam = (d, team) => {
  if (team === 'bench') return teamOf(d, 'bench');
  const { gk, lines } = lineup(d, team);
  return [...(gk ? [gk] : []), ...LINES.flatMap(k => lines[k])];
};

// Kaydetmeden önce mevkiler sabitlenir: takımdaki herkesin bir hattı olur, bekleyen ve kalecilerde mevki tutulmaz.
function settle(d) {
  for (const p of d.players) if (p.team === 'bench' || p.goalkeeper) delete p.pos;
  for (const t of ['A', 'B']) {
    const { lines } = lineup(d, t);
    for (const k of LINES) for (const p of lines[k]) p.pos = k;
  }
}

function dayLabel(d) {
  const midnight = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((midnight(d) - midnight(new Date())) / 864e5);
  if (diff === 0) return 'Bugün';
  if (diff === 1) return 'Yarın';
  if (diff > 1 && diff < 7) return fmt(d, { weekday: 'long' });
  return fmt(d, { day: 'numeric', month: 'long' });
}

let toastTimer;
function toast(message, kind = 'success') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 6000 : 3200);
}

// Açık bir pencere varsa hata onun içinde, yoksa alttaki bildirimde gösterilir.
function showError(message) {
  const slot = $$('dialog').find(d => d.open)?.querySelector('.dialog-error');
  if (slot) { slot.textContent = message; slot.hidden = false; }
  else toast(message, 'error');
}

function openDialog(id) {
  const d = document.getElementById(id);
  const err = d.querySelector('.dialog-error');
  if (err) err.hidden = true;
  d.showModal();
}
const closeDialog = id => document.getElementById(id).close();

function setBusy(flag) {
  state.busy = flag;
  $$('.modal button[type=submit], #newMatchButton, #playerDialog button, #playerDialog input').forEach(b => { b.disabled = flag; });
}

async function run(task, onFail) {
  if (state.busy) return;
  setBusy(true);
  try { await task(); }
  catch (err) { onFail?.(); showError(err.message); }
  finally { setBusy(false); }
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* aşağıdaki yönteme düş */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* yok */ }
  ta.remove();
  if (!ok) throw Error('Kopyalanamadı. Liste görünümünden elle seçip kopyalayabilirsin.');
}

// ---------- Sunucu ve şifreleme ----------
async function request(path, options = {}) {
  const r = await fetch(API + path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  let body;
  try { body = await r.json(); } catch { throw Error('Sunucu beklenmeyen yanıt verdi.'); }
  if (!r.ok) { const e = Error(body.error || `İstek hatası (${r.status})`); e.status = r.status; throw e; }
  return body;
}

async function derive(password, salt) {
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: b64ToBytes(salt), iterations: 250000, hash: 'SHA-256' }, material, 512));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const proof = bytesToB64(bits.slice(32));
  const verifier = bytesToB64(new Uint8Array(await crypto.subtle.digest('SHA-256', bits.slice(32))));
  return { key, proof, verifier };
}

async function encryptData(data, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data)));
  return { iv: bytesToB64(iv), ciphertext: bytesToB64(new Uint8Array(ct)) };
}

async function decryptData(payload, key) {
  const result = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(payload.iv) }, key, b64ToBytes(payload.ciphertext));
  return JSON.parse(dec.decode(result));
}

async function loadMatches() {
  if (!API) { state.loadError = 'Kurulum eksik: config.js içine Worker adresini gir.'; render(); return; }
  try {
    const data = await request('/matches');
    state.matches = data.matches || [];
    state.loadError = '';
  } catch (e) {
    state.loadError = e.message;
    if (state.matches.length) toast(e.message, 'error');
  }
  render();
}

async function refreshUnlocked() {
  for (const [id, u] of state.unlocked) {
    const fresh = await request(`/matches/${id}`);
    if (fresh.revision !== u.revision) {
      u.data = await decryptData(fresh.record.payload, u.key);
      u.revision = fresh.revision;
    }
  }
}

async function unlock(id, password) {
  const server = await request(`/matches/${id}`);
  const derived = await derive(password, server.record.salt);
  let data;
  try { data = await decryptData(server.record.payload, derived.key); }
  catch { throw Error('Şifre yanlış.'); }
  state.unlocked.set(id, { data, key: derived.key, proof: derived.proof, revision: server.revision });
  location.hash = `mac=${id}`;
  render();
}

async function save(id, change) {
  const u = state.unlocked.get(id);
  if (!u) throw Error('Önce maçı aç.');
  const next = structuredClone(u.data);
  change(next);
  const meta = findMatch(id);
  if (next.players.length > meta.capacity) throw Error('Kadro dolu.');
  for (const t of ['A', 'B']) {
    if (next.players.filter(x => x.team === t && x.goalkeeper).length > 1) throw Error(`${TEAMS[t].label} kalesinde zaten bir kaleci var.`);
  }
  settle(next);
  const payload = await encryptData(next, u.key);
  try {
    const response = await request(`/matches/${id}`, { method: 'PUT', body: JSON.stringify({ proof: u.proof, revision: u.revision, payload }) });
    u.data = next;
    u.revision = response.revision;
    render();
  } catch (e) {
    if (e.status === 409 || e.message.includes('güncellendi')) {
      const fresh = await request(`/matches/${id}`);
      u.data = await decryptData(fresh.record.payload, u.key);
      u.revision = fresh.revision;
      render();
      throw Error('Bu sırada başka biri kadroyu değiştirdi. Güncel hali yüklendi, tekrar dene.');
    }
    throw e;
  }
}

// ---------- Kadro işlemleri ----------
async function addPlayer(id, name, goalkeeper) {
  const u = state.unlocked.get(id);
  if (!name) throw Error('Adını yaz.');
  if (u.data.players.some(p => p.name.toLocaleLowerCase('tr-TR') === name.toLocaleLowerCase('tr-TR'))) throw Error('Bu isim zaten kadroda.');
  let team = 'bench';
  await save(id, d => {
    team = goalkeeper ? (['A', 'B'].find(t => !d.players.some(p => p.team === t && p.goalkeeper)) || 'bench') : 'bench';
    d.players.push({ id: crypto.randomUUID(), name, goalkeeper, team });
  });
  return team;
}

// pos verilmezse oyuncu yeni takımında boşluğu olan hatta yerleşir.
async function movePlayer(id, playerId, team, pos) {
  await save(id, d => {
    const p = d.players.find(x => x.id === playerId);
    if (!p) throw Error('Oyuncu bulunamadı.');
    if (pos) p.pos = pos;
    else if (p.team !== team) delete p.pos;
    p.team = team;
  });
}

async function applyFormation(id, team, shape) {
  await save(id, d => {
    const { lines } = lineup(d, team);
    const ordered = LINES.flatMap(k => lines[k]);
    if (ordered.length !== shape.reduce((a, b) => a + b, 0)) throw Error('Kadro bu sırada değişti, tekrar dene.');
    let i = 0;
    LINES.forEach((k, li) => { for (let c = 0; c < shape[li]; c++) ordered[i++].pos = k; });
  });
}

// Kalecilik değişince oyuncu takımdaysa bekleyenlere alınır; takımlar elle yeniden dengelenir.
async function setGoalkeeper(id, playerId, on) {
  const result = { moved: false, name: '' };
  await save(id, d => {
    const p = d.players.find(x => x.id === playerId);
    if (!p) throw Error('Oyuncu bulunamadı.');
    result.name = p.name;
    p.goalkeeper = on;
    if (p.team !== 'bench') { p.team = 'bench'; result.moved = true; }
  });
  return result;
}

async function removePlayer(id, playerId) {
  await save(id, d => { d.players = d.players.filter(p => p.id !== playerId); });
}

function whatsappText(meta, d) {
  const dt = when(meta);
  const n = d.players.length;
  const missing = meta.capacity - n;
  const lines = [`⚽ *${meta.place}*`, `📅 ${longDay(dt)}, ${clock(dt)}`];
  if (d.price > 0) lines.push(`💸 ${priceText(d)}${n ? ` (toplam ${money(d.price)})` : ''}`);
  lines.push(`👥 ${n}/${meta.capacity}${missing > 0 ? ` (${missing} kişi eksik)` : ', kadro tamam'}`);
  if (d.notes) lines.push(`📝 ${d.notes}`);
  for (const t of ['A', 'B', 'bench']) {
    const people = orderedTeam(d, t);
    if (t === 'bench' && !people.length) continue;
    const shape = t === 'bench' ? '' : shapeLabel(lineup(d, t).shape);
    lines.push('', `${TEAMS[t].emoji} *${TEAMS[t].label}* (${people.length})${shape ? ` · ${shape}` : ''}`);
    if (!people.length) lines.push('—');
    people.forEach((p, i) => lines.push(`${i + 1}. ${p.name}${p.goalkeeper ? ' 🧤' : ''}`));
  }
  return lines.join('\n');
}

// ---------- Çizim ----------
function render() {
  const upcoming = state.matches.filter(m => !isPast(m)).sort(byDate);
  const past = state.matches.filter(isPast).sort((a, b) => byDate(b, a));
  $('#upcomingCount').textContent = upcoming.length;
  $('#pastCount').textContent = past.length;
  $$('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === state.tab)));
  renderNext(upcoming[0]);
  const items = state.tab === 'upcoming' ? upcoming : past;
  $('#matchList').innerHTML = items.length ? items.map(cardHtml).join('') : emptyHtml();
}

function renderNext(next) {
  const el = $('#nextMatch');
  if (!next) {
    el.innerHTML = state.loadError ? '' : '<span class="next-empty">Sırada maç yok. İlk maçı sen kur.</span>';
    return;
  }
  const d = when(next);
  el.innerHTML = `<button type="button" class="next" data-action="next" data-id="${esc(next.id)}"><span class="next-when">${esc(dayLabel(d))} ${esc(clock(d))}</span><span class="next-place">${esc(next.place)}</span><span class="next-lead">sıradaki maç</span></button>`;
}

function emptyHtml() {
  if (state.loadError) return `<div class="empty"><strong>Maçlar yüklenemedi</strong><p>${esc(state.loadError)}</p>${API ? '<button class="btn" data-action="reload">Tekrar dene</button>' : ''}</div>`;
  if (state.tab === 'past') return '<div class="empty"><strong>Geçmiş maç yok</strong><p>Oynanan maçlar burada birikir.</p></div>';
  return '<div class="empty"><strong>Planlanmış maç yok</strong><p>Maçı kur, bağlantıyı gruba at, herkes kendini yazsın.</p><button class="btn primary" data-action="new">+ Maç ekle</button></div>';
}

function cardHtml(meta) {
  const u = state.unlocked.get(meta.id);
  const d = u?.data;
  const id = esc(meta.id);
  const dt = when(meta);
  const n = d ? d.players.length : 0;
  const missing = meta.capacity - n;
  const status = d
    ? `<div class="count"><b>${n}</b>/${meta.capacity}</div><small class="${missing > 0 ? 'missing' : 'full'}">${missing > 0 ? `${missing} kişi eksik` : 'Kadro tamam'}</small>`
    : `<button class="btn primary" data-action="unlock" data-id="${id}">🔒 Maçı aç</button>`;
  return `<article class="match${d ? ' open' : ''}${isPast(meta) ? ' past' : ''}" id="mac-${id}">
    <div class="match-top">
      <div class="date"><b>${dt.getDate()}</b><span>${esc(fmt(dt, { month: 'short' }))}</span></div>
      <div class="info">
        <h3>${esc(meta.place)}</h3>
        <p class="when"><span>${esc(fmt(dt, { weekday: 'long' }))}, ${esc(clock(dt))}</span>${d && d.price > 0 ? `<span class="price">${priceText(d)}</span>` : ''}${d ? '' : `<span>${meta.capacity} kişilik</span>`}</p>
        ${d?.notes ? `<p class="notes">${esc(d.notes)}</p>` : ''}
        ${d ? `<button type="button" class="edit-link" data-action="edit" data-id="${id}">${d.notes ? 'Açıklamayı düzenle' : 'Açıklama ekle'}</button>` : ''}
      </div>
      <div class="status">${status}</div>
    </div>
    ${d ? `<div class="fill"><i style="width:${Math.min(100, (n / meta.capacity) * 100)}%"></i></div>${boardHtml(meta, d)}` : ''}
  </article>`;
}

function boardHtml(meta, d) {
  const id = esc(meta.id);
  const view = state.views.get(meta.id) || 'pitch';
  const full = d.players.length >= meta.capacity;
  const tab = (v, label) => `<button role="tab" aria-selected="${view === v}" data-action="view" data-view="${v}" data-id="${id}">${label}</button>`;
  const join = isPast(meta) ? '' : `<button class="btn primary" data-action="join" data-id="${id}" ${full ? 'disabled' : ''}>${full ? 'Kadro dolu' : '+ Kadroya yazıl'}</button>`;
  return `<div class="board">
    <div class="board-head">
      <div class="switch" role="tablist" aria-label="Görünüm">${tab('pitch', 'Saha')}${tab('list', 'Liste')}</div>
      <div class="score" aria-label="Takım sayıları"><span class="tag a">A</span>${teamOf(d, 'A').length}<i>:</i>${teamOf(d, 'B').length}<span class="tag b">B</span></div>
    </div>
    ${view === 'pitch' ? pitchHtml(id, d) : rosterHtml(d)}
    <div class="board-actions">
      ${join}
      <button class="btn" data-action="copy" data-id="${id}">📋 Listeyi kopyala</button>
      <button class="btn" data-action="share" data-id="${id}">🔗 Bağlantıyı paylaş</button>
    </div>
  </div>`;
}

function chipHtml(mid, p) {
  const cls = p.team === 'A' ? 'a' : p.team === 'B' ? 'b' : 'bench';
  return `<div class="chip ${cls}${p.goalkeeper ? ' gk' : ''}" role="button" tabindex="0" draggable="true" data-action="player" data-id="${mid}" data-player="${esc(p.id)}" title="${esc(p.name)}">${p.goalkeeper ? '<span aria-label="Kaleci">🧤</span>' : ''}<span class="nm">${esc(p.name)}</span></div>`;
}

// Saha yarısı: ceza sahasında kaleci, sonra kaleden orta çizgiye defans, orta saha, forvet hatları.
function halfHtml(mid, d, team) {
  const { gk, lines, shape } = lineup(d, team);
  const empty = shape.every(x => x === 0);
  const line = k => {
    const chips = lines[k].map(p => chipHtml(mid, p)).join('') || (empty && k === 'M' ? '<span class="empty-mini">Oyuncu yok</span>' : '');
    return `<div class="line${chips ? '' : ' is-empty'}" data-drop-team="${team}" data-drop-pos="${k}" data-id="${mid}" title="${LINE_NAMES[k]}">${chips}</div>`;
  };
  return `<div class="half ${team.toLowerCase()}" data-drop-team="${team}" data-id="${mid}">
    <div class="box">${gk ? chipHtml(mid, gk) : '<span class="gk-empty"><b>🧤</b>Kaleci yok</span>'}</div>
    ${LINES.map(line).join('')}
  </div>`;
}

function formationHtml(mid, d, team) {
  const { shape } = lineup(d, team);
  const n = shape.reduce((a, b) => a + b, 0);
  const presets = presetsFor(n);
  const current = shapeKey(shape);
  const isPreset = presets.some(s => shapeKey(s) === current);
  const options = isPreset ? presets : [...presets, shape];
  const title = `<span>${team} dizilişi</span>`;
  const cls = `formation ${team.toLowerCase()}`;
  if (options.length < 2) return `<div class="${cls}">${title}<b>${n ? shapeLabel(shape) : '—'}</b></div>`;
  return `<label class="${cls}">${title}<select data-formation="${team}" data-id="${mid}">${options.map(s => `<option value="${shapeKey(s)}"${shapeKey(s) === current ? ' selected' : ''}>${s === shape && !isPreset ? shapeKey(s) : shapeLabel(s)}</option>`).join('')}</select></label>`;
}

function pitchHtml(mid, d) {
  const bench = teamOf(d, 'bench');
  return `<div class="pitch">${halfHtml(mid, d, 'A')}${halfHtml(mid, d, 'B')}</div>
    <div class="formations">${formationHtml(mid, d, 'A')}${formationHtml(mid, d, 'B')}</div>
    <div class="bench-row" data-drop-team="bench" data-id="${mid}">
      <span class="label">Bekleyenler<b>${bench.length}</b></span>
      <div class="bench-list">${bench.map(p => chipHtml(mid, p)).join('')}</div>
    </div>
    <p class="hint-line">Oyuncuya dokun: takımını ya da mevkisini değiştir, kaleci yap.</p>`;
}

function rosterHtml(d) {
  const cols = ['A', 'B', 'bench'].map(t => ({ t, people: orderedTeam(d, t) })).filter(c => c.t !== 'bench' || c.people.length);
  return `<div class="roster">${cols.map(({ t, people }) => `<section class="roster-col ${t === 'bench' ? 'bench' : t.toLowerCase()}">
      <h4>${TEAMS[t].label}<span>${people.length}${t !== 'bench' && shapeLabel(lineup(d, t).shape) ? ` · ${shapeLabel(lineup(d, t).shape)}` : ''}</span></h4>
      ${people.length ? `<ol>${people.map(p => `<li>${esc(p.name)}${p.goalkeeper ? ' 🧤' : ''}</li>`).join('')}</ol>` : '<p class="muted">Henüz kimse yok</p>'}
    </section>`).join('')}</div>`;
}

// ---------- Pencereler ----------
function openNewMatch() {
  const f = $('#matchForm');
  f.reset();
  const dt = new Date(Date.now() + 864e5);
  f.elements.date.value = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  f.elements.time.value = '21:00';
  openDialog('matchDialog');
}

function openUnlock(id) {
  state.pendingId = id;
  const m = findMatch(id);
  const dt = m && when(m);
  $('#unlockInfo').textContent = m ? `${m.place}, ${longDay(dt)} ${clock(dt)}` : '';
  $('#unlockForm').reset();
  openDialog('unlockDialog');
}

function openJoin(id) {
  state.pendingId = id;
  $('#joinInfo').textContent = findMatch(id)?.place || '';
  $('#joinForm').reset();
  openDialog('joinDialog');
}

function openEdit(id) {
  const d = state.unlocked.get(id)?.data;
  if (!d) return;
  state.pendingId = id;
  const f = $('#editForm');
  $('#editInfo').textContent = findMatch(id)?.place || '';
  f.elements.notes.value = d.notes || '';
  f.elements.price.value = d.price || 0;
  openDialog('editDialog');
}

function openPlayer(mid, pid) {
  const p = state.unlocked.get(mid)?.data.players.find(x => x.id === pid);
  if (!p) return;
  state.sheet = { mid, pid };
  $('#playerName').textContent = p.name;
  $('#gkToggle').checked = !!p.goalkeeper;
  $('#gkHint').hidden = p.team === 'bench';
  $$('#playerDialog [data-team]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.team === p.team)));
  const onField = p.team !== 'bench' && !p.goalkeeper;
  $('#posWrap').hidden = !onField;
  if (onField) {
    const { lines } = lineup(state.unlocked.get(mid).data, p.team);
    const current = LINES.find(k => lines[k].includes(p));
    $$('#posWrap [data-pos]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pos === current)));
  }
  openDialog('playerDialog');
}

const actions = {
  new: () => openNewMatch(),
  reload: () => loadMatches(),
  unlock: id => openUnlock(id),
  join: id => openJoin(id),
  edit: id => openEdit(id),
  player: (id, el) => openPlayer(id, el.dataset.player),
  view: (id, el) => { state.views.set(id, el.dataset.view); render(); },
  next: id => {
    const m = findMatch(id);
    if (!m) return;
    if (state.tab !== 'upcoming') { state.tab = 'upcoming'; render(); }
    document.getElementById(`mac-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!state.unlocked.has(id)) openUnlock(id);
  },
  copy: async id => {
    try {
      await copyText(whatsappText(findMatch(id), state.unlocked.get(id).data));
      toast('Liste kopyalandı. WhatsApp grubuna yapıştırabilirsin.');
    } catch (err) { toast(err.message, 'error'); }
  },
  share: async id => {
    const url = `${location.origin}${location.pathname}#mac=${id}`;
    try {
      if (navigator.share) { await navigator.share({ title: 'Halı saha maçı', url }); return; }
      await copyText(url);
      toast('Bağlantı kopyalandı. Şifreyi ayrıca paylaş.');
    } catch (err) { if (err.name !== 'AbortError') toast(err.message, 'error'); }
  }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.closest('dialog') || state.busy) return;
  actions[el.dataset.action]?.(el.dataset.id, el);
});

document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.chip[role="button"]')) {
    e.preventDefault();
    e.target.click();
  }
});

$$('[data-close]').forEach(b => b.addEventListener('click', () => closeDialog(b.dataset.close)));
$$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d && !state.busy) d.close(); }));
$$('.tab').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); }));

$('#matchForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(e.currentTarget));
  if (v.password !== v.confirm) { showError('Şifreler aynı değil.'); return; }
  run(async () => {
    const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
    const derived = await derive(v.password, salt);
    const data = { price: Number(v.price), notes: v.notes.trim(), players: [] };
    const payload = await encryptData(data, derived.key);
    const res = await request('/matches', { method: 'POST', body: JSON.stringify({ place: v.place.trim(), dateTime: `${v.date}T${v.time}:00`, capacity: Number(v.capacity), salt, verifier: derived.verifier, payload, createCode: v.createCode || '' }) });
    closeDialog('matchDialog');
    await loadMatches();
    state.unlocked.set(res.id, { data, key: derived.key, proof: derived.proof, revision: res.revision });
    state.tab = 'upcoming';
    location.hash = `mac=${res.id}`;
    render();
    toast('Maç oluşturuldu. Bağlantıyı gruba atabilirsin.');
  });
});

$('#unlockForm').addEventListener('submit', e => {
  e.preventDefault();
  const password = e.currentTarget.elements.password.value;
  run(async () => {
    await unlock(state.pendingId, password);
    closeDialog('unlockDialog');
  });
});

$('#joinForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.currentTarget;
  run(async () => {
    const team = await addPlayer(state.pendingId, f.elements.name.value.trim(), f.elements.goalkeeper.checked);
    closeDialog('joinDialog');
    toast(team === 'bench' ? 'Kadroya yazıldın.' : `Kadroya yazıldın, ${TEAMS[team].label} kalesindesin.`);
  });
});

$('#editForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.currentTarget;
  const notes = f.elements.notes.value.trim();
  const price = Number(f.elements.price.value);
  run(async () => {
    await save(state.pendingId, d => { d.notes = notes; d.price = price; });
    closeDialog('editDialog');
    toast('Maç bilgileri kaydedildi.');
  });
});

$('#gkToggle').addEventListener('change', e => {
  const { mid, pid } = state.sheet;
  const on = e.target.checked;
  run(async () => {
    const { moved, name } = await setGoalkeeper(mid, pid, on);
    closeDialog('playerDialog');
    toast(`${name} ${on ? 'kaleci oldu' : 'artık kaleci değil'}${moved ? ', bekleyenlere alındı' : ''}.`);
  }, () => { e.target.checked = !on; });
});

$$('#playerDialog [data-team]').forEach(b => b.addEventListener('click', () => {
  const { mid, pid } = state.sheet;
  if (b.getAttribute('aria-pressed') === 'true') { closeDialog('playerDialog'); return; }
  run(async () => {
    await movePlayer(mid, pid, b.dataset.team);
    closeDialog('playerDialog');
  });
}));

$$('#playerDialog [data-pos]').forEach(b => b.addEventListener('click', () => {
  const { mid, pid } = state.sheet;
  if (b.getAttribute('aria-pressed') === 'true') { closeDialog('playerDialog'); return; }
  run(async () => {
    const p = state.unlocked.get(mid).data.players.find(x => x.id === pid);
    await movePlayer(mid, pid, p.team, b.dataset.pos);
    closeDialog('playerDialog');
  });
}));

$('#removePlayer').addEventListener('click', () => {
  const { mid, pid } = state.sheet;
  if (!confirm(`${$('#playerName').textContent} kadrodan çıkarılsın mı?`)) return;
  run(async () => {
    await removePlayer(mid, pid);
    closeDialog('playerDialog');
  });
});

$('#refreshButton').addEventListener('click', () => run(async () => {
  await refreshUnlocked();
  await loadMatches();
}));

// ---------- Sürükle bırak (masaüstü) ----------
let dragging = null;
const clearDrag = () => $$('.drag-over').forEach(x => x.classList.remove('drag-over'));
const list = $('#matchList');
list.addEventListener('dragstart', e => {
  const chip = e.target.closest('.chip[draggable]');
  if (!chip) return;
  dragging = { id: chip.dataset.id, player: chip.dataset.player };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', chip.textContent);
});
list.addEventListener('dragover', e => {
  const zone = e.target.closest('[data-drop-team]');
  if (!zone || !dragging) return;
  e.preventDefault();
  if (!zone.classList.contains('drag-over')) { clearDrag(); zone.classList.add('drag-over'); }
});
list.addEventListener('dragend', () => { dragging = null; clearDrag(); });
list.addEventListener('drop', e => {
  const zone = e.target.closest('[data-drop-team]');
  if (!zone || !dragging) return;
  e.preventDefault();
  clearDrag();
  const d = dragging;
  dragging = null;
  if (d.id !== zone.dataset.id) return;
  const data = state.unlocked.get(d.id)?.data;
  const p = data?.players.find(x => x.id === d.player);
  if (!p) return;
  const { dropTeam: team, dropPos: pos } = zone.dataset;
  if (p.team === team) {
    // Aynı takım içinde sadece başka bir hatta bırakılırsa mevki değişir.
    if (!pos || p.goalkeeper || team === 'bench') return;
    if (lineup(data, team).lines[pos].includes(p)) return;
  }
  run(() => movePlayer(d.id, d.player, team, p.goalkeeper ? undefined : pos));
});

list.addEventListener('change', e => {
  const select = e.target.closest('select[data-formation]');
  if (!select) return;
  const shape = select.value.split('-').map(Number);
  run(() => applyFormation(select.dataset.id, select.dataset.formation, shape), () => render());
});

// ---------- Başlangıç ----------
(async () => {
  await loadMatches();
  const id = location.hash.match(/^#mac=([a-f0-9-]{36})$/)?.[1];
  const m = id && findMatch(id);
  if (m && !state.unlocked.has(id)) {
    if (isPast(m)) { state.tab = 'past'; render(); }
    openUnlock(id);
  }
})();

// Başkasının kaydı elle yenilemeden görünsün diye 30 sn'de bir sessizce güncellenir.
setInterval(async () => {
  if (!API || state.busy || dragging || document.visibilityState === 'hidden' || $$('dialog').some(d => d.open) || document.activeElement?.matches('#matchList select')) return;
  try {
    const summaries = await request('/matches');
    state.matches = summaries.matches || [];
    await refreshUnlocked();
    render();
  } catch { /* son görüntü kalsın; hata elle yenilemede gösterilir */ }
}, 30000);
