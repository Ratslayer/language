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
