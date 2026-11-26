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
  constructor(store,files) { this.store=store; this.files=files; this.path='catalogue.json'; }
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
    const bytes=await this.files.download({fileId},1024*1024);
    const books=validateCatalogue(JSON.parse(new TextDecoder().decode(bytes)));
    await this.persist({...this.cache,source:fileId,books});
  }
  active(slug) {return 'active:'+this.cache.source+':'+slug;}
  async shelf(source,lang='en') {
    if(source) await this.refresh(source);
    const installed=(await this.files.list()).filter(name=>/^[a-f0-9]{64}\.book\.sqlite$/.test(name)).map(name=>name.slice(0,64));
    const listed=new Set(),books=[];
    for(const b of this.cache.books) {
      listed.add(b.bookId); listed.add(this.cache.checkpoints[this.active(b.id)]);
      const ready=new Set(b.languages[lang]?.readyPages || []);
      if(installed.includes(b.bookId)) for(const p of await this.store.readyPages(b.bookId,lang)) ready.add(p);
      books.push({id:b.id,title:b.title,author:b.author,pages:b.pages,ready:ready.size});
    }
    for(const id of installed) if(!listed.has(id)) {
      const {title,pages}=await this.store.describe(id);
      books.push({local:id,title,pages,ready:(await this.store.readyPages(id,lang)).size});
    }
    return {connected:!!this.cache.source,books};
  }
  async checkpoint(key,value) {
    await this.persist({...this.cache,checkpoints:{...this.cache.checkpoints,[key]:value}});
  }
  async install(book,lang,asset) {
    const key='installed:'+book+':'+(lang || 'source');
    if(this.cache.checkpoints[key]===asset.sha256 && await this.files.size(filename(book,lang))>=0) return;
    await this.store.importBytes(await this.files.download(asset,64*1024*1024),book,{book,lang});
    await this.checkpoint(key,asset.sha256);
  }
  async open(slug,lang='en') {
    const previous=this.cache.books.find(b=>b.id===slug);
    requireData(previous,'Book is no longer listed.');
    const prior=this.cache.checkpoints[this.active(slug)] || previous.bookId;
    const installed=await this.files.size(filename(prior))>=0;
    try {await this.refresh(this.cache.source);}
    catch(error) {
      if(installed) return {...await this.store.describe(prior),notice:'Catalogue unavailable. Opened the downloaded copy.'};
    }
    const item=this.cache.books.find(b=>b.id===slug);
    requireData(item,'Book is no longer listed.');
    try {
      await this.install(item.bookId,'',item.source);
      if(item.languages[lang]) await this.install(item.bookId,lang,item.languages[lang]);
      await this.checkpoint(this.active(slug),item.bookId);
      return await this.store.describe(item.bookId);
    } catch(error) {
      if(installed) return {...await this.store.describe(prior),notice:'Update incomplete. Opened the downloaded copy. '+error.message};
      throw error;
    }
  }
}
