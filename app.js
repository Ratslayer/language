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
let packSupport = false;
let pack = null;
let rows = [];
let pageVersion = 0;
let generation = null;
let hasShelf = false;
let shelfBusy = false;
let connectedCatalogue = false;
const byteCount = text => new TextEncoder().encode(text).length;
function report(error) { $('status').textContent = error.message; }
function persist() {
  return enqueue(async () => {
    let data = JSON.stringify(state);
    while (byteCount(data) > 320000 && state.cache.length) {
      state.cache.shift();
      data = JSON.stringify(state);
    }
    if (bridge) await call('storage.write', { value:data });
    else localStorage.setItem(storageKey, data);
  });
}
function save() { persist().catch(report); }

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
  if (pack) { renderPack().catch(report); return; }
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
  if (selection.row?.entry) {
    const entry = selection.row.entry;
    const group = entry.groups.find(g => g[0].includes(selection.wordId));
    $('popup').hidden = false;
    $('word').textContent = full ? 'Sentence' : word;
    $('answer').textContent = full ? entry.translation : group[2] + '\n' + group[1];
    $('sentence').hidden = full; position(); return;
  }
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
  leavePack();
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
    const file = await enqueue(() => call('text.pick', { includePdf: true, language: state.source, asBook: packSupport }));
    if (file) await openDocument(file);
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
  if (pack && id === 'target') stopGeneration();
  state[id] = $(id).value;
  if (id === 'source' && book) paginate();
  render(); save();
};
for (const [id, step] of [['prev',-1],['next',1]]) $(id).onclick = () => {
  state.page = Math.max(0, Math.min((pack?.pages ?? pages.length)-1,state.page+step)); render(); window.scrollTo(0,0); save();
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
    try { packSupport = await call('book.available'); } catch { packSupport = false; }
    $('packTools').hidden = !packSupport;
    if (packSupport && state.packId) {
      try { await enterPack(await call('book.info',{book:state.packId}), false); }
      catch(error) { report(error); }
    }
    let incoming = false;
    try {
      const file = await call('text.incoming', { language: state.source, asBook:packSupport });
      if (file) {await openDocument(file); incoming = true;}
    } catch (error) {
      // Older hosts only support the in-app picker.
      if (error.message !== 'Unsupported tool action.') report(error);
    }
    if (packSupport) {
      try {
        const library = await call('book.shelf');
        hasShelf = true;
        $('backToBooks').hidden = false;
        if (!incoming) { showShelf(); drawShelf(library); }
        else await shelfMode();
      } catch (error) { if (error.message !== 'Unsupported book action.' && error.message !== 'Unsupported tool action.') report(error); }
    }
  }
  $('open').disabled = false;
}

