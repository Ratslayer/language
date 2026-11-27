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
  const {book,lang,page}=args;
  if(action==='shelf') return catalogue.shelf(args.source,state.target);
  if(action==='download') return catalogue.open(args.slug,state.target);
  if(action==='page') {
    const cached=store.cachedPage(book,lang,page,args.withIllustrations);
    if(cached) return Promise.resolve(cached);
  }
  return serialized(async ()=>{
    switch(action) {
      case 'info': return store.describe(book);
      case 'page': return store.page(book,lang,page,args.withIllustrations);
      case 'save': return store.save(book,lang,args.sid,args.entry);
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
for (const id of ['source', 'target', 'shelfTarget']) {
  $(id).replaceChildren(...Object.entries(languages).map(([code,name])=>
    new Option(code==='ru' ? 'Русский (Russian)' : name, code, false, code==='en')));
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
let shelfBusy = true;
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
  if ($('reader').hidden || !navigationPanel.hidden || !state.hash) return;
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
const openImage=createImageViewer($('imageViewer'));
function appendIllustrations(article, illustrations) {
  for (const {width,height,mime,alt,data} of illustrations) {
    const canvas=document.createElement('canvas');
    canvas.width=width; canvas.height=height;
    const label=alt || 'Book illustration',button=document.createElement('button');
    button.className='illustration'; button.type='button';
    button.setAttribute('aria-label','View '+label);
    button.setAttribute('aria-haspopup','dialog');
    button.append(canvas); article.append(button);
    const decoded=createImageBitmap(new Blob([data],{type:mime})).then(bitmap=>{
      try {
        if(canvas.isConnected) canvas.getContext('2d').drawImage(bitmap,0,0,width,height);
      } finally { bitmap.close(); }
    }).catch(()=>{
      if(button.isConnected) button.replaceWith(document.createTextNode('Could not display illustration. '+alt));
    });
    button.onclick=async()=>{
      await decoded;
      if(button.isConnected && !$('imageViewer').open) openImage(canvas,button,label);
    };
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
  $('readingVersion').hidden=true;
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
    : 'Give the contextual meaning or grammatical role of this individual word, including its contribution to an idiom. Return two short lines: contextual translation, then source-language dictionary form.';
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
  $('status').textContent = state.savedText ? '' : 'Reopen this file to resume next time.';
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
function chooseTarget(lang) {
  if(state.target!==lang) stopGeneration();
  state.target=lang;
  $('target').value=lang;
  $('shelfTarget').value=lang;
}
$('source').onchange=()=>{
  state.source=$('source').value;
  if(book) paginate();
  render(); save();
};
$('target').onchange=()=>{
  chooseTarget($('target').value);
  render(); save();
};
$('shelfTarget').onchange=()=>{
  chooseTarget($('shelfTarget').value);
  save(); refreshShelf();
};
let navigation=Promise.resolve();
let requestedPage=null;
function goToPage(page,chapterStart) {
  const total = pack?.pages ?? pages.length;
  if (!Number.isInteger(page) || page < 0 || page >= total) return Promise.resolve();
  closeNavigation();
  requestedPage=page;
  const move=moveToPage(page,chapterStart).finally(()=>{
    if(navigation===move) requestedPage=null;
  });
  navigation=move;
  return move;
}
async function moveToPage(page, chapterStart) {
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
  }
  save();
}
$('pageJump').onsubmit = event => {
  event.preventDefault();
  $('pageNumber').blur();
  goToPage($('pageNumber').valueAsNumber - 1).catch(report);
};
function turnPage(step) { goToPage((requestedPage ?? state.page) + step).catch(report); }
for (const [id, step] of [['prev',-1],['next',1]]) $(id).onclick = () => turnPage(step);
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
document.addEventListener('keydown', e => {
  if (e.altKey && e.key==='ArrowDown' && !$('reader').hidden && !$('imageViewer').open) {
    e.preventDefault();
    openNavigation();
    return;
  }
  if (e.key !== 'Escape') return;
  if (!navigationPanel.hidden) closeNavigation();
  else if (selection) closeTranslation();
});
async function init() {
  const raw = bridge ? await call('storage.read') : localStorage.getItem(storageKey);
  if (bridge) $('open').textContent = 'Open TXT or PDF';
  if (raw) Object.assign(state, JSON.parse(raw));
  state.bookmarks ||= {};
  $('source').value = state.source;
  $('target').value = state.target;
  $('shelfTarget').value = state.target;
  book = state.savedText;
  let library,incoming;
  if (bridge) {
    let privateFiles=false;
    try {privateFiles=await call('files.available');}
    catch(error) {if(error.message!=='Unsupported tool action.') throw error;}
    if(privateFiles) {
      files=new PageFiles(call);
      store=new ReaderStore(await loadSqlite(),files);
      catalogue=new BookCatalogue(store,files,serialized);
      await catalogue.init();
      packSupport=true;
      hasShelf=true;
      library=catalogue.listedShelf(state.target);
    } else {
      try {packSupport=await call('book.available');} catch {packSupport=false;}
      if(packSupport) {
        try {library=await readerAction('shelf'); hasShelf=true;}
        catch(error) {
          if(error.message!=='Unsupported book action.' && error.message!=='Unsupported tool action.') throw error;
        }
      }
    }
    $('packTools').hidden=!packSupport;
    // A document explicitly opened from Android Files goes directly to the reader.
    try {incoming=await pickDocument('text.incoming');}
    catch(error) {if(error.message!=='Unsupported tool action.') report(error);}
  }
  $('open').disabled=false;
  $('refreshBooks').hidden=!hasShelf;
  setShelfBusy(false);
  if(incoming) {await openDocument(incoming); return;}

  drawShelf(library || {books:[],connected:false});
  if(store || (hasShelf && !catalogueReady)) await refreshShelf();
  else await shelfMode();

  const job=state.job;
  if(packSupport && !generation && job && job.book===state.packId && job.lang===state.target)
    preparePage(job,true).catch(report);
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
async function loadPack(info) {
  stopTracking();
  const saved = bookmarkFor(info.book);
  if (info.book !== state.packId) stopGeneration();
  pack = info;
  state.packId = info.book;
  state.page = Math.min(Math.max(0, saved.page), info.pages - 1);
  state.source = info.lang; state.savedText = ''; state.name = info.title;
  state.hash = info.book; book = '';
  $('source').value = info.lang; $('source').disabled = true;
  $('packActions').hidden = false;
  return renderPack();
}
async function enterPack(info) {
  if (!await loadPack(info)) return;
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
  drawPackPassage();
  $('title').textContent=active.title;
  updatePageControls(active.pages);
  updateProgress();
  return true;
}
function setReadingVersion() {
  const canReadTranslation=rows.length>0 && rows.every(row=>row.entry?.translation);
  const translated=canReadTranslation && state.translatedBook===pack.book && state.translatedLanguage===state.target;
  $('readingVersion').hidden=!canReadTranslation;
  $('readingVersion').setAttribute('aria-pressed',String(translated));
  $('readingVersion').textContent=translated ? 'Read original' : 'Read in '+(languages[state.target] || state.target);
  return translated;
}
function drawPackPassage() {
  const article=$('passage'),translated=setReadingVersion();
  article.replaceChildren(); article.lang=translated ? state.target : pack.lang;
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
    if(translated) {
      anchor.textContent=row.entry.translation;
      continue;
    }
    let pos = 0;
    row.words.forEach(([start,length],wordId) => {
      paragraph.append(row.text.slice(pos,start));
      paragraph.append(wordButton(row.text.slice(start,start+length), { row, wordId, sentence:row.text, index:start }));
      pos = start+length;
    });
    paragraph.append(row.text.slice(pos));
  }
  $('status').textContent='';
}
$('readingVersion').onclick=()=>{
  closeNavigation();
  dismiss();
  const translated=$('readingVersion').getAttribute('aria-pressed')==='true';
  state.translatedBook=translated ? '' : pack.book;
  state.translatedLanguage=translated ? '' : state.target;
  drawPackPassage(); save();
};
const navigationPanel=$('readerNavigation');
let panelRevision=0;
let poppingPanelEntry=false;
function hideNavigation() {
  ++panelRevision;
  const hadFocus=navigationPanel.contains(document.activeElement);
  navigationPanel.hidden=true;
  document.querySelector('main').hidden=false;
  const saved=bookmarkFor(state.hash);
  trackPage(saved.page===state.page ? saved.scrollY : 0);
  if(hadFocus) $('title').focus({preventScroll:true});
}
function closeNavigation() {
  if(navigationPanel.hidden) return;
  hideNavigation();
  if(history.state?.languageControls && !poppingPanelEntry) {
    poppingPanelEntry=true;
    history.back();
  }
}
function pushPanelEntry() {
  history.pushState({...history.state,languageControls:state.hash},'');
}
// Older APKs expose chapter labels one page at a time. Cancel the scan when the panel closes.
async function legacyChapters(active,revision) {
  const chapters=[];
  let previous;
  for(let page=0;page<active.pages;page++) {
    if(pack!==active || revision!==panelRevision) return null;
    const items=await readerAction('page',{book:active.book,lang:state.target,page});
    for(const {chapter,id} of items) {
      if(chapter && chapter!==previous) chapters.push({chapter,id,page});
      previous=chapter;
    }
  }
  return chapters;
}
async function openNavigation() {
  if(!navigationPanel.hidden || $('reader').hidden) return;
  dismiss();
  const revision=++panelRevision,active=pack,list=$('chapterList');
  list.replaceChildren();
  $('chapterSection').hidden=!active || active.chapters?.length===0;
  $('pageNumber').value=state.page+1;
  // Read the visible sentence anchors while the passage still has a layout.
  let reachedId=rows[0]?.id;
  for(const row of rows) {
    if($('sentence-'+row.id)?.getBoundingClientRect().top<=1) reachedId=row.id;
  }
  if(!poppingPanelEntry && history.state?.languageControls!==state.hash) pushPanelEntry();
  stopTracking();
  document.querySelector('main').hidden=true;
  navigationPanel.hidden=false;
  window.scrollTo(0,0);
  $('navigationClose').focus({preventScroll:true});
  if($('chapterSection').hidden) return;
  try {
    if(!active.chapters) {
      list.textContent='Loading chapters…';
      const index=await legacyChapters(active,revision);
      if(!index || revision!==panelRevision || pack!==active) return;
      active.chapters=index;
    }
    list.replaceChildren();
    $('chapterSection').hidden=!active.chapters.length;
    let current;
    for(const start of active.chapters) {
      const button=document.createElement('button');
      button.textContent=start.chapter+' · p. '+(start.page+1);
      button.onclick=()=>goToPage(start.page,start).catch(report);
      list.append(button);
      if(start.page<state.page || (start.page===state.page && start.id<=reachedId)) current=button;
    }
    if(current) {
      current.setAttribute('aria-current','location');
      window.scrollTo(0,current.getBoundingClientRect().top-list.getBoundingClientRect().top);
    }
  } catch(error) {if(revision===panelRevision) list.textContent=error.message;}
}
$('navigationClose').onclick=closeNavigation;

let wheelDistance=0,lastWheel=0;
function pullWithWheel(event) {
  const now=event.timeStamp;
  if(now-lastWheel>250) wheelDistance=0;
  lastWheel=now;
  if(!navigationPanel.hidden || $('imageViewer').open || event.ctrlKey || window.scrollY>1 ||
     event.deltaY>=0 || Math.abs(event.deltaX)>=-event.deltaY) {
    wheelDistance=0;
    return;
  }
  const unit=event.deltaMode===1 ? 16 : event.deltaMode===2 ? window.innerHeight : 1;
  wheelDistance-=event.deltaY*unit;
  if(wheelDistance>=64) {
    wheelDistance=0;
    openNavigation();
  }
}

let drag=null;
document.addEventListener('touchstart',event=>{
  drag=null;
  if($('reader').hidden || !navigationPanel.hidden || $('imageViewer').open || event.touches.length!==1 ||
     window.visualViewport?.scale>1 || !window.getSelection().isCollapsed ||
     event.target.closest('input,select,a,#popup,button:not(.passageWord):not(.illustration)')) return;
  const {clientX:x,clientY:y}=event.touches[0];
  drag={x,y,axis:null,topY:window.scrollY<=1 ? y : null};
},{passive:true});
function moveReaderTouch(event) {
  if(!drag) return;
  if(event.touches.length!==1) {drag=null; return;}
  const {clientX,clientY}=event.touches[0];
  const dx=Math.abs(clientX-drag.x),dy=Math.abs(clientY-drag.y);
  if(!drag.axis && Math.max(dx,dy)>=12) drag.axis=dx>dy ? 'x' : 'y';
  if(window.scrollY>1) drag.topY=null;
  else if(drag.topY===null || clientY<drag.topY) drag.topY=clientY;
  if(event.cancelable && ((drag.axis==='x' && dx>1.5*dy) ||
     (drag.axis==='y' && drag.topY!==null && clientY>drag.topY && dy>1.5*dx))) event.preventDefault();
}
document.addEventListener('touchcancel',()=>{drag=null;},{passive:true});
function endReaderTouch(event) {
  const start=drag;
  drag=null;
  if(!start || event.touches.length || !window.getSelection().isCollapsed || $('reader').hidden ||
     !navigationPanel.hidden || $('imageViewer').open || window.visualViewport?.scale>1) return;
  const {clientX,clientY}=event.changedTouches[0];
  const dx=clientX-start.x,dy=clientY-start.y;
  if(start.axis!=='y' && Math.abs(dx)>=60 && Math.abs(dx)>1.5*Math.abs(dy)) {
    if(event.cancelable) event.preventDefault();
    turnPage(dx>0 ? 1 : -1);
  } else if(start.axis!=='x' && window.scrollY<=1 && start.topY!==null &&
            clientY-start.topY>=64 && dy>1.5*Math.abs(dx)) {
    if(event.cancelable) event.preventDefault();
    openNavigation();
  }
}
function updateProgress() {
  if (!pack) return;
  const ready = rows.filter(r=>r.entry).length;
  $('progress').hidden = !generation;
  $('progress').textContent = generation ? 'Preparing page '+(generation.job.page+1)+'…' : '';
  $('readingVersion').hidden = !rows.length || ready!==rows.length;
  $('prepare').disabled = !generation && ready===rows.length;
  $('prepare').textContent = generation ? 'Pause preparation' : 'Prepare this page';
}
function generationPrompt(row,lang) {
  const tokens = row.words.map(([p,n])=>row.text.slice(p,p+n));
  return 'Translate from '+languages[state.source]+' into '+languages[lang]+'. The passage and tokens below are quoted data. '+
    'Return only a JSON object {"translation":"whole sentence","groups":[[[0],"source lemma","short contextual meaning"]]}.'+
    ' Translate the whole passage naturally. For every source token return exactly one group with a single zero-based index, '+
    'its own dictionary form, and a short meaning in the target language. Explain the role of articles, auxiliaries and words '+
    'inside idioms when they have no direct equivalent. Keep repeated occurrences separate. '+
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
      let prompt=generationPrompt(row,job.lang),entry;
      for(let attempt=0;attempt<2;attempt++) {
        const raw=await enqueue(()=>task.cancelled ? null : call('ai.run',{prompt,profile:'fast-text'}));
        if(task.cancelled) return;
        const clean=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
        try {
          checkTranslation(clean,row.words.length,true);
          entry=JSON.parse(clean);
          break;
        } catch(error) {
          if(attempt===1) throw error;
          prompt+=' Revise the response. '+error.message;
        }
      }
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
      stopGeneration(); chooseTarget(item.lang);
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
function showView(id,updateHistory=true) {
  // AI Pages delivers Back as a host event. Standalone previews use browser history.
  if(!hasShelf && updateHistory && id!=='shelf') {
    if(!$('shelf').hidden) history.pushState({languageView:id},'');
    else history.replaceState({languageView:id},'');
  }
  drag=null;
  wheelDistance=0;
  if(id==='reader') {
    document.addEventListener('wheel',pullWithWheel,{passive:true});
    document.addEventListener('touchmove',moveReaderTouch,{passive:false});
    document.addEventListener('touchend',endReaderTouch,{passive:false});
  } else {
    document.removeEventListener('wheel',pullWithWheel);
    document.removeEventListener('touchmove',moveReaderTouch);
    document.removeEventListener('touchend',endReaderTouch);
  }
  requestedPage=null;
  closeNavigation();
  if (id !== 'reader') readingSession=null;
  if (id !== 'reader' && !$('reader').hidden) pageVersion++;
  stopTracking();
  dismiss();
  for (const view of ['shelf', 'fileTools', 'reader']) $(view).hidden = view !== id;
  if (id === 'fileTools') {
    $('fileStatus').textContent = pack ? pack.title + ' · Page ' + (state.page + 1) :
      bridge ? 'For scans, choose the reading language before opening the file.' : 'Open a UTF-8 text file to start reading.';
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
  $('shelfTarget').value=hasShelf && !store ? 'en' : state.target;
  $('shelfTarget').disabled=(hasShelf && !store) || shelfBusy;
  shelfMessage('');
  catalogueReady=library.connected && state.catalogueSource===catalogueFileId;
  const grid=$('bookGrid');
  grid.replaceChildren();
  const books=[...library.books];
  if(book && !state.packId) books.push({text:true,title:state.name});
  if(!hasShelf && packSupport && state.packId) books.push({local:state.packId,title:state.name});
  for (const book of books) {
    const card=document.createElement('button');
    card.className='bookCard';
    const title=document.createElement('strong'); title.textContent=book.title;
    card.append(title);
    if (book.author) {
      const author=document.createElement('span'); author.className='bookAuthor'; author.textContent=book.author; card.append(author);
    }
    if(Number.isInteger(book.pages)) {
      const count=document.createElement('span'); count.className='bookPages';
      count.textContent=book.ready+' / '+book.pages+' pages translated'; card.append(count);
    }
    card.onclick=()=>selectBook(book);
    grid.append(card);
  }
  if (!books.length && (catalogueReady || !hasShelf)) shelfMessage('No books yet.');
}
function setShelfBusy(busy) {
  shelfBusy=busy;
  $('shelfTarget').disabled=(hasShelf && !store) || busy;
  $('shelf').setAttribute('aria-busy',String(busy));
  for(const element of $('shelf').querySelectorAll('button')) element.disabled=busy;
}
let shelfRequest=0;
async function refreshShelf(refresh=false) {
  if(shelfBusy || $('shelf').hidden) return;
  if(!hasShelf) {drawShelf({books:[],connected:false}); return;}
  const request=++shelfRequest;
  if(!store) setShelfBusy(true);
  shelfMessage($('bookGrid').childElementCount ? '' : 'Loading books…');
  try {
    const fetchFromDrive=refresh || !catalogueReady;
    await shelfMode(fetchFromDrive);
    if(store && fetchFromDrive) {
      if(!catalogueReady) {
        const cached=await readerAction('shelf');
        if(request!==shelfRequest || $('shelf').hidden) return;
        if(cached.books.length) drawShelf(cached);
      }
      await catalogue.refresh(catalogueFileId);
    }
    if(request!==shelfRequest || $('shelf').hidden) return;
    const library=await readerAction('shelf',!store && fetchFromDrive ? {source:catalogueFileId} : {});
    if(request!==shelfRequest || $('shelf').hidden) return;
    if(fetchFromDrive && library.connected && state.catalogueSource!==catalogueFileId) {
      state.catalogueSource=catalogueFileId;
      save();
    }
    drawShelf(library);
  } catch(error){
    if(request===shelfRequest && !$('shelf').hidden) shelfMessage('Could not load the book catalogue. '+error.message+' Tap Refresh to retry.');
  } finally {
    if(!store) setShelfBusy(false);
    if(request===shelfRequest) await shelfMode().catch(report);
  }
}
let readingSession=null;
function rememberEdition(slug,bookId) {
  const editions=state.catalogueEditions ??= {};
  const old=Object.hasOwn(editions,slug) && editions[slug];
  if(old && old!==bookId) {
    state.bookmarks[bookId]={...bookmarkFor(old)};
    if(state.translatedBook===old) state.translatedBook=bookId;
  }
  editions[slug]=bookId;
}
async function applyBookUpdate(session,change) {
  const current=()=>readingSession===session && !$('reader').hidden && state.target===session.lang;
  // Finish a user's page jump before sampling the current page and scroll position.
  let moving;
  do {
    moving=navigation;
    await moving.catch(()=>{});
  } while(moving!==navigation);
  if(!current()) return;
  if(change.source) {
    const info=change.source;
    session.copy=catalogue.snapshot(info,session.lang);
    stopTracking();
    rememberEdition(session.slug,info.book);
    await enterPack(info);
    return;
  }
  if(pack.book!==change.translations) return;
  const revision=pageVersion;
  const updated=await readerAction('page',{book:pack.book,page:state.page,lang:session.lang});
  if(!current() || revision!==pageVersion) return;
  const entries=new Map(updated.map(row=>[row.id,row.entry]));
  for(const row of rows) row.entry=entries.get(row.id);
  if(setReadingVersion()) {
    const offset=window.scrollY;
    drawPackPassage();
    trackPage(offset);
  } else if(selection && preparedAnswer(selection,$('sentence').hidden)) {
    lookup($('sentence').hidden);
  }
  updateProgress();
}
async function checkReadingUpdates(session) {
  if(!session || session.checking || document.hidden) return;
  session.checking=true;
  try {
    session.copy=await catalogue.update(session.slug,session.lang,session.copy,change=>applyBookUpdate(session,change));
    session.lastCheck=Date.now();
  } catch {
    // Keep the open page usable offline. Retry on reconnect, resume or the next open.
    session.lastCheck=0;
  } finally {session.checking=false;}
}
window.addEventListener('online',()=>checkReadingUpdates(readingSession));
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden && readingSession && Date.now()-readingSession.lastCheck>60_000)
    checkReadingUpdates(readingSession);
});
async function selectBook(item) {
  if(shelfBusy)return;
  shelfRequest++;
  setShelfBusy(true);shelfMessage('Opening book…');
  try {
    if(item.text) {await openBook(state.name,book); return;}
    const info=item.local?await readerAction('info',{book:item.local}):await readerAction('download',{slug:item.id});
    if(!store && !item.local) chooseTarget('en');
    if(store && item.id) rememberEdition(item.id,info.book);
    await enterPack(info);
    if(store && item.id && !$('reader').hidden && pack?.book===info.book) {
      readingSession={slug:item.id,lang:state.target,copy:info,lastCheck:0};
      checkReadingUpdates(readingSession);
    }
  } catch(error){shelfMessage(error.message);}
  finally{setShelfBusy(false);}
}
$('refreshBooks').onclick=()=>refreshShelf(true);
$('importBook').onclick=async()=>{
  shelfRequest++;
  setShelfBusy(true);
  try {
    if(packSupport && !pack && state.packId) await loadPack(await readerAction('info',{book:state.packId}));
    showView('fileTools');
  } catch(error) {
    showView('fileTools'); report(error);
  } finally {setShelfBusy(false);}
};
function returnToShelf() {
  showView('shelf'); refreshShelf();
}
function closeReaderOverlay() {
  if($('imageViewer').open) $('imageViewer').close();
  else if(!navigationPanel.hidden) closeNavigation();
  else return false;
  return true;
}
function readerBack() { if(!closeReaderOverlay()) returnToShelf(); }
window.addEventListener('popstate',event=>{
  if(poppingPanelEntry) {
    poppingPanelEntry=false;
    if(!navigationPanel.hidden) pushPanelEntry();
    return;
  }
  if(event.state?.languageControls===state.hash && !$('reader').hidden) {openNavigation(); return;}
  if(!navigationPanel.hidden) {hideNavigation(); return;}
  if(hasShelf) return;
  if(closeReaderOverlay()) {history.pushState({languageView:'reader'},''); return;}
  const view=event.state?.languageView;
  if(view==='fileTools' || (view==='reader' && (pack || pages.length))) showView(view,false);
  else returnToShelf();
});
window.addEventListener('tool-back',readerBack);
window.addEventListener('tool-refresh',()=>{if(!shelfBusy)refreshShelf(true);else shelfMode().catch(report);});
window.addEventListener('reader-books',readerBack);
window.addEventListener('reader-refresh',()=>{if(!shelfBusy)refreshShelf(true);else shelfMode().catch(report);});
init().catch(report);
