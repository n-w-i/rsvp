import { extractPdf, textToBlocks, EXTRACTOR_VERSION } from './extract.js';
import { tokenize, estimateMs, sentenceStarts } from './tokenize.js';
import { Player } from './rsvp.js';
import { library, hashOf, loadSettings, saveSettings } from './store.js';

const $ = (id) => document.getElementById(id);
const el = {
  home: $('view-home'),
  reader: $('view-reader'),
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  word: $('word'),
  reticle: $('reticle'),
  context: $('context'),
  docTitle: $('doc-title'),
  sectionLabel: $('section-label'),
  scrubTicks: $('scrub-ticks'),
  toc: $('toc'),
  tocList: $('toc-list'),
  tocEmpty: $('toc-empty'),
  scrubber: $('scrubber'),
  metaLeft: $('meta-left'),
  metaRight: $('meta-right'),
  wpm: $('wpm'),
  wpmValue: $('wpm-value'),
  drawer: $('drawer'),
  libraryPanel: $('library'),
  libList: $('lib-list'),
  libEmpty: $('lib-empty'),
  recents: $('recents'),
  recentsList: $('recents-list'),
  scrim: $('scrim'),
  loading: $('loading'),
  loadingText: $('loading-text'),
  loadingBar: $('loading-bar'),
  toast: $('toast'),
  pasteDialog: $('paste-dialog'),
  pasteText: $('paste-text'),
};

const player = new Player();
let settings = loadSettings();
let doc = null; // { id, name, blocks, numPages }
let starts = [];
let sections = []; // { index, title } for every heading, in reading order
let saveTimer = null;

/* ── Word rendering ──────────────────────────────────────────── */

const pre = document.createElement('span');
const orp = document.createElement('span');
const post = document.createElement('span');
orp.className = 'orp';
el.word.append(pre, orp, post);

function renderWord(token) {
  if (!token) {
    el.word.classList.add('blank');
    return;
  }
  el.word.classList.remove('blank');

  // Headings render whole and centred — there is no pivot letter to align.
  el.word.classList.toggle('is-heading', !!token.heading);
  el.reticle.classList.toggle('heading', !!token.heading);
  if (token.heading) {
    pre.textContent = token.text;
    orp.textContent = '';
    post.textContent = '';
    el.word.style.transform = 'translate(-50%, -50%)';
    return;
  }

  const { text, orp: i } = token;
  pre.textContent = text.slice(0, i);
  orp.textContent = text.slice(i, i + 1);
  post.textContent = text.slice(i + 1);

  // Shift the word so the pivot letter's centre sits on the fixation notch.
  const offset = pre.getBoundingClientRect().width + orp.getBoundingClientRect().width / 2;
  el.word.style.transform = `translate(${-offset}px, -50%)`;
}

function renderContext(index) {
  if (!settings.showContext) {
    el.context.classList.add('hidden');
    return;
  }
  el.context.classList.remove('hidden');
  const token = player.tokens[index];
  if (!token) {
    el.context.textContent = '';
    return;
  }
  // The heading card already shows its full text; echoing it below is noise.
  if (token.heading) {
    el.context.classList.add('hidden');
    return;
  }
  const from = Math.max(0, index - 7);
  const to = Math.min(player.tokens.length, index + 8);
  el.context.replaceChildren();
  for (let i = from; i < to; i++) {
    const t = player.tokens[i];
    if (t.block !== token.block) continue;
    if (i === index) {
      const b = document.createElement('b');
      b.textContent = t.text;
      el.context.append(b, ' ');
    } else {
      el.context.append(t.text + ' ');
    }
  }
}

function buildSections(tokens) {
  sections = [];
  tokens.forEach((t, i) => {
    if (t.heading) sections.push({ index: i, title: t.text });
  });

  const last = tokens.length - 1 || 1;
  el.scrubTicks.replaceChildren(
    ...sections.map(({ index, title }) => {
      const tick = document.createElement('span');
      tick.style.left = `${(index / last) * 100}%`;
      tick.title = title;
      return tick;
    }),
  );
}