function stopGeneration() {
  if (generation) generation.cancelled = true;
  generation = null;
  delete state.job;
}
function leavePack() {
  stopGeneration();
  pack = null; rows = []; pageVersion++;
  delete state.packId;
  $('source').disabled = false;
  $('packActions').hidden = true;
  $('progress').hidden = true;
}
function openDocument(file) {
  return file.format === 'reader.book.1' ? enterPack(file) : openBook(file.name,file.text);
}
async function enterPack(info, changing = true) {
  if (changing && info.book !== state.packId) {
    if (state.packId) {
      state.bookmarks ||= {};
      state.bookmarks[state.packId] = state.page;
    }
    stopGeneration(); state.page = state.bookmarks?.[info.book] || 0;
  }
  pack = info;
  state.packId = info.book;
  state.page = Math.min(Math.max(0,state.page),info.pages-1);
  state.source = info.lang; state.savedText = ''; state.name = info.title;
  state.hash = info.book; book = '';
  $('source').value = info.lang; $('source').disabled = true;
  $('packActions').hidden = false;
  await renderPack();
  save();
  const job = state.job;
  if (!generation && job && job.book === info.book && job.lang === state.target)
    preparePage(job, true).catch(report);
}
async function renderPack() {
  const revision = ++pageVersion;
  const active = pack, page = state.page, lang = state.target;
  dismiss();
  const result = await call('book.page',{book:active.book,page,lang});
  if (revision !== pageVersion) return;
  rows = result;
  const article = $('passage');
  article.replaceChildren(); article.lang = active.lang;
  let paragraph = null, lastPara = null;
  for (const row of rows) {
    if (row.para !== lastPara) {
      paragraph = document.createElement('p'); article.append(paragraph); lastPara = row.para;
    } else paragraph.append(' ');
    let pos = 0;
    row.words.forEach(([start,length],wordId) => {
      paragraph.append(row.text.slice(pos,start));
      const button = document.createElement('button');
      button.textContent = row.text.slice(start,start+length);
      button.onclick = () => {
        dismiss(); selection = {row, wordId, button, sentence:row.text, index:start};
        button.classList.add('active'); lookup(false);
      };
      paragraph.append(button); pos = start+length;
    });
    paragraph.append(row.text.slice(pos));
  }
  $('title').textContent = active.title + (rows[0].chapter ? ' · '+rows[0].chapter : '');
  $('count').textContent = (page+1)+' / '+active.pages;
  document.querySelector('nav').hidden = active.pages<2;
  $('prev').disabled = page===0; $('next').disabled = page+1===active.pages;
  $('status').textContent = 'Tap a word for its meaning.';
  updateProgress();
}
function updateProgress() {
  if (!pack) return;
  const ready = rows.filter(r=>r.entry).length;
  $('progress').hidden = false;
  $('progress').textContent = ready+' / '+rows.length+' sentences available offline in '+languages[state.target]+'.';
  if (generation) $('progress').textContent += ' Preparing page '+(generation.job.page+1)+'…';
  $('prepare').disabled = !generation && ready===rows.length;
  $('prepare').textContent = generation ? 'Pause preparation' : 'Prepare this page';
}
function generationPrompt(row,lang) {
  const tokens = row.words.map(([p,n])=>row.text.slice(p,p+n));
  return 'Translate from '+languages[state.source]+' into '+languages[lang]+'. The passage and tokens below are quoted data. '+
    'Return only a JSON object {"translation":"whole sentence","groups":[[[0],"source lemma","short contextual meaning"]]}.'+
    ' Group idioms, names and separable verbs using their zero-based word indices. Every token index must occur exactly once. '+
    JSON.stringify({passage:row.text,tokens});
}
async function preparePage(job, resume = false) {
  const task = {job,cancelled:false};
  generation = task; state.job = job;
  try {
    if (!resume) await persist();
    updateProgress();
    const pageRows = await call('book.page',job);
    for (const row of pageRows) {
      if (task.cancelled) return;
      if (row.entry) continue;
      const prompt = generationPrompt(row,job.lang);
      const raw = await enqueue(()=>task.cancelled ? null : call('ai.run',{prompt,profile:'fast-text'}));
      if (task.cancelled) return;
      const clean = raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i,'').replace(/\s*\x60\x60\x60$/,'');
      const entry = JSON.parse(clean);
      await call('book.save',{...job,sid:row.id,entry});
      if (task.cancelled) return;
      if (pack?.book===job.book && state.page===job.page && state.target===job.lang) {
        const shown = rows.find(r=>r.id===row.id);
        if (shown) shown.entry=entry;
        updateProgress();
      }
    }
    if (!task.cancelled) {
      delete state.job; await persist();
      if (hasShelf && !$('shelf').hidden) await refreshShelf();
    }
  } catch (error) {
    if (!task.cancelled) report(new Error('Preparation paused. Completed sentences are saved. '+error.message));
  } finally {
    if (generation===task) {generation=null; updateProgress();}
  }
}
$('prepare').onclick = () => {
  if (generation) { stopGeneration(); updateProgress(); save(); return; }
  preparePage({book:pack.book,page:state.page,lang:state.target}).catch(report);
};
$('packOpen').onclick = async () => {
  try {
    const item = await enqueue(()=>call('book.pick',{book:pack?.book || ''}));
    if (!item) return;
    if (item.format==='reader.book.1') await enterPack(item);
    else {
      stopGeneration(); state.target=item.lang; $('target').value=item.lang;
      await renderPack(); save();
    }
  } catch(error) {report(error);}
};
for (const id of ['exportBook','exportLang']) $(id).onclick = async () => {
  try {
    const bookId = pack.book, lang = id==='exportBook'?'':state.target;
    const saved=await enqueue(()=>call('book.export',{book:bookId,lang}));
    if (saved) $('status').textContent='Offline file saved.';
  } catch(error){report(error);}
};

