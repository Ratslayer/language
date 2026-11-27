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
  const session=readingSession;
  if(session?.needsSource && session.book===args.book && ['page','save','chapters','export'].includes(action))
    return ensureReadingSource(session).then(()=>{
      if(session.book!==args.book) throw new Error('The catalogue has a new edition of this book.');
      return storeAction(action,args);
    });
  return storeAction(action,args);
}
function storeAction(action,args) {
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
      case 'info': return store.describe(book,false);
      case 'chapters': return chapterIndex(await store.source(book));
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
const pronunciation = pronunciationControl($('pronounce'), $('speechStatus'), $('installVoice'), bridge ? call : null);
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
let loadingEntries = null;
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
  if ($('reader').hidden || !navigationPanel.inert || !state.hash) return;
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
  clearTurnPages();
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
  if ($('grammarDialog').open) $('grammarDialog').close();
  pronunciation.clear();
  selection?.button.classList.remove('active');
  selection?.button.parentElement.classList.remove('activeSentence');
  selection = null;
  requestVersion++;
  popup.hidden = true;
  if (popup.parentNode !== $('reader')) $('reader').append(popup);
}
const openImage=createImageViewer($('imageViewer'));
function appendIllustrations(article, illustrations, deferred) {
  for (const {width,height,mime,alt,data} of illustrations) {
    const canvas=document.createElement('canvas');
    canvas.width=width; canvas.height=height;
    const label=alt || 'Book illustration',button=document.createElement('button');
    button.className='illustration'; button.type='button';
    button.setAttribute('aria-label','View '+label);
    button.setAttribute('aria-haspopup','dialog');
    button.append(canvas); article.append(button);
    let decoded;
    const paint=()=>decoded ??= createImageBitmap(new Blob([data],{type:mime})).then(bitmap=>{
      try {
        canvas.getContext('2d').drawImage(bitmap,0,0,width,height);
      } finally { bitmap.close(); }
    }).catch(()=>{
      button.replaceWith(document.createTextNode('Could not display illustration. '+alt));
    });
    if(deferred) deferred.push(paint); else paint();
    button.onclick=async()=>{
      await paint();
      if(button.isConnected && !$('imageViewer').open) openImage(canvas,button,label);
    };
  }
}
function render() {
  if (pack) { renderPack().catch(report); return; }
  dismiss();
  fillTextPassage($('passage'),state.page);
  $('title').textContent = state.name;
  $('readingVersion').hidden=true;
  updatePageControls(pages.length);
}
function fillTextPassage(article,page) {
  article.replaceChildren();
  article.lang = state.source;
  for (const sentence of pages[page] || []) {
    const span = document.createElement('span');
    article.append(span);
    for (const part of words.segment(sentence)) {
      if (!part.isWordLike) { span.append(part.segment); continue; }
      span.append(wordButton(part.segment, { sentence, index:part.index }));
    }
  }
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
    selectScope(false);
  };
  return button;
}
function selectScope(full) {
  const {button, sentence} = selection;
  const span = button.parentElement;
  const toggle = $('sentence');
  const keepFocus = document.activeElement === toggle;
  selection.full = full;
  button.classList.toggle('active', !full);
  span.classList.toggle('activeSentence', full);
  (full ? span : button).after(popup);
  popup.hidden = false;
  $('rules').hidden=!englishWord();
  toggle.textContent = full ? 'Word' : 'Sentence';
  pronunciation.clear();
  pronunciation.select(full ? sentence.trim() : button.textContent, state.source,
    languages[state.source] || state.source, full);
  lookup();
  if (keepFocus) toggle.focus({preventScroll:true});
  popup.scrollIntoView({block:'nearest', inline:'nearest'});
}
function englishWord() { return !selection?.full && /^en(?:-|$)/i.test(state.source); }

