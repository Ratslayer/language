'use strict';
function validateCatalogue(data) {
  requireData(data?.version===1 && Array.isArray(data.books),'Unsupported catalogue version.');
  const slugs=new Set(),books=new Set();
  function asset(a) {
    requireData(a && /^[A-Za-z0-9_-]{10,160}$/.test(a.fileId) && /^[a-f0-9]{64}$/.test(a.sha256),'Invalid catalogue asset.');
  }
  for(const b of data.books) {
    requireData(/^[a-z0-9][a-z0-9-]{0,95}$/.test(b.id) && !slugs.has(b.id) && bookIdPattern.test(b.bookId) && !books.has(b.bookId)
      && typeof b.title==='string' && b.title.trim() && Number.isInteger(b.pages) && b.pages>0,'Invalid book in catalogue.');
    slugs.add(b.id);books.add(b.bookId);asset(b.source);
    requireData(b.languages && typeof b.languages==='object' && !Array.isArray(b.languages),'Invalid catalogue languages.');
    for(const [lang,pack] of Object.entries(b.languages)) {
      asset(pack);
      requireData(langPattern.test(lang) && Array.isArray(pack.readyPages) &&
        pack.readyPages.every(n=>Number.isInteger(n) && n>=0 && n<b.pages),'Invalid translated pages.');
    }
  }
  return data.books;
}
class BookCatalogue {
  constructor(store,files,local=work=>work()) {
    this.store=store; this.files=files; this.local=local; this.path='catalogue.json';
    this.pending=new Map();
  }
  once(key,work) {
    if(!this.pending.has(key)) {
      const task=Promise.resolve().then(work).finally(()=>this.pending.delete(key));
      this.pending.set(key,task);
    }
    return this.pending.get(key);
  }
  async init() {
    const decode=bytes=>JSON.parse(new TextDecoder().decode(bytes));
    if(await this.files.size(this.path)>=0) this.cache=decode(await this.files.read(this.path));
    else {
      let legacy={};
      if(await this.files.size('legacy-catalogue.json')>=0) legacy=decode(await this.files.read('legacy-catalogue.json'));
      const {source='',books='[]',...checkpoints}=legacy;
      this.cache={source,books:JSON.parse(books),checkpoints};
      await this.persist(this.cache);
    }
    for(const name of await this.files.list('work')) await this.files.remove('work/'+name);
  }
  async persist(cache) {
    await this.files.write(this.path,new TextEncoder().encode(JSON.stringify(cache)));
    this.cache=cache;
  }
  async refresh(fileId) {
    return this.once('manifest:'+fileId,async()=>{
      const bytes=await this.files.download({fileId},1024*1024);
      const books=validateCatalogue(JSON.parse(new TextDecoder().decode(bytes)));
      await this.local(()=>this.persist({...this.cache,source:fileId,books}));
    });
  }
  active(slug) {return 'active:'+this.cache.source+':'+slug;}
  retired(book) {return 'retired:'+this.cache.source+':'+book;}
  async shelf(source,lang='en') {
    if(source) await this.refresh(source);
    return this.local(()=>this.listShelf(lang));
  }
  listedShelf(lang) {
    return {connected:!!this.cache.source,books:this.cache.books.map(b=>({
      id:b.id,title:b.title,author:b.author,pages:b.pages,ready:new Set(b.languages[lang]?.readyPages).size
    }))};
  }
  async listShelf(lang) {
    const installed=(await this.files.list()).filter(name=>/^[a-f0-9]{64}\.book\.sqlite$/.test(name)).map(name=>name.slice(0,64));
    const listed=new Set(),slugs=new Set(),shelf=this.listedShelf(lang);
    for(const [i,b] of this.cache.books.entries()) {
      slugs.add(b.id); listed.add(b.bookId); listed.add(this.cache.checkpoints[this.active(b.id)]);
      if(shelf.books[i].ready<b.pages && installed.includes(b.bookId)) {
        const ready=await this.store.readyPages(b.bookId,lang);
        for(const page of b.languages[lang]?.readyPages || []) ready.add(page);
        shelf.books[i].ready=ready.size;
      }
    }
    for(const id of installed) if(!listed.has(id) && !slugs.has(this.cache.checkpoints[this.retired(id)])) {
      const {title,pages}=await this.store.describe(id);
      shelf.books.push({local:id,title,pages,ready:(await this.store.readyPages(id,lang)).size});
    }
    return shelf;
  }
  async checkpoint(key,value) {
    await this.persist({...this.cache,checkpoints:{...this.cache.checkpoints,[key]:value}});
  }
  item(slug) {
    const item=this.cache.books.find(b=>b.id===slug);
    requireData(item,'Book is no longer listed.');
    return item;
  }
  async install(item,lang) {
    const book=item.bookId,asset=lang ? item.languages[lang] : item.source;
    if(!asset) return false;
    const key='installed:'+book+':'+(lang || 'source');
    return this.once(key+':'+asset.sha256,async()=>{
      if(this.cache.checkpoints[key]===asset.sha256 && await this.files.size(filename(book,lang))>=0) return false;
      const bytes=await this.files.download(asset,64*1024*1024);
      return this.local(async()=>{
        const current=this.item(item.id);
        requireData(current.bookId===book && (lang ? current.languages[lang] : current.source)?.sha256===asset.sha256,
          'A newer catalogue revision is available.');
        await this.store.importBytes(bytes,book,{book,lang});
        await this.checkpoint(key,asset.sha256);
        return true;
      });
    });
  }
  async activate(item) {
    return this.local(async()=>{
      requireData(this.item(item.id).bookId===item.bookId,'A newer book revision is available.');
      const key=this.active(item.id);
      const previous=this.cache.checkpoints[key];
      if(previous!==item.bookId) {
        const checkpoints={...this.cache.checkpoints,[key]:item.bookId};
        if(previous) checkpoints[this.retired(previous)]=item.id;
        await this.persist({...this.cache,checkpoints});
      }
      return this.store.describe(item.bookId);
    });
  }
  snapshot(info,lang) {
    const installed=this.cache.checkpoints;
    return {...info,sourceHash:installed['installed:'+info.book+':source'],languageHash:installed['installed:'+info.book+':'+lang]};
  }
  async open(slug,lang='en') {
    const item=this.item(slug);
    const prior=this.cache.checkpoints[this.active(slug)] || item.bookId;
    const cached=await this.local(async()=>{
      if(this.store.openSource?.book!==prior && await this.files.size(filename(prior))<0) return null;
      return this.snapshot(await this.store.describe(prior),lang);
    });
    if(cached) return cached;
    try {
      await this.install(item,'');
      return this.snapshot(await this.activate(item),lang);
    } catch(error) {
      // A first download may be using an old cached manifest.
      await this.refresh(this.cache.source);
      const latest=this.item(slug);
      if(latest.source.sha256===item.source.sha256 && latest.source.fileId===item.source.fileId) throw error;
      await this.install(latest,'');
      return this.snapshot(await this.activate(latest),lang);
    }
  }
  async update(slug,lang,opened,onChange) {
    await this.refresh(this.cache.source);
    const item=this.item(slug);
    const imported=await this.install(item,'');
    const changed=imported || opened.book!==item.bookId || opened.sourceHash!==item.source.sha256;
    if(changed || this.cache.checkpoints[this.active(slug)]!==item.bookId) {
      const info=await this.activate(item);
      if(changed) await onChange({source:info});
    }
    const translated=await this.install(item,lang);
    if(translated || (item.languages[lang] && opened.languageHash!==item.languages[lang].sha256))
      await onChange({translations:item.bookId});
    return {book:item.bookId,sourceHash:item.source.sha256,languageHash:item.languages[lang]?.sha256};
  }
}
