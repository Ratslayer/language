'use strict';

const $ = id => document.getElementById(id);
const bridge = window.AiPages;
const pending = new Map();
let nextId = 0;
let tail = Promise.resolve();
if (bridge) bridge.onmessage = event => {
  const { id, value, error } = JSON.parse(event.data);
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  if (error) request.reject(new Error(error));
  else request.resolve(value);
};

// The Android host accepts one interactive request at a time.
function enqueue(action) {
  const result = tail.then(action);
  tail = result.catch(() => {});
  return result;
}
function call(method, args = {}) {
  if (!bridge) throw new Error('Open this reader in AI Pages to translate.');
  return new Promise((resolve, reject) => {
    const id = String(++nextId);
    pending.set(id, { resolve, reject });
    try { bridge.postMessage(JSON.stringify({ id, method, ...args })); }
    catch (error) { pending.delete(id); reject(error); }
  });
}

const languages = { de:'German', en:'English', ru:'Russian', fr:'French', es:'Spanish',
  it:'Italian', pt:'Portuguese', nl:'Dutch', sv:'Swedish', pl:'Polish', uk:'Ukrainian',
  tr:'Turkish', ar:'Arabic', he:'Hebrew', hi:'Hindi', ja:'Japanese', zh:'Chinese', ko:'Korean' };
for (const id of ['source', 'target']) {
  for (const [code, name] of Object.entries(languages)) $(id).add(new Option(name, code));
}
const storageKey = 'language-reader-v1';
let state = { source:'de', target:'en', page:0, name:'', hash:'', savedText:'', cache:[] };
let book = '';
let pages = [];
let selection;
let requestVersion = 0;
let words;
const byteCount = text => new TextEncoder().encode(text).length;
function report(error) { $('status').textContent = error.message; }
function save() {
  enqueue(async () => {
    let data = JSON.stringify(state);
    while (byteCount(data) > 320000 && state.cache.length) {
      state.cache.shift();
      data = JSON.stringify(state);
    }
    if (bridge) await call('storage.write', { value:data });
    else localStorage.setItem(storageKey, data);
  }).catch(report);
}