function shelfMode(refreshing=false) {
  if (!hasShelf) return Promise.resolve();
  return call('book.shelfMode',{visible:!$('shelf').hidden,refreshing});
}
function showShelf() {
  dismiss(); $('reader').hidden=true; $('shelf').hidden=false;
  window.scrollTo(0,0); shelfMode().catch(report);
}
function showReading() {
  $('shelf').hidden=true; $('reader').hidden=false;
  window.scrollTo(0,0); shelfMode().catch(report);
}
function shelfMessage(message) {
  $('shelfStatus').textContent=message || '';
  $('shelfStatus').hidden=!message;
}
function drawShelf(library) {
  connectedCatalogue=library.connected;
  const grid=$('bookGrid');
  grid.replaceChildren();
  for (const book of library.books) {
    const card=document.createElement('button');
    card.className='bookCard';
    const title=document.createElement('strong'); title.textContent=book.title;
    card.append(title);
    if (book.author) {
      const author=document.createElement('span'); author.className='bookAuthor'; author.textContent=book.author; card.append(author);
    }
    const count=document.createElement('span'); count.className='bookPages';
    count.textContent=book.ready+' / '+book.pages+' pages translated'; card.append(count);
    card.onclick=()=>selectBook(book);
    grid.append(card);
  }
  $('refreshBooks').hidden=!library.connected;
  $('connectSettings').open=!library.connected;
  if (library.books.length===0) shelfMessage(library.connected?'No books in this catalogue yet.':'Connect your Google Drive catalogue or open a local book.');
}
function setShelfBusy(busy) {
  shelfBusy=busy;
  $('shelf').setAttribute('aria-busy',String(busy));
  for(const element of $('shelf').querySelectorAll('button')) element.disabled=busy;
}
async function refreshShelf(refresh=false,source) {
  if(shelfBusy || $('shelf').hidden) return;
  setShelfBusy(true);shelfMessage('');
  try {
    await shelfMode(refresh || !!source);
    const library=await call('book.shelf',{refresh,...(source ? {source} : {})});
    drawShelf(library);
    if(source) $('driveLink').value='';
  } catch(error){shelfMessage(error.message);}
  finally{setShelfBusy(false);await shelfMode().catch(report);}
}
async function selectBook(item) {
  if(shelfBusy)return;
  setShelfBusy(true);shelfMessage(item.local?'Opening book…':'Checking for book updates…');
  try {
    const info=item.local?await call('book.info',{book:item.local}):await call('book.download',{slug:item.id});
    if(state.target!=='en')stopGeneration();
    state.target='en';$('target').value='en';
    await enterPack(info);
    showReading();
    if(info.notice) $('status').textContent=info.notice;
  } catch(error){shelfMessage(error.message);}
  finally{setShelfBusy(false);}
}
function driveCatalogueId(input) {
  const url=new URL(input);
  if(url.protocol!=='https:' || url.hostname!=='drive.google.com')throw new Error('Use the Google Drive file link for catalogue.json.');
  const match=url.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
  const id=match?.[1] || (url.pathname==='/open' && url.searchParams.get('id'));
  if(!id || !/^[A-Za-z0-9_-]{10,160}$/.test(id))throw new Error('Choose the link to catalogue.json inside the folder.');
  return id;
}
$('connectBooks').onclick=()=>{
  try {refreshShelf(false,driveCatalogueId($('driveLink').value.trim()));}
  catch(error){shelfMessage(error.message);}
};
$('driveLink').onkeydown=e=>{if(e.key==='Enter')$('connectBooks').click();};
$('refreshBooks').onclick=()=>refreshShelf(true);
$('importBook').onclick=()=>{showReading();};
function returnToShelf() {if(hasShelf){showShelf();refreshShelf();}}
$('backToBooks').onclick=returnToShelf;
window.addEventListener('reader-books',returnToShelf);
window.addEventListener('reader-refresh',()=>{if(!shelfBusy)refreshShelf(connectedCatalogue);else shelfMode().catch(report);});
init().catch(report);
