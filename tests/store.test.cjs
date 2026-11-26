const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const init=require('sql.js');
const scripts=['page-files.js','reader-store.js','book-catalogue.js'].map(p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8'));
const {ReaderStore,BookCatalogue,filename}=vm.runInThisContext(scripts.join('\n')+'\n;({ReaderStore,BookCatalogue,filename})');
class MemoryFiles {
  data=new Map();
  async size(name){return this.data.get(name)?.length ?? -1;}
  async read(name){return this.data.get(name).slice();}
  async write(name,value){this.data.set(name,value.slice());}
  async remove(name){this.data.delete(name);}
  async list(dir){return dir?[]:[...this.data.keys()];}
}
const entry=(word)=>({translation:word,groups:[[[0],word,word]]});
test('atomic translation merge, sentence validation, and repeated chapter titles',async()=>{
  const SQL=await init(),files=new MemoryFiles(),store=new ReaderStore(SQL,files);
  const {book}=await store.fromText('Test','en','One. Two. Three.');
  const source=new SQL.Database(await files.read(filename(book)));
  source.run("UPDATE sentences SET chapter=CASE id WHEN 2 THEN 'II' ELSE 'I' END");
  const info=await store.importBytes(source.export(),book,{book,lang:''});
  assert.deepEqual(info.chapters.map(r=>[r.chapter,r.page,r.id]),[['I',0,1],['II',0,2],['I',0,3]]);
  await store.save(book,'fr',1,entry('un'));
  const pack=new SQL.Database(await files.read(filename(book,'fr')));
  pack.run('INSERT INTO entries VALUES(2,?),(3,?)',[JSON.stringify(entry('deux')),'{}']);
  await assert.rejects(store.importBytes(pack.export(),book));
  const restarted=new ReaderStore(SQL,files);
  const rows=await restarted.page(book,'fr',0);
  assert.equal(rows[0].entry.translation,'un');
  assert.equal(rows[1].entry,undefined);
  pack.run('DELETE FROM entries WHERE sid=3');
  await restarted.importBytes(pack.export(),book);
  assert.equal((await restarted.page(book,'fr',0))[1].entry.translation,'deux');
  assert.equal((await restarted.readyPages(book,'fr')).size,0);
  await restarted.save(book,'fr',3,entry('trois'));
  assert.deepEqual([...await restarted.readyPages(book,'fr')],[0]);
  source.close();pack.close();
});
test('legacy catalogue and local translations reopen offline after moving the files',async()=>{
  const SQL=await init(),files=new MemoryFiles(),store=new ReaderStore(SQL,files);
  const {book}=await store.fromText('Test','en','One.');
  await store.save(book,'en',1,entry('one'));
  const row={id:'first',bookId:book,title:'Test',pages:1,languages:{},source:{}};
  await files.write('legacy-catalogue.json',new TextEncoder().encode(JSON.stringify({source:'index',books:JSON.stringify([row]),'active:index:first':book})));
  const catalogue=new BookCatalogue(store,files);
  await catalogue.init();
  files.download=async()=>{throw new Error('offline');};
  assert.equal((await catalogue.shelf()).books[0].ready,1);
  assert.equal((await catalogue.open('first')).book,book);
  const restarted=new BookCatalogue(new ReaderStore(SQL,files),files);
  await restarted.init();
  assert.equal((await restarted.shelf()).books.length,1);
});
test('illustrations stay with their caption across import and reopen',async()=>{
  const SQL=await init(),files=new MemoryFiles(),store=new ReaderStore(SQL,files);
  const {book}=await store.fromText('Illustrated','en','First. Caption.');
  const source=new SQL.Database(await files.read(filename(book)));
  source.run('UPDATE sentences SET page=1 WHERE id=2');
  source.run('CREATE TABLE illustrations(sid,position,width,height,mime,alt,data,PRIMARY KEY(sid,position))');
  for(const pos of [1,0]) source.run('INSERT INTO illustrations VALUES(2,?,1,1,?,?,?)',
    [pos,'image/webp','Panel '+pos,new Uint8Array([1,2,3])]);
  await store.importBytes(source.export(),book,{book,lang:''});
  const reopened=new ReaderStore(SQL,files);
  assert.equal((await reopened.page(book,'ru',0,true))[0].illustrations,undefined);
  assert.equal((await reopened.page(book,'ru',1))[0].illustrations,undefined);
  const [caption]=await reopened.page(book,'ru',1,true);
  assert.deepEqual(caption.illustrations.map(i=>i.alt),['Panel 0','Panel 1']);
  assert.deepEqual(Array.from(caption.illustrations[0].data),[1,2,3]);
  source.run('UPDATE illustrations SET sid=3');
  await assert.rejects(store.importBytes(source.export(),book,{book,lang:''}),/Invalid book illustration/);
  source.close();
});
test('shelf counts and downloads use the selected language',async()=>{
  const SQL=await init(),files=new MemoryFiles(),store=new ReaderStore(SQL,files);
  const {book}=await store.fromText('Painting','en','Paint.');
  const item={id:'painting',bookId:book,title:'Painting',pages:1,source:{},languages:{ru:{readyPages:[0]},en:{readyPages:[]}}};
  await files.write('catalogue.json',new TextEncoder().encode(JSON.stringify({source:'index',books:[item],checkpoints:{}})));
  const catalogue=new BookCatalogue(store,files);
  await catalogue.init();
  // The first paint of a cached shelf does not depend on opening local databases.
  const preview=catalogue.listedShelf('ru');
  assert.deepEqual(preview,{connected:true,books:[{id:'painting',title:'Painting',author:undefined,pages:1,ready:1}]});
  assert.equal(catalogue.listedShelf('en').books[0].ready,0);
  assert.equal((await catalogue.shelf(undefined,'ru')).books[0].ready,1);
  assert.equal((await catalogue.shelf(undefined,'en')).books[0].ready,0);
  const installs=[];
  catalogue.refresh=async()=>{};
  catalogue.install=async(item,lang)=>{assert.equal(item.bookId,book);installs.push(lang);};
  const cached=await catalogue.open('painting','ru');
  assert.deepEqual(installs,[]);
  await catalogue.update('painting','ru',cached,()=>{});
  assert.deepEqual(installs,['','ru']);
});
test('cached pages remain readable during delayed refresh and translation download, and a failed update is retryable',async()=>{
  const SQL=await init(),files=new MemoryFiles(),store=new ReaderStore(SQL,files);
  const {book}=await store.fromText('Old','en','First. Second.');
  const newer=new ReaderStore(SQL,new MemoryFiles());
  const revised=await newer.fromText('New','en','Third. Fourth.');
  await newer.save(revised.book,'ru',1,entry('три'));
  const original={fileId:'oldBookFile',sha256:'a'.repeat(64)};
  const replacement={fileId:'newBookFile',sha256:'b'.repeat(64)};
  const lang={fileId:'russianFile',sha256:'c'.repeat(64),readyPages:[]};
  const item={id:'painting',title:'Old',bookId:book,pages:1,source:original,languages:{}};
  const manifest={version:1,books:[{...item,title:'New',bookId:revised.book,source:replacement,languages:{ru:lang}}]};
  const encode=obj=>new TextEncoder().encode(JSON.stringify(obj));
  const index='catalogueFile';
  await files.write('catalogue.json',encode({source:index,books:[item],checkpoints:{
    ['active:'+index+':painting']:book,['installed:'+book+':source']:original.sha256
  }}));
  const catalogue=new BookCatalogue(store,files);
  await catalogue.init();
  const opened=await catalogue.open(item.id,'ru');
  await store.page(book,'ru',0);
  const manifestGate=Promise.withResolvers(),packGate=Promise.withResolvers();
  const calls=[];
  files.download=async({fileId})=>{
    calls.push(fileId);
    if(fileId===index) {await manifestGate.promise;return encode(manifest);}
    if(fileId===replacement.fileId) return newer.files.read(filename(revised.book));
    await packGate.promise;throw new Error('offline');
  };
  const switched=Promise.withResolvers();
  const syncing=catalogue.update(item.id,'ru',opened,async change=>{
    assert.equal(change.source.title,'New'); await store.page(revised.book,'ru',0); switched.resolve();
  });
  const repeated=catalogue.refresh(index);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[index]);
  assert.equal(store.cachedPage(book,'ru',0)[0].text,'First.');
  manifestGate.resolve();await repeated;await switched.promise;
  assert.equal(store.cachedPage(revised.book,'ru',0)[0].text,'Third.');
  packGate.resolve();await assert.rejects(syncing,/offline/);
  const cached=await catalogue.open(item.id,'ru');
  assert.equal(cached.book,revised.book);
  assert.deepEqual((await catalogue.shelf()).books.map(b=>b.id),['painting']);
  files.download=async({fileId})=>fileId===index ? encode(manifest) : newer.files.read(filename(revised.book,'ru'));
  const changes=[];
  await catalogue.update(item.id,'ru',cached,c=>changes.push(c));
  assert.deepEqual(changes,[{translations:revised.book}]);
  assert.equal(store.cachedPage(revised.book,'ru',0)[0].entry.translation,'три');
  await catalogue.update(item.id,'ru',await catalogue.open(item.id,'ru'),()=>assert.fail('unchanged book redrew'));
});
test('new translations require one meaning per word and legacy packs still import',async()=>{
  const SQL=await init(),files=new MemoryFiles(),store=new ReaderStore(SQL,files);
  const {book}=await store.fromText('Test','en','Brush up.');
  const phrase={translation:'Освежить.',groups:[[[0,1],'brush up','освежить']]};
  const words={translation:phrase.translation,groups:[[[0],'brush','освежать'],[[1],'up','частица фразового глагола']]};
  await assert.rejects(store.save(book,'ru',1,phrase),/each word/);
  await store.save(book,'ru',1,words);
  assert.deepEqual((await store.page(book,'ru',0))[0].entry,words);
  const legacy=new SQL.Database(await files.read(filename(book,'ru')));
  legacy.run('UPDATE entries SET payload=? WHERE sid=1',[JSON.stringify(phrase)]);
  await store.importBytes(legacy.export(),book,{book,lang:'ru'});
  assert.deepEqual((await store.page(book,'ru',0))[0].entry,phrase);
  legacy.close();
});
