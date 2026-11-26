'use strict';

const $ = id => document.getElementById(id);
const popup = $('popup');
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

let files, store, catalogue;
let dataQueue=Promise.resolve();
// Serialize SQL snapshots and catalogue checkpoints, independently of UI prompts.
function serialized(work) {
  const result=dataQueue.then(work);
  dataQueue=result.catch(()=>{});
  return result;
}
function readerAction(action,args={}) {
  if(!store) return call('book.'+action,args); // Pages can update before the APK.
  return serialized(async ()=>{
    const {book,lang,page}=args;
    switch(action) {
      case 'info': return store.describe(book);
      case 'page': return store.page(book,lang,page,args.withIllustrations);
      case 'save': return store.save(book,lang,args.sid,args.entry);
      case 'shelf': return catalogue.shelf(args.source);
      case 'download': return catalogue.open(args.slug);
      case 'pick': {
        const path=files.temporary();
        try {
          if(!await call('files.pick',{path,mime:'*/*'})) return null;
          return await store.importBytes(await files.read(path),book);
        } finally {await files.remove(path);}
      }
      case 'export': {
        const path=filename(book,lang);
        if(await files.size(path)<0) throw new Error('There are no translations to export yet.');
        return call('files.export',{path,mime:'application/vnd.sqlite3',name:(lang || 'book')+'.sqlite'});
      }
    }
  });
}
async function pickDocument(action) {
  const args={includePdf:true,language:state.source};
  if(!store) return call(action,{...args,asBook:packSupport});
  const path=files.temporary();
  try {
    const picked=await call(action,{...args,path,pageBreaks:true});
    if(!picked) return null;
    const text=new TextDecoder().decode(await files.read(path));
    return await serialized(()=>store.fromText(picked.name,args.language,text));
  } finally {await files.remove(path);}
}

const languages = { de:'German', en:'English', ru:'Russian', fr:'French', es:'Spanish',
  it:'Italian', pt:'Portuguese', nl:'Dutch', sv:'Swedish', pl:'Polish', uk:'Ukrainian',
  tr:'Turkish', ar:'Arabic', he:'Hebrew', hi:'Hindi', ja:'Japanese', zh:'Chinese', ko:'Korean' };
for (const id of ['source', 'target']) {
  for (const [code, name] of Object.entries(languages)) $(id).add(new Option(name, code));
}
const storageKey = 'language-reader-v1';
let state = { source:'de', target:'en', page:0, name:'', hash:'', savedText:'', cache:[], bookmarks:{} };
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
const catalogueFileId = '1_f_zhiRS4UjK8lzw5aXr80Iv2G7RpVTd';
let catalogueReady = false;
const byteCount = text => new TextEncoder().encode(text).length;
function report(error) {
  if (!$('shelf').hidden) shelfMessage(error.message);
  else ($('fileTools').hidden ? $('status') : $('fileStatus')).textContent = error.message;
}
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

// Only the rendered book owns scroll events. Catalogue and loading screens never write its offset.
let readingPosition = null;
let scrollSave = 0;
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
function bookmarkFor(id) {
  const saved = state.bookmarks[id];
  // Earlier versions stored page numbers directly and kept the open book's page separately.
  if (Number.isInteger(saved?.page)) return saved;
  const previous = Number.isInteger(saved) ? saved : 0;
  const page = id === (state.packId || state.hash) ? state.page : previous;
  return { page, scrollY:0 };
}
function recordScroll() {
  if (!readingPosition) return false;
  const y = Math.max(0, Math.round(window.scrollY));
  if (readingPosition.scrollY === y) return false;
  readingPosition.scrollY = y;
  return true;
}
function flushScroll() {
  const changed = recordScroll();
  if (changed || scrollSave) save();
  clearTimeout(scrollSave);
  scrollSave = 0;
}
function stopTracking() {
  flushScroll();
  readingPosition = null;
}
function trackPage(offset) {
  if ($('reader').hidden || !state.hash) return;
  window.scrollTo(0, Number.isFinite(offset) ? offset : 0);
  readingPosition = { page:state.page, scrollY:Math.max(0, Math.round(window.scrollY)) };
  state.bookmarks[state.hash] = readingPosition;
}
window.addEventListener('scroll', () => {
  if (recordScroll() && !scrollSave) {
    save();
    scrollSave = setTimeout(flushScroll, 180);
  }
}, { passive:true });
window.addEventListener('pagehide', flushScroll);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushScroll(); });