function preparedAnswer({row, wordId, sentence, full}) {
  const entry=row?.entry;
  if (full) return typeof entry?.translation==='string' && sentence.trim()===row.text.trim() ? entry.translation.trim() : null;
  const group=entry?.groups?.find(g=>Array.isArray(g?.[0]) && g[0].includes(wordId));
  if (typeof group?.[2]!=='string' || !group[2].trim()) return null;
  return {translation:group[2].trim(),lemma:group[1],grammar:cleanGrammar(entry.grammar?.[wordId])};
}
function cacheValue(key) { return state.cache.find(entry=>entry[0]===key)?.[1]; }
function remember(key,value) {
  const previous=state.cache.findIndex(entry=>entry[0]===key);
  if (previous!==-1) state.cache.splice(previous,1);
  state.cache.push([key,value]);
  if (state.cache.length>200) state.cache.shift();
}
function parseModelObject(raw) {
  try { return JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')); }
  catch { return null; }
}
function wordAnswer(raw) {
  if (typeof raw==='object' && raw && typeof raw.translation==='string' && raw.translation.trim()) {
    const grammar=cleanGrammar(raw.grammar);
    return {translation:raw.translation.trim(),lemma:grammar?.lemma || (typeof raw.lemma==='string' ? raw.lemma : ''),grammar};
  }
  if (typeof raw!=='string' || !raw.trim()) return null;
  if (/^[{`]/.test(raw.trim())) {
    const parsed=parseModelObject(raw);
    return parsed && typeof parsed==='object' ? wordAnswer(parsed) : null;
  }
  const lines=raw.trim().split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const lemma=lines.length>1 ? lines.pop() : '';
  return {translation:lines.join('\n'),lemma};
}
function renderWordDetails() {
  if (!selection || selection.full) {
    $('wordDetails').hidden=true; $('word').textContent=''; $('grammarLabel').textContent=''; return;
  }
  const {grammar,lemma,button,grammarError}=selection;
  const english=englishWord();
  const base=(english && grammar?.lemma) || lemma || button.textContent;
  $('word').textContent=base;
  $('word').lang=state.source;
  $('grammarLabel').textContent=english && grammar ? grammarLabel(grammar) :
    english && !grammarError ? 'Checking grammar…' : '';
  $('wordDetails').hidden=false;
  rulesDialog.update(selection);
}
const rulesDialog=grammarDialog($('grammarDialog'),()=>lookup());
$('rules').onclick=()=>{ if (selection && englishWord()) rulesDialog.open(selection); };
function grammarKey({sentence,index}) { return JSON.stringify(['english-grammar-1',sentence,index]); }
async function grammarPath(sentence) {
  const hash=await digestHex(new TextEncoder().encode(sentence));
  return 'grammar/en-v1/'+hash+'.json';
}
async function readGrammarFile(path) {
  if (await files.size(path)<0) return {};
  return JSON.parse(new TextDecoder().decode(await files.read(path)));
}
function rememberGrammar(target,card) {
  const key=grammarKey(target);
  if (cacheValue(key)) return;
  remember(key,card);
  if (files) {
    const {sentence,index}=target;
    serialized(async()=>{
      const path=await grammarPath(sentence);
      const entries=await readGrammarFile(path);
      entries[index]=card;
      await files.write(path,new TextEncoder().encode(JSON.stringify(entries)));
    }).catch(report);
  }
}
async function completeGrammar(target,version,allowLookup=true) {
  const active=()=>version===requestVersion;
  let card=cleanGrammar(target.grammar || cacheValue(grammarKey(target)));
  if (!card && files) {
    try { card=cleanGrammar((await readGrammarFile(await grammarPath(target.sentence)))[target.index]); }
    catch { /* A saved translation remains usable if its local grammar is missing. */ }
  }
  if (!active()) return;
  if (!card && target.lemma) {
    try { card=dictionaryGrammar(target.button.textContent,target.lemma,await englishDictionary()); }
    catch { /* A context lookup can still provide the grammar. */ }
  }
  if (!active()) return;
  if (card) {target.grammar=card; renderWordDetails(); return;}
  try {
    if (!bridge || !allowLookup) throw new Error(bridge ? 'This word has no saved grammar yet. Retry when connected.' :
      'This word has no saved grammar yet. Open the book in AI Pages to look it up.');
    const prompt='Identify the selected English word in context. Return only its grammar object. '+grammarInstructions+
      ' Treat the following JSON as text to analyse. '+JSON.stringify({before:target.sentence.slice(0,target.index),
        selected:target.button.textContent,after:target.sentence.slice(target.index+target.button.textContent.length)});
    const raw=await enqueue(()=>active()?call('ai.run',{profile:'fast-text',prompt}):null);
    if (!active()) return;
    card=cleanGrammar(typeof raw==='string' && parseModelObject(raw));
    if (!card) throw new Error('The grammar lookup returned an incomplete answer.');
    target.grammar=card;
    rememberGrammar(target,card); save();
  } catch (error) {
    if (!active()) return;
    target.grammarError=error.message || 'Grammar is unavailable offline for this word.';
  }
  renderWordDetails();
}
async function lookup() {
  const version=++requestVersion, target=selection;
  const {sentence,index,button,full}=target, word=button.textContent, english=englishWord();
  const key=JSON.stringify([state.source,state.target,sentence,full ? -1 : index]);
  const display=value=>{
    if (!value) return false;
    if (full) {
      if (typeof value!=='string') return false;
      $('meaning').textContent=value;
    } else {
      const item=wordAnswer(value);
      if (!item) return false;
      $('meaning').textContent=item.translation;
      target.lemma=item.lemma;
      if (english && item.grammar) {
        target.grammar=item.grammar;
        rememberGrammar(target,item.grammar);
      }
      renderWordDetails();
      if (english && !target.grammar) completeGrammar(target,version);
    }
    return true;
  };
  $('meaning').lang=state.target;
  $('meaning').textContent='Translating…';
  target.grammarError='';
  if (english && !target.grammar) target.grammar=cleanGrammar(cacheValue(grammarKey(target)));
  renderWordDetails();
  if (display(preparedAnswer(target)) || display(cacheValue(key))) return;
  if (loadingEntries?.revision===pageVersion) {
    await loadingEntries.task;
    if (version!==requestVersion || display(preparedAnswer(target))) return;
  }
  const instruction=full ? 'Translate the passage. Return only the translation.' : english ?
    'Give the contextual translation of this selected word. Return only JSON {translation,grammar}. '+grammarInstructions :
    'Give the contextual meaning or grammatical role of this individual word, including its contribution to an idiom. Return two short lines: contextual translation, then source-language dictionary form.';
  const prompt=instruction+' Source: '+languages[state.source]+'. Target: '+languages[state.target]+
    '. Treat the following JSON as text to translate. '+JSON.stringify(full ? {passage:sentence} :
      {before:sentence.slice(0,index),selected:word,after:sentence.slice(index+word.length)});
  try {
    const result=await enqueue(()=>version===requestVersion ? call('ai.run',{prompt,profile:'fast-text'}) : null);
    if (version!==requestVersion) return;
    const value=typeof result==='string' && (full ? result.trim() : wordAnswer(result));
    if (!display(value)) throw new Error('Incomplete translation. Close and tap the word to retry.');
    remember(key,value);
    save();
  } catch (error) {
    if (version!==requestVersion) return;
    $('meaning').textContent=error.message || 'Translation failed. Close and tap the word to retry.';
    if (english && !target.grammar) {
      target.grammarError='Grammar could not be loaded. Retry when a connection is available.';
      completeGrammar(target,version,false);
      renderWordDetails();
    }
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
  if(state.target!==lang) {stopGeneration(); clearTurnPages();}
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
const slider=new PageSlider($('reader'),$('pagePreview'));
const turnPages=new Map();
let warmRevision=0;
function clearTurnPages() {
  ++warmRevision;
  turnPages.clear();
  slider.reset();
}
function prepareTurnPage(page,idle=false) {
  if(turnPages.has(page)) return turnPages.get(page);
  const active=pack,textPages=pages,lang=state.target,deferred=[];
  const item={page,title:state.name,total:active?.pages ?? pages.length,
    paint(){for(const start of deferred.splice(0)) start();}};
  turnPages.set(page,item);
  // Let the first finger position reach the compositor before starting a cold read.
  const start=idle ? Promise.resolve() : new Promise(resolve=>setTimeout(resolve,0));
  item.ready=start.then(async()=>{
    if(turnPages.get(page)!==item) return;
    if(active) item.rows=await readerAction('page',{book:active.book,page,lang,withIllustrations:true});
    if(turnPages.get(page)!==item || active!==pack || textPages!==pages) return;
    const article=document.createElement('article');
    article.className='readingPassage'; article.dir='auto';
    article.setAttribute('aria-label','Reading text');
    if(active) fillPackPassage(article,item.rows,readsTranslation(item.rows),deferred);
    else fillTextPassage(article,page);
    item.article=article;
  });
  item.ready.catch(()=>{if(turnPages.get(page)===item) turnPages.delete(page);});
  return item;
}
function warmTurnPages() {
  const revision=++warmRevision,page=state.page,total=pack?.pages ?? pages.length;
  for(const key of turnPages.keys()) if(Math.abs(key-page)!==1) turnPages.delete(key);
  // Speculative reads use spare time and never start a download to fill the cache.
  const idle=window.requestIdleCallback?.bind(window) ?? (fn=>setTimeout(fn,40));
  const warm=step=>{
    if(revision!==warmRevision || $('reader').hidden || !navigationPanel.inert ||
       drag || readingSession?.needsSource) return;
    if(store && pack && (store.openSource?.book!==pack.book || store.saving ||
       store.openTranslation?.path!==filename(pack.book,state.target))) return;
    const next=page+step;
    if(next>=0 && next<total) prepareTurnPage(next,true);
    if(step===1) idle(()=>warm(-1));
  };
  idle(()=>warm(1));
}
function goToPage(page,chapterStart,step=0) {
  const total=pack?.pages ?? pages.length;
  if(!Number.isInteger(page) || page<0 || page>=total) {slider.snapBack();return Promise.resolve();}
  for(const key of turnPages.keys()) if(key!==page && Math.abs(key-state.page)>1) turnPages.delete(key);
  if(!step || slider.animations.length) slider.reset();
  closeNavigation();
  requestedPage=page;
  const move=moveToPage(page,chapterStart,step).finally(()=>{
    if(navigation===move) requestedPage=null;
  });
  navigation=move;
  return move;
}
async function moveToPage(page,chapterStart,step) {
  const revision=++pageVersion;
  const current=()=>revision===pageVersion && requestedPage===page && !$('reader').hidden && navigationPanel.inert;
  let item;
  do {
    item=prepareTurnPage(page);
    try { if(!item.article) await item.ready; }
    catch(error) {
      if(!current()) return;
      slider.snapBack();
      $('pageNumber').value=state.page+1;
      throw error;
    }
    if(!current()) return;
  } while(turnPages.get(page)!==item);
  const oldPage=state.page;
  const display=()=>{
    stopTracking();
    dismiss();
    const previous=$('passage');
    previous.removeAttribute('id');
    item.article.id='passage';
    previous.replaceWith(item.article);
    item.paint();
    state.page=page;
    if(pack) {
      rows=item.rows;
      setReadingVersion();
      updateProgress();
      $('status').textContent='';
    }
    updatePageControls(item.total);
    trackPage(0);
    if(chapterStart && rows[0]?.id!==chapterStart.id) {
      $('sentence-'+chapterStart.id)?.scrollIntoView({block:'start'});
      recordScroll();
    }
  };
  if(step && !slider.reduced.matches) slider.commit(step,oldPage,item,display);
  else {slider.reset();display();}
  warmTurnPages();
  save();
  if(pack) {
    // A large illustrated bookmark can take a frame or more to encode.
    // Start that work after the slide, using only the latest displayed page.
    const displayedRows=rows, lang=state.target;
    const cache=()=>{if(rows===displayedRows && state.target===lang && state.page===page) cacheReadingPage();};
    const settling=slider.animations.at(-1);
    if(settling) settling.finished.then(cache,()=>setTimeout(cache,0));
    else cache();
  }
}
$('pageJump').onsubmit = event => {
  event.preventDefault();
  $('pageNumber').blur();
  goToPage($('pageNumber').valueAsNumber - 1).catch(report);
};
function turnPage(step) { goToPage((requestedPage ?? state.page) + step,undefined,step).catch(report); }
for (const [id, step] of [['prev',-1],['next',1]]) $(id).onclick = () => turnPage(step);
function closeTranslation() {
  const button = selection?.button;
  dismiss();
  button?.focus({ preventScroll:true });
  button?.scrollIntoView({ block:'nearest' });
}
$('close').onclick = closeTranslation;
$('sentence').onclick = () => selectScope(!selection.full);
document.addEventListener('click', e => {
  if (selection && !e.target.closest('#popup, #grammarDialog, .passageWord')) dismiss();
});
document.addEventListener('keydown', e => {
  if ($('grammarDialog').open) return;
  if (e.altKey && e.key==='ArrowDown' && !$('reader').hidden && !$('imageViewer').open) {
    e.preventDefault();
    openNavigation();
    return;
  }
  if (e.key !== 'Escape') return;
  if (!navigationPanel.inert) closeNavigation();
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
async function loadPack(info,openingRows) {
  clearTurnPages();
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
  return renderPack(state.page,openingRows,true);
}
function cacheReadingPage() {
  if(store && pack && rows.length) store.opening.save(pack,state.target,state.page,rows).catch(()=>{});
}
async function enterPack(info,openingRows) {
  if (!await loadPack(info,openingRows)) return;
  if (info.notice) $('status').textContent = info.notice;
  showView('reader');
  save();
  const job = state.job;
  if (!generation && job && job.book === info.book && job.lang === state.target)
    preparePage(job, true).catch(report);
}
async function renderPack(page=state.page,openingRows,opening=false) {
  const revision = ++pageVersion;
  const active = pack, lang = state.target;
  dismiss();
  const deferEntries=opening && !openingRows && store?.openSource?.book===active.book && !store.saving
    && store.openTranslation?.path!==filename(active.book,lang)
    && !(state.translatedBook===active.book && state.translatedLanguage===lang);
  let result;
  try {
    if(openingRows) result=openingRows;
    else if(deferEntries) result=store.readPage(store.openSource.db,null,page,true);
    else result=await readerAction('page',{book:active.book,page,lang,withIllustrations:true});
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
  if(deferEntries) {
    const task=readerAction('page',{book:active.book,page,lang}).then(updated=>{
      if(revision!==pageVersion) return;
      mergePageEntries(updated);
      cacheReadingPage();
    }).catch(error=>{if(revision===pageVersion) report(error);});
    loadingEntries={revision,task};
    task.finally(()=>{if(loadingEntries?.revision===revision) loadingEntries=null;});
  } else if(!openingRows) cacheReadingPage();
  return true;
}
function readsTranslation(items) {
  return !!items.length && state.translatedBook===pack.book && state.translatedLanguage===state.target &&
    items.every(row=>row.entry?.translation);
}
function setReadingVersion() {
  const canReadTranslation=rows.length>0 && rows.every(row=>row.entry?.translation);
  const translated=readsTranslation(rows);
  $('readingVersion').hidden=!canReadTranslation;
  $('readingVersion').setAttribute('aria-pressed',String(translated));
  $('readingVersion').textContent=translated ? 'Read original' : 'Read in '+(languages[state.target] || state.target);
  return translated;
}
function drawPackPassage() {
  fillPackPassage($('passage'),rows,setReadingVersion());
  $('status').textContent='';
}
function fillPackPassage(article,items,translated,deferred) {
  article.replaceChildren(); article.lang=translated ? state.target : pack.lang;
  const sentences = new Intl.Segmenter(pack.lang, {granularity:'sentence'});
  let paragraph = null, lastPara = null;
  for (const row of items) {
    if (row.illustrations?.length) {
      appendIllustrations(article,row.illustrations,deferred);
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
    let wordId = 0, pos = 0;
    for (const {segment:sentence, index:offset} of sentences.segment(row.text)) {
      const end = offset + sentence.length;
      const span = offset === 0 ? anchor : document.createElement('span');
      if (offset) paragraph.append(span);
      while (wordId < row.words.length && row.words[wordId][0] < end) {
        const [start, length] = row.words[wordId];
        span.append(row.text.slice(pos,start), wordButton(row.text.slice(start,start+length),
          {row, wordId, sentence, index:start-offset}));
        pos = start + length;
        wordId++;
      }
      span.append(row.text.slice(pos,end));
      pos = Math.max(pos,end);
    }
  }
}
$('readingVersion').onclick=()=>{
  clearTurnPages();
  closeNavigation();
  dismiss();
  const translated=$('readingVersion').getAttribute('aria-pressed')==='true';
  state.translatedBook=translated ? '' : pack.book;
  state.translatedLanguage=translated ? '' : state.target;
  drawPackPassage(); warmTurnPages(); save();
};
const navigationPanel=$('readerNavigation');
let panelRevision=0;
let poppingPanelEntry=false;
function hideNavigation() {
  ++panelRevision;
  const hadFocus=navigationPanel.contains(document.activeElement);
  navigationPanel.inert=true;
  document.querySelector('main').inert=false;
  const saved=bookmarkFor(state.hash);
  trackPage(saved.page===state.page ? saved.scrollY : 0);
  if(hadFocus) $('title').focus({preventScroll:true});
}
function closeNavigation() {
  if(navigationPanel.inert) return;
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
  if(!navigationPanel.inert || $('reader').hidden) return;
  requestedPage=null;
  slider.reset();
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
  document.querySelector('main').inert=true;
  navigationPanel.inert=false;
  navigationPanel.scrollTop=0;
  $('navigationClose').focus({preventScroll:true});
  if($('chapterSection').hidden) return;
  try {
    if(!active.chapters) {
      list.textContent='Loading chapters…';
      const index=store ? await readerAction('chapters',{book:active.book}) : await legacyChapters(active,revision);
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
      navigationPanel.scrollTop=current.offsetTop-list.offsetTop;
    }
  } catch(error) {if(revision===panelRevision) list.textContent=error.message;}
}
$('navigationClose').onclick=closeNavigation;

let wheelDistance=0,lastWheel=0;
function pullWithWheel(event) {
  const now=event.timeStamp;
  if(now-lastWheel>250) wheelDistance=0;
  lastWheel=now;
  if(!navigationPanel.inert || $('imageViewer').open || $('grammarDialog').open || event.ctrlKey || window.scrollY>1 ||
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
  if(drag?.axis==='x' || slider.animations.length) slider.reset();
  drag=null;
  if($('reader').hidden || $('imageViewer').open || $('grammarDialog').open || event.touches.length!==1 ||
     window.visualViewport?.scale>1 || !window.getSelection().isCollapsed) return;
  const {clientX:x,clientY:y}=event.touches[0];
  if(!navigationPanel.inert) {
    // A fresh upward pull at the end dismisses the controls. Other drags scroll the chapters.
    if(navigationPanel.contains(event.target) && !event.target.closest('input') &&
       navigationPanel.scrollTop+navigationPanel.clientHeight>=navigationPanel.scrollHeight-1)
      drag={x,y,axis:null,panel:true};
    return;
  }
  if(event.target.closest('input,select,a,#popup,button:not(.passageWord):not(.illustration)')) return;
  drag={x,y,axis:null,width:innerWidth,time:event.timeStamp,topY:window.scrollY<=1 ? y : null};
},{passive:true});
function moveReaderTouch(event) {
  if(!drag) return;
  if(event.touches.length!==1) {slider.reset();drag=null;return;}
  const {clientX,clientY}=event.touches[0];
  const dx=Math.abs(clientX-drag.x),dy=Math.abs(clientY-drag.y);
  if(!drag.axis && Math.max(dx,dy)>=6) {
    if(dx>1.35*dy) drag.axis='x';
    else if(dy>dx) drag.axis='y';
  }
  if(drag.panel) {
    if(event.cancelable && drag.axis==='y' && drag.y-clientY>1.5*dx) event.preventDefault();
    return;
  }
  if(drag.axis==='x') {
    if(event.cancelable) event.preventDefault();
    const step=clientX<drag.x ? 1 : -1, page=(requestedPage ?? state.page)+step;
    const target=page>=0 && page<(pack?.pages ?? pages.length) ? prepareTurnPage(page) : null;
    slider.drag(clientX-drag.x,drag.width,step,target);
    return;
  }
  if(window.scrollY>1) drag.topY=null;
  else if(drag.topY===null || clientY<drag.topY) drag.topY=clientY;
  if(event.cancelable && drag.axis==='y' && drag.topY!==null && clientY>drag.topY && dy>1.5*dx) event.preventDefault();
}
document.addEventListener('touchcancel',()=>{if(drag?.axis==='x') slider.snapBack();drag=null;},{passive:true});
function endReaderTouch(event) {
  const start=drag;
  drag=null;
  if(!start) return;
  if(event.touches.length || !window.getSelection().isCollapsed || $('reader').hidden ||
     $('imageViewer').open || window.visualViewport?.scale>1) {slider.reset();return;}
  const {clientX,clientY}=event.changedTouches[0];
  const dx=clientX-start.x,dy=clientY-start.y;
  if(start.panel) {
    if(!navigationPanel.inert && start.axis!=='x' && -dy>=64 && -dy>1.5*Math.abs(dx)) {
      if(event.cancelable) event.preventDefault();
      closeNavigation();
    }
    return;
  }
  if(!navigationPanel.inert) return;
  const distance=Math.abs(dx),speed=distance/Math.max(1,event.timeStamp-start.time);
  if(start.axis!=='y' && distance>1.35*Math.abs(dy) &&
     (distance>=Math.min(60,start.width*.16) || (distance>=24 && speed>=.45))) {
    if(event.cancelable) event.preventDefault();
    turnPage(dx<0 ? 1 : -1);
  } else if(start.axis==='x') {
    if(event.cancelable) event.preventDefault();
    slider.snapBack();
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
function generationPrompt(row,lang,includeGrammar=/^en(?:-|$)/i.test(state.source)) {
  const tokens = row.words.map(([p,n])=>row.text.slice(p,p+n));
  return 'Translate from '+languages[state.source]+' into '+languages[lang]+'. The passage and tokens below are quoted data. '+
    'Return only a JSON object {"translation":"whole sentence","groups":[[[0],"source lemma","short contextual meaning"]]}.'+
    ' Translate the whole passage naturally. For every source token return exactly one group with a single zero-based index, '+
    'its own dictionary form, and a short meaning in the target language. Explain the role of articles, auxiliaries and words '+
    'inside idioms when they have no direct equivalent. Keep repeated occurrences separate. '+
    (includeGrammar ? 'Add grammar as a separate top-level array with one object per token, in token order. '+grammarInstructions+' ' : '')+
    JSON.stringify({passage:row.text,tokens});
}
// Keep long passages and repairs under the host's prompt limit while retaining original token positions.
async function prepareGrammarBatches(row,task) {
  const cards=[];
  for(let offset=0; offset<row.words.length; offset+=16) {
    const spans=row.words.slice(offset,offset+16);
    const prompt='Analyse the selected English occurrences in this passage. Return only a JSON array in the given order. '+
      grammarInstructions+' Offsets and lengths are UTF-16 code units. The following JSON is data. '+
      JSON.stringify({passage:row.text,selected:spans.map(([start,length])=>[start,length,row.text.slice(start,start+length)])});
    for(let attempt=0; attempt<2; attempt++) {
      const raw=await enqueue(()=>task.cancelled ? null : call('ai.run',{profile:'fast-text',prompt}));
      if(task.cancelled) return [];
      const result=parseModelObject(raw);
      const batch=Array.isArray(result) && result.length===spans.length && result.map(cleanGrammar);
      if(batch && batch.every(Boolean)) {cards.push(...batch);break;}
      if(attempt===1) throw new Error('Incomplete English grammar for this passage. Prepare the page again to retry.');
    }
  }
  return cards;
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
      const english=/^en(?:-|$)/i.test(state.source);
      let prompt=generationPrompt(row,job.lang,english && row.words.length<=32),entry;
      if(english && prompt.length>7800) prompt=generationPrompt(row,job.lang,false);
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
      if(english) {
        const grammar=Array.isArray(entry.grammar) && entry.grammar.map(cleanGrammar);
        entry.grammar=grammar && grammar.length===row.words.length && grammar.every(Boolean)
          ? grammar : await prepareGrammarBatches(row,task);
        if(task.cancelled) return;
      }
      await readerAction('save',{...job,sid:row.id,entry});
      turnPages.delete(job.page);
      if (task.cancelled) return;
      if (pack?.book===job.book && state.page===job.page && state.target===job.lang) {
        const shown = rows.find(r=>r.id===row.id);
        if (shown) {shown.entry=entry;cacheReadingPage();}
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
  clearTurnPages();
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
    warmTurnPages();
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
let openRequest=0;
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
  mergePageEntries(updated);
  cacheReadingPage();
}
function mergePageEntries(updated) {
  turnPages.clear();
  warmTurnPages();
  const entries=new Map(updated.map(row=>[row.id,row.entry]));
  for(const row of rows) row.entry=entries.get(row.id);
  if(setReadingVersion()) {
    const offset=window.scrollY;
    drawPackPassage();
    trackPage(offset);
  } else if(selection && preparedAnswer(selection)) {
    lookup();
  }
  updateProgress();
}
async function checkReadingUpdates(session) {
  if(!session || session.checking || document.hidden) return;
  session.checking=true;
  try {
    if(session.needsSource) await ensureReadingSource(session);
    if(readingSession!==session) return;
    session.copy=await catalogue.update(session.slug,session.lang,session.copy,change=>applyBookUpdate(session,change));
    session.lastCheck=Date.now();
  } catch(error) {
    if(readingSession===session && session.needsSource) $('status').textContent='Opening page available. The rest of the book could not download. '+error.message;
    // Keep the open page usable offline. Retry on reconnect, resume or the next open.
    session.lastCheck=0;
  } finally {session.checking=false;}
}
window.addEventListener('online',()=>checkReadingUpdates(readingSession));
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden && readingSession && Date.now()-readingSession.lastCheck>60_000)
    checkReadingUpdates(readingSession);
});
async function ensureReadingSource(session) {
  if(!session.sourceTask) {
    session.sourceTask=(async()=>{
      const info=await catalogue.open(session.slug,session.lang);
      const previous=session.book;
      session.book=info.book;
      session.copy=info;
      session.needsSource=false;
      if(readingSession===session && pack?.book===previous) {
        if(previous!==info.book || session.previewHash!==info.sourceHash) {
          const page=requestedPage;
          stopTracking();
          rememberEdition(session.slug,info.book);
          await enterPack(info);
          if(Number.isInteger(page) && readingSession===session) await goToPage(Math.min(page,info.pages-1));
        } else {
          Object.assign(pack,info);
          $('status').textContent='';
          warmTurnPages();
          cacheReadingPage();
        }
      }
    })().catch(error=>{session.sourceTask=null;throw error;});
  }
  return session.sourceTask;
}
async function selectBook(item) {
  if(shelfBusy)return;
  const request=++openRequest,lang=state.target;
  shelfRequest++;
  setShelfBusy(true);shelfMessage('Opening book…');
  try {
    if(item.text) {await openBook(state.name,book); return;}
    const listed=store && item.id ? catalogue.item(item.id) : null;
    const bookId=listed ? catalogue.installedBook(item.id) : item.local;
    let opening,warmInfo,needsSource=false;
    if(store && bookId && store.openSource?.book===bookId && store.openTranslation?.path===filename(bookId,lang) && !store.saving)
      warmInfo=await store.describe(bookId,false);
    else if(store && bookId) {
      const previousEdition=listed && state.catalogueEditions?.[item.id];
      const page=bookmarkFor(previousEdition && previousEdition!==bookId ? previousEdition : bookId).page;
      opening=await store.opening.read(bookId,lang,page);
      if(!opening && listed?.bookId===bookId && page===0) {
        opening=await catalogue.firstPage(listed,lang);
        needsSource=!!opening;
      }
    }
    if(request!==openRequest) return;
    const info=warmInfo || opening?.info || (item.local ? await readerAction('info',{book:item.local})
      : await readerAction('download',{slug:item.id}));
    if(request!==openRequest) return;
    if(!store && !item.local) chooseTarget('en');
    let session=null;
    if(listed) {
      rememberEdition(item.id,info.book);
      session={slug:item.id,previewHash:listed.source.sha256,book:info.book,lang,copy:catalogue.snapshot(info,lang),needsSource,lastCheck:0};
      readingSession=session;
    }
    await enterPack(info,opening?.rows);
    if(request!==openRequest || $('reader').hidden || pack!==info) return;
    if(needsSource) $('status').textContent='Downloading the rest of the book…';
    // Yield a frame before loading the rest of a saved book or checking Drive.
    requestAnimationFrame(()=>setTimeout(async()=>{
      if(request!==openRequest || pack!==info) return;
      if(opening && !needsSource) {
        await serialized(async()=>{
          if(request!==openRequest) return;
          await store.source(info.book);
          if(request===openRequest) await store.translations(info.book,lang);
        }).catch(()=>{}); // Navigation can retry a failed background read.
      }
      if(opening && !needsSource && request===openRequest && pack===info) warmTurnPages();
      if(session && readingSession===session) checkReadingUpdates(session);
    },0));
  } catch(error){if(request===openRequest) shelfMessage(error.message);}
  finally{if(request===openRequest) setShelfBusy(false);}
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
  openRequest++; pageVersion++; setShelfBusy(false);
  showView('shelf'); refreshShelf();
}
function closeReaderOverlay() {
  if($('grammarDialog').open) $('grammarDialog').close();
  else if($('imageViewer').open) $('imageViewer').close();
  else if(!navigationPanel.inert) closeNavigation();
  else return false;
  return true;
}
function readerBack() { if(!closeReaderOverlay()) returnToShelf(); }
window.addEventListener('popstate',event=>{
  if(poppingPanelEntry) {
    poppingPanelEntry=false;
    if(!navigationPanel.inert) pushPanelEntry();
    return;
  }
  if(event.state?.languageControls===state.hash && !$('reader').hidden) {openNavigation(); return;}
  if(!navigationPanel.inert) {hideNavigation(); return;}
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
