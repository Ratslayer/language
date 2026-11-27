'use strict';

// Each book keeps one independently readable page, including its offline glosses and illustrations.
class OpeningPages {
  constructor(files) {
    this.files=files;
    this.pending=new Map();
    this.latest=new Map();
  }
  path(book) { return 'opening/'+filename(book)+'.json'; }
  queue(book,work) {
    const previous=this.pending.get(book) || Promise.resolve();
    const task=previous.catch(()=>{}).then(work);
    this.pending.set(book,task);
    return task.finally(()=>{if(this.pending.get(book)===task) this.pending.delete(book);});
  }
  discard(book) {
    this.latest.delete(book);
    return this.queue(book,()=>this.files.remove(this.path(book)));
  }
  save(info,lang,page,rows) {
    const token={};
    this.latest.set(info.book,token);
    return this.queue(info.book,async()=>{
      if(this.latest.get(info.book)!==token) return;
      const packet={info,page,lang,rows};
      const json=JSON.stringify(packet,(key,value)=>key==='data' && value instanceof Uint8Array ? encodeBytes(value) : value);
      await this.files.write(this.path(info.book),new TextEncoder().encode(json));
    });
  }
  async read(book,lang,page) {
    try {
      await this.pending.get(book);
      const path=this.path(book);
      if(await this.files.size(path)<0) return null;
      const packet=JSON.parse(new TextDecoder().decode(await this.files.read(path)));
      if(packet.info.book!==book || packet.lang!==lang || packet.page!==page) return null;
      return unpackOpeningPage(packet,book,page);
    } catch {return null;} // Older installations, interrupted caches and storage pressure use the ordinary open.
  }
}

function unpackOpeningPage(packet,book,page) {
  const {info,rows}=packet;
  requireData(info.book===book && info.format===bookFormat && langPattern.test(info.lang)
    && typeof info.title==='string' && Number.isSafeInteger(info.pages) && page>=0 && page<info.pages
    && packet.page===page && Array.isArray(rows) && rows.length,'Invalid opening page.');
  for(const row of rows) {
    checkWords(row.text,row.words);
    if(row.entry) checkTranslation(JSON.stringify(row.entry),row.words.length);
    for(const image of row.illustrations || []) {
      requireData(Number.isInteger(image.width) && Number.isInteger(image.height) && image.width>0 && image.height>0
        && image.width*image.height<=32_000_000 && ['image/jpeg','image/png','image/webp'].includes(image.mime)
        && typeof image.data==='string','Invalid opening illustration.');
      image.data=decodeBytes(image.data);
    }
  }
  return {info,rows};
}