function updatePageControls(total) {
  const number = state.page + 1;
  $('pageJump').hidden = !total;
  $('pageNumber').max = total;
  $('pageNumber').value = number;
  $('pageTotal').textContent = 'of ' + total;
  $('count').textContent = number + ' / ' + total;
  document.querySelector('nav').hidden = total < 2;
  $('prev').disabled = number <= 1;
  $('next').disabled = number >= total;
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
  popup.hidden = true;
  if (popup.parentNode !== $('reader')) $('reader').append(popup);
}
function appendIllustrations(article, illustrations) {
  for (const {width,height,mime,alt,data} of illustrations) {
    const canvas=document.createElement('canvas');
    canvas.width=width; canvas.height=height;
    canvas.setAttribute('role','img');
    canvas.setAttribute('aria-label',alt || 'Book illustration');
    article.append(canvas);
    createImageBitmap(new Blob([data],{type:mime})).then(bitmap=>{
      try {
        if(canvas.isConnected) canvas.getContext('2d').drawImage(bitmap,0,0,width,height);
      } finally { bitmap.close(); }
    }).catch(()=>{
      if(canvas.isConnected) canvas.replaceWith(document.createTextNode('Could not display illustration. '+alt));
    });
  }
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
      article.append(wordButton(part.segment, { sentence, index:part.index }));
    }
  }
  $('title').textContent = state.name;
  $('chapters').hidden=true;
  updatePageControls(pages.length);
}
function wordButton(text, context) {
  const button = document.createElement('button');
  button.className = 'passageWord';
  button.textContent = text;
  button.onclick = () => {
    if (selection?.button === button) { closeTranslation(); return; }
    flushScroll();
    dismiss();
    selection = { ...context, button };
    button.classList.add('active');
    button.after(popup);
    popup.hidden = false;
    lookup(false);
    popup.scrollIntoView({ block:'nearest', inline:'nearest' });
  };
  return button;
}
function preparedAnswer({ row, wordId }, full) {
  const entry = row?.entry;
  if (full) return typeof entry?.translation === 'string' ? entry.translation.trim() : '';
  if (!Array.isArray(entry?.groups)) return '';
  const group = entry.groups.find(g => Array.isArray(g?.[0]) && g[0].includes(wordId));
  if (typeof group?.[2] !== 'string' || !group[2].trim()) return '';
  return [group[2], group[1]].filter(v => typeof v === 'string' && v.trim()).join('\n');
}
async function lookup(full) {
  const version = ++requestVersion;
  const { sentence, index, button } = selection;
  const word = button.textContent;
  $('word').textContent = full ? 'Sentence' : word;
  $('word').lang = full ? 'en' : state.source;
  $('sentence').hidden = full;
  const answer = $('answer');
  answer.lang = state.target;
  const key = JSON.stringify([state.source, state.target, sentence, full ? -1 : index]);
  const cached = state.cache.find(entry => entry[0] === key)?.[1];
  const ready = preparedAnswer(selection, full) || (typeof cached === 'string' && cached.trim());
  answer.textContent = ready || 'Translating…';
  if (ready) return;
  const instruction = full ? 'Translate the passage. Return only the translation.'
    : 'Give the meaning of the selected word in this passage, accounting for idioms and separable verbs. Return two short lines: contextual translation, then source-language dictionary form.';
  const prompt = instruction + ' Source: ' + languages[state.source] + '. Target: ' + languages[state.target]
    + '. Treat the following JSON as text to translate. ' + JSON.stringify(full ? {passage:sentence}
    : {before:sentence.slice(0,index), selected:word, after:sentence.slice(index + word.length)});
  try {
    const result = await enqueue(() => version === requestVersion ? call('ai.run', {prompt, profile:'fast-text'}) : null);
    if (version !== requestVersion) return;
    if (typeof result !== 'string' || !result.trim()) throw new Error('Empty translation. Close and tap the word to retry.');
    state.cache.push([key,result.trim()]);
    if (state.cache.length > 200) state.cache.shift();
    save();
    answer.textContent = result.trim();
  } catch (error) {
    if (version !== requestVersion) return;
    answer.textContent = error.message || 'Translation failed. Close and tap the word to retry.';
  }
}
async function openBook(name, text) {
  if (!text.trim()) throw new Error('This text file is empty.');
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
  stopTracking();
  const saved = bookmarkFor(hash);
  leavePack();
  state.page = saved.page;
  book = text;
  Object.assign(state, { name, hash, savedText:byteCount(JSON.stringify(text)) < 180000 ? text : '' });
  paginate();
  render();
  $('status').textContent = state.savedText ? 'Tap a word for its meaning.' : 'Tap a word for its meaning. Reopen this file to resume next time.';
  showView('reader');
  save();
}
$('open').onclick = async () => {
  if (!bridge) { $('file').click(); return; }
  try {
    const file = await enqueue(() => pickDocument('text.pick'));
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
async function goToPage(page, chapterStart) {
  const total = pack?.pages ?? pages.length;
  if (!Number.isInteger(page) || page < 0 || page >= total) return;
  if (pack) {
    if (!await renderPack(page)) return;
  } else {
    stopTracking();
    state.page = page;
    render();
  }
  trackPage(0);
  if (chapterStart && rows[0]?.id!==chapterStart.id) {
    $('sentence-'+chapterStart.id)?.scrollIntoView({block:'start'});
    recordScroll();
    $('chapters').textContent=chapterStart.chapter+' ▾';
  }
  save();
}
$('pageJump').onsubmit = event => {
  event.preventDefault();
  $('pageNumber').blur();
  goToPage($('pageNumber').valueAsNumber - 1).catch(report);
};
for (const [id, step] of [['prev',-1],['next',1]]) $(id).onclick = () => goToPage(state.page + step).catch(report);
function closeTranslation() {
  const button = selection?.button;
  dismiss();
  button?.focus({ preventScroll:true });
  button?.scrollIntoView({ block:'nearest' });
}
$('close').onclick = closeTranslation;
$('sentence').onclick = () => lookup(true);
document.addEventListener('click', e => {
  if (selection && !e.target.closest('#popup, .passageWord')) dismiss();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && selection) closeTranslation(); });
async function init() {
  const raw = bridge ? await call('storage.read') : localStorage.getItem(storageKey);
  if (bridge) $('open').textContent = 'Open TXT or PDF';
  if (raw) Object.assign(state, JSON.parse(raw));
  state.bookmarks ||= {};
  $('source').value = state.source;
  $('target').value = state.target;
  book = state.savedText;
  if (book) { state.page = bookmarkFor(state.hash).page; paginate(); }
  render();
  if (book) {
    $('status').textContent = 'Tap a word for its meaning.';
    showView('reader');
  }
  $('fileStatus').textContent = state.name && !book
    ? 'Reopen the file to resume at your saved page.' : bridge ? 'Open a text file or PDF. For scans, choose the reading language first.' : 'Open a UTF-8 text file to start reading.';
  if (bridge) {
    let privateFiles=false;
    try {privateFiles=await call('files.available');}
    catch(error) {if(error.message!=='Unsupported tool action.') throw error;}
    if(privateFiles) {
      files=new PageFiles(call);
      store=new ReaderStore(await loadSqlite(),files);
      catalogue=new BookCatalogue(store,files);
      await catalogue.init();
      packSupport=true;
    } else {
      try {packSupport=await call('book.available');} catch {packSupport=false;}
    }
    $('packTools').hidden = !packSupport;
    if (packSupport && state.packId) {
      try { await enterPack(await readerAction('info',{book:state.packId}), false); }
      catch(error) { report(error); }
    }
    let incoming = false;
    try {
      const file = await pickDocument('text.incoming');
      if (file) {await openDocument(file); incoming = true;}
    } catch (error) {
      // Older hosts only support the in-app picker.
      if (error.message !== 'Unsupported tool action.') report(error);
    }
    if (packSupport) {
      try {
        const library = await readerAction('shelf');
        hasShelf = true;
        $('backToBooks').textContent = '‹ Books';
        if (!incoming) {
          showView('shelf'); drawShelf(library);
          if (!catalogueReady) await refreshShelf();
        }
        else await shelfMode();
      } catch (error) { if (error.message !== 'Unsupported book action.' && error.message !== 'Unsupported tool action.') report(error); }
    }
  }
  if (!hasShelf) $('backToBooks').textContent = '‹ Local files';
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
  stopTracking();
  const saved = bookmarkFor(info.book);
  if (changing && info.book !== state.packId) stopGeneration();
  pack = info;
  state.packId = info.book;
  state.page = Math.min(Math.max(0, saved.page), info.pages - 1);
  state.source = info.lang; state.savedText = ''; state.name = info.title;
  state.hash = info.book; book = '';
  $('source').value = info.lang; $('source').disabled = true;
  $('packActions').hidden = false;
  if (!await renderPack()) return;
  if (info.notice) $('status').textContent = info.notice;
  showView('reader');
  save();
  const job = state.job;
  if (!generation && job && job.book === info.book && job.lang === state.target)
    preparePage(job, true).catch(report);
}
async function renderPack(page = state.page) {
  const revision = ++pageVersion;
  const active = pack, lang = state.target;
  dismiss();
  let result;
  try {
    result = await readerAction('page',{book:active.book,page,lang,withIllustrations:true});
  } catch (error) {
    if (revision !== pageVersion) return false;
    $('pageNumber').value = state.page + 1;
    throw error;
  }
  if (revision !== pageVersion) return false;
  stopTracking();
  state.page = page;
  dismiss();
  rows = result;
  const article = $('passage');
  article.replaceChildren(); article.lang = active.lang;
  let paragraph = null, lastPara = null;
  for (const row of rows) {
    if (row.illustrations?.length) {
      appendIllustrations(article,row.illustrations);
      paragraph=null;
    }
    if (!paragraph || row.para !== lastPara) {
      paragraph = document.createElement('p'); article.append(paragraph); lastPara = row.para;
    } else paragraph.append(' ');
    const anchor=document.createElement('span');
    anchor.id='sentence-'+row.id;
    paragraph.append(anchor);
    let pos = 0;
    row.words.forEach(([start,length],wordId) => {
      paragraph.append(row.text.slice(pos,start));
      paragraph.append(wordButton(row.text.slice(start,start+length), { row, wordId, sentence:row.text, index:start }));
      pos = start+length;
    });
    paragraph.append(row.text.slice(pos));
  }
  $('title').textContent=active.title;
  $('chapters').hidden=active.chapters ? !active.chapters.length : !rows[0].chapter;
  $('chapters').textContent=(rows[0].chapter || 'Chapters')+' ▾';
  updatePageControls(active.pages);
  $('status').textContent = 'Tap a word for its meaning.';
  updateProgress();
  return true;
}
// Older APKs expose chapter labels one page at a time. Build their index only on demand.
async function legacyChapters(active) {
  const chapters=[];
  let previous;
  for(let page=0;page<active.pages;page++) {
    if(pack!==active || !$('chapterDialog').open) return null;
    const items=await readerAction('page',{book:active.book,lang:state.target,page});
    for(const {chapter,id} of items) {
      if(chapter && chapter!==previous) chapters.push({chapter,id,page});
      previous=chapter;
    }
  }
  return chapters;
}
$('chapters').onclick=async ()=>{
  const active=pack, dialog=$('chapterDialog'), list=$('chapterList');
  list.replaceChildren();
  dialog.showModal();
  try {
    if(!active.chapters) {
      list.textContent='Loading chapters…';
      const index=await legacyChapters(active);
      if(!index) return;
      active.chapters=index;
    }
    if(pack!==active || !dialog.open) return;
    list.replaceChildren();
    let current;
    for(const start of active.chapters) {
      const button=document.createElement('button');
      button.textContent=start.chapter+' · p. '+(start.page+1);
      button.onclick=()=>{
        dialog.close();
        goToPage(start.page,start).catch(report);
      };
      list.append(button);
      if(start.page<state.page || (start.page===state.page &&
        (start.id===rows[0]?.id || $('sentence-'+start.id)?.getBoundingClientRect().top<=0))) current=button;
    }
    if(current) {
      current.setAttribute('aria-current','location');
      current.scrollIntoView({block:'nearest'});
    }
  } catch(error) {list.textContent=error.message;}
};
$('chapterClose').onclick=()=>$('chapterDialog').close();
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
    const pageRows = await readerAction('page',job);
    for (const row of pageRows) {
      if (task.cancelled) return;
      if (row.entry) continue;
      const prompt = generationPrompt(row,job.lang);
      const raw = await enqueue(()=>task.cancelled ? null : call('ai.run',{prompt,profile:'fast-text'}));
      if (task.cancelled) return;
      const clean = raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i,'').replace(/\s*\x60\x60\x60$/,'');
      const entry = JSON.parse(clean);
      await readerAction('save',{...job,sid:row.id,entry});
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
    const item = await enqueue(()=>readerAction('pick',{book:pack?.book || ''}));
    if (!item) return;
    if (item.format==='reader.book.1') await enterPack(item);
    else {
      stopGeneration(); state.target=item.lang; $('target').value=item.lang;
      if (await renderPack()) { showView('reader'); save(); }
    }
  } catch(error) {report(error);}
};
for (const id of ['exportBook','exportLang']) $(id).onclick = async () => {
  try {
    const bookId = pack.book, lang = id==='exportBook'?'':state.target;
    const saved=await enqueue(()=>readerAction('export',{book:bookId,lang}));
    if (saved) $('fileStatus').textContent='Offline file saved.';
  } catch(error){report(error);}
};