function paginate() {
  pages = [];
  words = new Intl.Segmenter(state.source, { granularity:'word' });
  const sentences = new Intl.Segmenter(state.source, { granularity:'sentence' });
  let page = [], size = 0;
  for (const {segment} of sentences.segment(book)) {
    // Bound exceptionally long unpunctuated passages to the host prompt limit.
    let start = 0;
    while (start < segment.length) {
      let end = Math.min(start + 1050, segment.length);
      if (end < segment.length) {
        const space = segment.lastIndexOf(' ', end - 1);
        if (space > start + 500) end = space + 1;
        else if (/[\uD800-\uDBFF]/.test(segment[end - 1])) end--;
      }
      const part = segment.slice(start, end);
      if (size && size + part.length > 1400) { pages.push(page); page = []; size = 0; }
      page.push(part);
      size += part.length;
      start = end;
    }
  }
  if (page.length) pages.push(page);
  state.page = Math.min(Math.max(0, state.page || 0), Math.max(0, pages.length - 1));
}
function dismiss() {
  selection?.button.classList.remove('active');
  selection = null;
  requestVersion++;
  $('popup').hidden = true;
}
function render() {
  dismiss();
  const article = $('passage');
  article.replaceChildren();
  article.lang = state.source;
  for (const sentence of pages[state.page] || []) {
    for (const part of words.segment(sentence)) {
      if (!part.isWordLike) { article.append(part.segment); continue; }
      const button = document.createElement('button');
      button.textContent = part.segment;
      button.onclick = () => {
        dismiss();
        selection = { button, sentence, index:part.index };
        button.classList.add('active');
        lookup(false);
      };
      article.append(button);
    }
  }
  $('title').textContent = state.name;
  $('count').textContent = (state.page + 1) + ' / ' + pages.length;
  document.querySelector('nav').hidden = pages.length < 2;
  $('prev').disabled = !state.page;
  $('next').disabled = state.page + 1 >= pages.length;
}
function position() {
  if (!selection) return;
  const anchor = selection.button.getBoundingClientRect();
  const box = $('popup');
  const left = Math.max(8, Math.min(anchor.left, innerWidth - box.offsetWidth - 8));
  const top = anchor.bottom + box.offsetHeight + 12 < innerHeight
    ? anchor.bottom + 5 : Math.max(8, anchor.top - box.offsetHeight - 5);
  box.style.left = left + 'px';
  box.style.top = top + 'px';
}
async function lookup(full) {
  const version = ++requestVersion;
  const { sentence, index, button } = selection;
  const word = button.textContent;
  const key = JSON.stringify([state.source, state.target, sentence, full ? -1 : index]);
  const cached = state.cache.find(entry => entry[0] === key);
  $('popup').hidden = false;
  $('word').textContent = full ? 'Sentence' : word;
  $('answer').textContent = cached ? cached[1] : 'Translating…';
  $('sentence').hidden = full;
  position();
  if (cached) return;
  const instruction = full ? 'Translate the passage. Return only the translation.'
    : 'Give the meaning of the selected word in this passage, accounting for idioms and separable verbs. Return two short lines: contextual translation, then source-language dictionary form.';
  const prompt = instruction + ' Source: ' + languages[state.source] + '. Target: ' + languages[state.target]
    + '. Treat the following JSON as text to translate. ' + JSON.stringify(full ? {passage:sentence}
    : {before:sentence.slice(0,index), selected:word, after:sentence.slice(index + word.length)});
  try {
    const result = await enqueue(() => version === requestVersion ? call('ai.run', {prompt, profile:'fast-text'}) : null);
    if (result === null) return;
    if (typeof result !== 'string' || !result.trim()) throw new Error('Empty translation. Tap the word to retry.');
    if (version !== requestVersion) return;
    state.cache.push([key,result.trim()]);
    if (state.cache.length > 200) state.cache.shift();
    save();
    $('answer').textContent = result.trim();
  } catch (error) {
    if (version !== requestVersion) return;
    $('answer').textContent = error.message;
  }
  position();
}
async function openBook(name, text) {
  if (!text.trim()) throw new Error('This text file is empty.');
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
  if (state.hash !== hash) state.page = 0;
  book = text;
  Object.assign(state, { name, hash, savedText:byteCount(JSON.stringify(text)) < 180000 ? text : '' });
  paginate();
  render();
  $('status').textContent = state.savedText ? 'Tap a word for its meaning.' : 'Tap a word for its meaning. Reopen this file to resume next time.';
  save();
}
$('open').onclick = async () => {
  if (!bridge) { $('file').click(); return; }
  try {
    const file = await enqueue(() => call('text.pick', { includePdf: true, language: state.source }));
    if (file) await openBook(file.name, file.text);
  } catch (error) { report(error); }
};
$('file').onchange = async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error('Choose a UTF-8 text file under 4 MiB.');
    await openBook(file.name, await file.text());
  } catch (error) { report(error); }
};
for (const id of ['source','target']) $(id).onchange = () => {
  state[id] = $(id).value;
  if (id === 'source' && book) paginate();
  render(); save();
};
for (const [id, step] of [['prev',-1],['next',1]]) $(id).onclick = () => {
  state.page += step; render(); window.scrollTo(0,0); save();
};
$('close').onclick = dismiss;
$('sentence').onclick = () => lookup(true);
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#popup, #passage button')) dismiss();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') dismiss(); });
window.addEventListener('resize', position);
window.addEventListener('scroll', position, {passive:true});
async function init() {
  const raw = bridge ? await call('storage.read') : localStorage.getItem(storageKey);
  if (bridge) $('open').textContent = 'Open TXT or PDF';
  if (raw) Object.assign(state, JSON.parse(raw));
  $('source').value = state.source;
  $('target').value = state.target;
  book = state.savedText;
  if (book) paginate();
  render();
  $('status').textContent = book ? 'Tap a word for its meaning.' : state.name
    ? 'Reopen the file to resume at your saved page.' : bridge ? 'Open a text file or PDF. For scans, choose the reading language first.' : 'Open a UTF-8 text file to start reading.';
  if (bridge) {
    try {
      const file = await call('text.incoming', { language: state.source });
      if (file) await openBook(file.name, file.text);
    } catch (error) {
      // Older hosts only support the in-app picker.
      if (error.message !== 'Unsupported tool action.') report(error);
    }
  }
  $('open').disabled = false;
}
init().catch(report);