function renderToc() {
  const current = sectionAt(player.index);
  el.tocList.replaceChildren(
    ...sections.map((section) => {
      const li = document.createElement('li');
      const row = document.createElement('button');
      row.className = 'toc-row';
      row.classList.toggle('current', section === current);

      const title = document.createElement('span');
      title.className = 'toc-title';
      title.textContent = section.title;

      const page = document.createElement('span');
      page.className = 'toc-page';
      page.textContent = `p${player.tokens[section.index]?.page ?? 1}`;

      row.append(title, page);
      row.addEventListener('click', () => {
        closePanels();
        player.seek(section.index);
      });
      li.append(row);
      return li;
    }),
  );
  el.tocEmpty.hidden = sections.length > 0;
}

// The most recent heading at or before this position.
function sectionAt(index) {
  let lo = 0;
  let hi = sections.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sections[mid].index <= index) {
      found = sections[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function formatTime(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h} hr ${mins % 60} min`;
}

function renderProgress() {
  const total = player.tokens.length;
  const i = Math.min(player.index, total - 1);
  const pct = total ? (i / (total - 1 || 1)) * 100 : 0;
  el.scrubber.value = String(pct);
  el.scrubber.style.setProperty('--fill', pct);

  const token = player.tokens[i];
  const left = estimateMs(player.tokens, i, settings.wpm, settings.punctuationScale);
  el.metaLeft.textContent =
    doc?.numPages > 1 && token ? `page ${token.page} of ${doc.numPages}` : `${Math.round(pct)}%`;
  el.metaRight.textContent = player.done ? 'finished' : `${formatTime(left)} left`;
}

function renderAll() {
  // At the end there is no current token, but the last word should stay on screen.
  const index = Math.min(player.index, player.tokens.length - 1);
  renderWord(player.tokens[index]);
  renderContext(index);
  renderProgress();

  const section = sectionAt(index);
  el.sectionLabel.textContent = section ? section.title : '';
  el.sectionLabel.hidden = !section;
}

/* ── Player events ───────────────────────────────────────────── */

player.addEventListener('tick', renderAll);
player.addEventListener('state', () => {
  document.body.classList.toggle('playing', player.playing);
  if (!player.playing) persist();
});
player.addEventListener('finish', () => {
  toast('Finished — nice work.');
  persist();
});

/* ── Settings ────────────────────────────────────────────────── */

function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty(
    '--font-word',
    `var(--font-${settings.font})`,
  );
  document.documentElement.style.setProperty('--word-scale', settings.fontSize);
  player.wpm = settings.wpm;
  player.punctuationScale = settings.punctuationScale;
  player.rewindOnResume = settings.rewindOnResume;

  el.wpm.value = String(settings.wpm);
  el.wpm.style.setProperty('--fill', ((settings.wpm - 100) / 1100) * 100);
  el.wpmValue.textContent = settings.wpm;

  $('set-size').value = String(settings.fontSize);
  $('set-size-val').textContent = `${Math.round(settings.fontSize * 100)}%`;
  $('set-pause').value = String(settings.punctuationScale);
  $('set-pause-val').textContent = `${Math.round(settings.punctuationScale * 100)}%`;
  $('set-context').checked = settings.showContext;
  $('set-skip-noise').checked = settings.skipNoise;
  $('set-rewind').checked = settings.rewindOnResume;

  for (const btn of $('set-chunk').children) btn.classList.toggle('on', +btn.dataset.value === settings.chunkSize);
  for (const btn of $('set-font').children) btn.classList.toggle('on', btn.dataset.value === settings.font);

  for (const slider of document.querySelectorAll('#set-size, #set-pause')) {
    const pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
    slider.style.setProperty('--fill', pct);
  }

  saveSettings(settings);
}

// Chunk size and noise-skipping both change what a token index means. Anchor the
// reader's place to a paragraph and an offset within it, which survives either change.
function rebuildTokens() {
  if (!doc) return;
  const targetBlock = player.tokens[player.index]?.block ?? 0;
  let wordsIn = 0;
  for (let i = player.index - 1; i >= 0 && player.tokens[i].block === targetBlock; i--) {
    wordsIn += player.tokens[i].wordCount;
  }

  const tokens = tokenize(doc.blocks, {
    chunkSize: settings.chunkSize,
    skipNoise: settings.skipNoise,
  });
  if (!tokens.length) return;
  starts = sentenceStarts(tokens);
  buildSections(tokens);

  let index = tokens.findIndex((t) => t.block >= targetBlock);
  if (index < 0) index = tokens.length - 1;
  let seen = 0;
  while (
    index + 1 < tokens.length &&
    tokens[index].block === targetBlock &&
    seen + tokens[index].wordCount <= wordsIn
  ) {
    seen += tokens[index].wordCount;
    index++;
  }

  player.load(tokens, index);
  renderAll();
}

/* ── Documents ───────────────────────────────────────────────── */

async function openDoc(record, { save = true } = {}) {
  doc = record;
  const tokens = tokenize(record.blocks, {
    chunkSize: settings.chunkSize,
    skipNoise: settings.skipNoise,
  });
  if (!tokens.length) {
    toast('No readable text found in that file.');
    return;
  }
  starts = sentenceStarts(tokens);
  buildSections(tokens);
  player.load(tokens, Math.min(record.index || 0, tokens.length - 1));
  el.docTitle.textContent = record.name;
  el.home.hidden = true;
  el.reader.hidden = false;
  renderAll();
  if (save) await persist();
}

async function persist() {
  if (!doc) return;
  clearTimeout(saveTimer);
  await library.put({ ...doc, index: player.index, total: player.tokens.length, opened: Date.now() });
}

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 4000);
}

async function handleFile(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  showLoading(isPdf ? 'Reading the PDF…' : 'Loading…');
  try {
    const buffer = await file.arrayBuffer();
    const id = await hashOf(buffer);
    const existing = await library.get(id);
    if (existing && existing.v === EXTRACTOR_VERSION) {
      hideLoading();
      await openDoc(existing);
      toast('Picking up where you left off.');
      return;
    }

    const name = file.name.replace(/\.(pdf|txt)$/i, '');
    let record;
    if (isPdf) {
      const { blocks, numPages, title } = await extractPdf(buffer, (p) => setProgress(p));
      record = { id, v: EXTRACTOR_VERSION, name: title || name, blocks, numPages, index: 0 };
    } else {
      const blocks = textToBlocks(new TextDecoder().decode(buffer));
      record = { id, v: EXTRACTOR_VERSION, name, blocks, numPages: 1, index: 0 };
    }

    // Re-extracted an old import: token indices moved, so carry the position across
    // as a fraction of the way through rather than losing the reader's place.
    if (existing?.total) {
      const words = record.blocks.reduce((a, b) => a + b.text.split(' ').length, 0);
      record.index = Math.min(Math.round((existing.index / existing.total) * words), words - 1);
      toast('Re-read this PDF with the latest text extraction.');
    }

    hideLoading();
    await openDoc(record);
  } catch (err) {
    hideLoading();
    console.error(err);
    toast("Couldn't read that file.");
  }
}

async function handleUrl(url) {
  showLoading('Fetching the PDF…');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const blob = await res.blob();
    const name = decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'document.pdf');
    await handleFile(new File([blob], name, { type: blob.type || 'application/pdf' }));
  } catch (err) {
    hideLoading();
    console.error(err);
    toast("Couldn't fetch that PDF.");
  }
}

/* ── Library UI ──────────────────────────────────────────────── */

function docRow(record, onOpen, onDelete) {
  const li = document.createElement('li');
  const row = document.createElement('button');
  row.className = 'doc-row';
  const pct = record.total ? Math.floor((record.index / record.total) * 100) : 0;

  const ring = document.createElement('span');
  ring.className = 'ring';
  ring.style.setProperty('--p', pct);
  const ringLabel = document.createElement('span');
  ringLabel.textContent = `${pct}`;
  ring.append(ringLabel);

  const info = document.createElement('span');
  info.className = 'info';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = record.name;
  const meta = document.createElement('span');
  meta.className = 'meta';
  const words = record.blocks.reduce((a, b) => a + b.text.split(' ').length, 0);
  meta.textContent = `${words.toLocaleString()} words${record.numPages > 1 ? ` · ${record.numPages} pages` : ''}`;
  info.append(name, meta);

  row.append(ring, info);
  row.addEventListener('click', () => onOpen(record));

  const del = document.createElement('button');
  del.className = 'del';
  del.setAttribute('aria-label', `Remove ${record.name}`);
  del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9.5 7V5h5v2M6.5 7l1 12h9l1-12"/></svg>';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    await library.remove(record.id);
    await refreshLibrary();
  });
  row.append(del);

  li.append(row);
  return li;
}

async function refreshLibrary() {
  const docs = await library.all();
  const open = async (record) => {
    closePanels();
    await openDoc(record);
  };

  el.libList.replaceChildren(...docs.map((d) => docRow(d, open)));
  el.libEmpty.hidden = docs.length > 0;

  const unfinished = docs.filter((d) => d.total && d.index > 0 && d.index < d.total - 1).slice(0, 4);
  el.recentsList.replaceChildren(...unfinished.map((d) => docRow(d, open)));
  el.recents.hidden = unfinished.length === 0;
}

/* ── Chrome ──────────────────────────────────────────────────── */

function showLoading(text) {
  el.loadingText.textContent = text;
  el.loadingBar.style.width = '0%';
  el.loading.hidden = false;
}

function setProgress(p) {
  el.loadingBar.style.width = `${Math.round(p * 100)}%`;
}

function hideLoading() {
  el.loading.hidden = true;
}

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 2600);
}

function openPanel(panel) {
  panel.hidden = false;
  el.scrim.hidden = false;
  player.pause();
}

function closePanels() {
  el.drawer.hidden = true;
  el.libraryPanel.hidden = true;
  el.toc.hidden = true;
  el.scrim.hidden = true;
}

/* ── Wiring ──────────────────────────────────────────────────── */

el.dropzone.addEventListener('click', () => el.fileInput.click());
el.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    el.fileInput.click();
  }
});
el.fileInput.addEventListener('change', () => {
  const file = el.fileInput.files?.[0];
  if (file) handleFile(file);
  el.fileInput.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (e) => {
    e.preventDefault();
    el.dropzone.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  document.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === 'dragleave' && e.relatedTarget) return;
    el.dropzone.classList.remove('over');
  });
}
document.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

$('btn-play').addEventListener('click', () => player.toggle());
$('reticle').addEventListener('click', () => player.toggle());
$('btn-back').addEventListener('click', () => player.step(-1));
$('btn-fwd').addEventListener('click', () => player.step(1));
$('btn-back-sentence').addEventListener('click', () => jumpSentence(-1));
$('btn-fwd-sentence').addEventListener('click', () => jumpSentence(1));

function jumpSentence(dir) {
  const wasPlaying = player.playing;
  player.pause();
  const i = player.index;
  const target =
    dir < 0
      ? [...starts].reverse().find((s) => s < i - 1) ?? 0
      : starts.find((s) => s > i) ?? player.tokens.length - 1;
  player.seek(target);
  if (wasPlaying) player.play();
}

el.scrubber.addEventListener('input', () => {
  player.pause();
  const pct = +el.scrubber.value / 100;
  player.seek(Math.round(pct * (player.tokens.length - 1)));
});

el.wpm.addEventListener('input', () => {
  settings.wpm = +el.wpm.value;
  applySettings();
  renderProgress();
});
$('wpm-up').addEventListener('click', () => nudgeSpeed(25));
$('wpm-down').addEventListener('click', () => nudgeSpeed(-25));

function nudgeSpeed(delta) {
  settings.wpm = Math.max(100, Math.min(1200, settings.wpm + delta));
  applySettings();
  renderProgress();
}

$('btn-settings').addEventListener('click', () => openPanel(el.drawer));
$('btn-close-drawer').addEventListener('click', closePanels);
$('btn-library').addEventListener('click', async () => {
  await refreshLibrary();
  openPanel(el.libraryPanel);
});
$('btn-close-library').addEventListener('click', closePanels);
el.sectionLabel.addEventListener('click', () => {
  renderToc();
  openPanel(el.toc);
});
$('btn-close-toc').addEventListener('click', closePanels);
el.scrim.addEventListener('click', closePanels);

$('btn-theme').addEventListener('click', () => {
  settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
  applySettings();
});

$('btn-close-doc').addEventListener('click', async () => {
  player.pause();
  await persist();
  doc = null;
  el.reader.hidden = true;
  el.home.hidden = false;
  await refreshLibrary();
});

$('set-chunk').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || +btn.dataset.value === settings.chunkSize) return;
  settings.chunkSize = +btn.dataset.value;
  applySettings();
  rebuildTokens();
});
$('set-skip-noise').addEventListener('change', (e) => {
  settings.skipNoise = e.target.checked;
  applySettings();
  rebuildTokens();
});
$('set-rewind').addEventListener('change', (e) => {
  settings.rewindOnResume = e.target.checked;
  applySettings();
});
$('set-font').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  settings.font = btn.dataset.value;
  applySettings();
  renderWord(player.current);
});
$('set-size').addEventListener('input', (e) => {
  settings.fontSize = +e.target.value;
  applySettings();
  renderWord(player.current);
});
$('set-pause').addEventListener('input', (e) => {
  settings.punctuationScale = +e.target.value;
  applySettings();
  renderProgress();
});
$('set-context').addEventListener('change', (e) => {
  settings.showContext = e.target.checked;
  applySettings();
  renderContext(player.index);
});

$('btn-paste').addEventListener('click', () => el.pasteDialog.showModal());
el.pasteDialog.addEventListener('close', async () => {
  if (el.pasteDialog.returnValue !== 'ok') return;
  const text = el.pasteText.value.trim();
  if (!text) return;
  const id = await hashOf(new TextEncoder().encode(text));
  const blocks = textToBlocks(text);
  await openDoc({ id, name: blocks[0]?.text.slice(0, 48) || 'Pasted text', blocks, numPages: 1, index: 0 });
  el.pasteText.value = '';
});

document.addEventListener('keydown', (e) => {
  if (el.reader.hidden || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const keys = {
    ' ': () => player.toggle(),
    ArrowLeft: () => player.step(-1),
    ArrowRight: () => player.step(1),
    ArrowUp: () => nudgeSpeed(25),
    ArrowDown: () => nudgeSpeed(-25),
    j: () => jumpSentence(-1),
    k: () => jumpSentence(1),
    Escape: () => player.pause(),
  };
  const action = keys[e.key] || keys[e.key.toLowerCase()];
  if (!action) return;
  e.preventDefault();
  action();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    player.pause();
    persist();
  }
});

addEventListener('scroll', () => {
  document.querySelector('.topbar').classList.toggle('scrolled', scrollY > 4);
});

addEventListener('resize', () => renderWord(player.current));
player.addEventListener('tick', schedulePersist);

/* ── Boot ────────────────────────────────────────────────────── */

applySettings();
refreshLibrary();

const params = new URLSearchParams(location.search);
if (params.get('src')) handleUrl(params.get('src'));

// Android share sheet: the service worker parked the file in a cache for us.
if (params.get('shared')) {
  caches.open('flash-share').then(async (cache) => {
    const res = await cache.match('shared');
    if (!res) return;
    const name = decodeURIComponent(res.headers.get('x-filename') || 'shared.pdf');
    await cache.delete('shared');
    await handleFile(new File([await res.blob()], name));
    history.replaceState(null, '', location.pathname);
  });
}

// Browser extension: "Read selection with Flash".
if (params.get('selection') && globalThis.chrome?.storage?.local) {
  chrome.storage.local.get('selection', async ({ selection }) => {
    if (!selection) return;
    await chrome.storage.local.remove('selection');
    const blocks = textToBlocks(selection);
    const id = await hashOf(new TextEncoder().encode(selection));
    await openDoc({ id, name: blocks[0]?.text.slice(0, 48) || 'Selection', blocks, numPages: 1, index: 0 });
  });
}

// Desktop: "Open with Flash" on a PDF.
window.launchQueue?.setConsumer(async (launch) => {
  const handle = launch.files?.[0];
  if (handle) await handleFile(await handle.getFile());
});

// Skipped on localhost: cache-first would serve stale assets during development.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