function shelfMode(refreshing=false) {
  if (!hasShelf) return Promise.resolve();
  const visible=!$('shelf').hidden;
  if(store) return call('ui.navigation',{handlesBack:!visible,pullToRefresh:visible,refreshing});
  return call('book.shelfMode',{visible,refreshing});
}
function showView(id) {
  if (id !== 'reader' && !$('reader').hidden) pageVersion++;
  stopTracking();
  dismiss();
  for (const view of ['shelf', 'fileTools', 'reader']) $(view).hidden = view !== id;
  if (id === 'fileTools') {
    $('filesBack').hidden = !hasShelf && !pack && !book;
    $('filesBack').textContent = hasShelf ? '‹ Books' : '‹ Return to book';
    $('fileStatus').textContent = pack ? pack.title + ' · Page ' + (state.page + 1) : '';
  }
  if (id === 'reader') {
    const saved = bookmarkFor(state.hash);
    trackPage(saved.page === state.page ? saved.scrollY : 0);
  } else window.scrollTo(0, 0);
  shelfMode().catch(report);
}
function shelfMessage(message) {
  $('shelfStatus').textContent=message || '';
  $('shelfStatus').hidden=!message;
}
function drawShelf(library) {
  catalogueReady=library.connected && state.catalogueSource===catalogueFileId;
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
  if (library.books.length===0 && catalogueReady) shelfMessage('No books in this catalogue yet.');
}
function setShelfBusy(busy) {
  shelfBusy=busy;
  $('shelf').setAttribute('aria-busy',String(busy));
  for(const element of $('shelf').querySelectorAll('button')) element.disabled=busy;
}
async function refreshShelf(refresh=false) {
  if(shelfBusy || $('shelf').hidden) return;
  setShelfBusy(true);shelfMessage('');
  try {
    const fetchFromDrive=refresh || !catalogueReady;
    await shelfMode(fetchFromDrive);
    const library=await readerAction('shelf',fetchFromDrive ? {source:catalogueFileId} : {});
    if(fetchFromDrive && library.connected && state.catalogueSource!==catalogueFileId) {
      state.catalogueSource=catalogueFileId;
      save();
    }
    drawShelf(library);
  } catch(error){shelfMessage('Could not load the book catalogue. '+error.message+' Tap Refresh to retry.');}
  finally{setShelfBusy(false);await shelfMode().catch(report);}
}
async function selectBook(item) {
  if(shelfBusy)return;
  setShelfBusy(true);shelfMessage(item.local?'Opening book…':'Checking for book updates…');
  try {
    const info=item.local?await readerAction('info',{book:item.local}):await readerAction('download',{slug:item.id});
    if(state.target!=='en')stopGeneration();
    state.target='en';$('target').value='en';
    await enterPack(info);
  } catch(error){shelfMessage(error.message);}
  finally{setShelfBusy(false);}
}
$('refreshBooks').onclick=()=>refreshShelf(true);
$('importBook').onclick = () => showView('fileTools');
function returnToShelf() {
  if (hasShelf) { showView('shelf'); refreshShelf(); }
  else showView('fileTools');
}
$('backToBooks').onclick = returnToShelf;
$('filesBack').onclick = () => hasShelf ? returnToShelf() : showView('reader');
window.addEventListener('tool-back',()=> $('chapterDialog').open ? $('chapterDialog').close() : returnToShelf());
window.addEventListener('tool-refresh',()=>{if(!shelfBusy)refreshShelf(true);else shelfMode().catch(report);});
window.addEventListener('reader-books',returnToShelf);
window.addEventListener('reader-refresh',()=>{if(!shelfBusy)refreshShelf(true);else shelfMode().catch(report);});
init().catch(report);
