'use strict';
const bookFormat='reader.book.1', translationFormat='reader.translation.1';
const bookIdPattern=/^[0-9a-f]{64}$/, langPattern=/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
function requireData(ok,message) { if (!ok) throw new Error(message); }
function filename(book,lang='') {
  requireData(bookIdPattern.test(book) && (!lang || langPattern.test(lang)), 'Invalid book or language.');
  return book+'.'+(lang || 'book')+'.sqlite';
}
function eachRow(db,sql,params,visit) {
  const statement=db.prepare(sql);
  try {
    statement.bind(params);
    while (statement.step()) visit(statement.getAsObject());
  } finally {statement.free();}
}
function queryRows(db,sql,params=[]) {
  const result=[];
  eachRow(db,sql,params,row=>result.push(row));
  return result;
}
function storedTable(db,name) {
  const [row]=queryRows(db,'SELECT type, sql FROM sqlite_master WHERE name=?',[name]);
  requireData(row?.type==='table' && /^CREATE TABLE\s/i.test(row.sql),'Invalid '+name+' table.');
}
function hasIllustrations(db) {
  return queryRows(db,"SELECT 1 FROM sqlite_master WHERE name='illustrations' AND type='table'").length>0;
}
function validateIllustrations(db) {
  storedTable(db,'illustrations');
  eachRow(db,`SELECT i.sid, s.id AS anchor, i.position, i.width, i.height, i.mime, i.alt,
    typeof(i.data) AS storage, length(i.data) AS bytes
    FROM illustrations i LEFT JOIN sentences s ON s.id=i.sid`,[],r=>{
    requireData(r.anchor!=null && Number.isSafeInteger(r.position) && r.position>=0
      && Number.isInteger(r.width) && Number.isInteger(r.height) && r.width>0 && r.height>0
      && r.width*r.height<=32_000_000 && ['image/jpeg','image/png','image/webp'].includes(r.mime)
      && typeof r.alt==='string' && r.storage==='blob' && r.bytes>0 && r.bytes<=16*1024*1024,
      'Invalid book illustration.');
  });
}
function metadata(db) {
  storedTable(db,'meta');
  const result=queryRows(db,'SELECT format, book_id AS book, lang, title FROM meta LIMIT 2');
  const info=result[0];
  requireData(result.length===1 && bookIdPattern.test(info.book) && langPattern.test(info.lang)
    && typeof info.title==='string','Invalid file metadata.');
  return info;
}
function checkWords(text,words) {
  requireData(typeof text==='string' && text.length>0 && text.length<=4096
    && Array.isArray(words) && words.length<=1400,'Invalid sentence.');
  let end=0;
  for (const [start,len] of words) {
    requireData(Number.isInteger(start) && Number.isInteger(len) && start>=end && len>0
      && start+len<=text.length,'Invalid word position.');
    end=start+len;
  }
}
function checkTranslation(payload,count) {
  requireData(typeof payload==='string' && payload.length<=180000,'Invalid translation record.');
  const entry=JSON.parse(payload);
  requireData(typeof entry?.translation==='string' && entry.translation.trim() && Array.isArray(entry.groups),'Missing translation.');
  const seen=new Set();
  for (const [ids,lemma,meaning] of entry.groups) {
    requireData(Array.isArray(ids) && ids.length && typeof lemma==='string' && lemma.trim()
      && typeof meaning==='string' && meaning.trim(),'Incomplete word meaning.');
    for (const id of ids) {
      requireData(Number.isInteger(id) && id>=0 && id<count && !seen.has(id),'Invalid translation word index.');
      seen.add(id);
    }
  }
  requireData(seen.size===count,'Translation does not cover every word.');
}
function chapterIndex(db) {
  return queryRows(db,`WITH ordered AS (
    SELECT id,page,chapter,LAG(chapter) OVER (ORDER BY id) AS previous FROM sentences
  ) SELECT id,page,chapter FROM ordered WHERE trim(chapter)<>'' AND chapter IS NOT previous ORDER BY id`);
}

class ReaderStore {
  constructor(SQL,files) { this.SQL=SQL; this.files=files; }
  async source(book) {
    if(this.openSource?.book===book) return this.openSource.db;
    const db=new this.SQL.Database(await this.files.read(filename(book)));
    try {db.run('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');}
    catch(error){db.close();throw error;}
    this.openSource?.db.close();
    this.openSource={book,db};
    return db;
  }
  async describe(book) {
    const db=await this.source(book);
    return {...metadata(db), pages:queryRows(db,'SELECT max(page)+1 AS n FROM sentences')[0].n, chapters:chapterIndex(db)};
  }
  async translations(book,lang,create=false) {
    const path=filename(book,lang);
    if(this.openTranslation?.path===path) return this.openTranslation.db;
    let db;
    if(await this.files.size(path)>=0) db=new this.SQL.Database(await this.files.read(path));
    else if(create) {
      db=new this.SQL.Database();
      db.run('CREATE TABLE meta(format TEXT,book_id TEXT,lang TEXT,title TEXT)');
      db.run('INSERT INTO meta VALUES(?,?,?,?)',[translationFormat,book,lang,'']);
      db.run('CREATE TABLE entries(sid INTEGER PRIMARY KEY,payload TEXT NOT NULL)');
    } else return null;
    db.run('PRAGMA trusted_schema=OFF');
    this.closeTranslations();
    this.openTranslation={path,db};
    return db;
  }
  closeTranslations() {
    this.openTranslation?.db.close();
    this.openTranslation=null;
  }
  async page(book,lang,page,withIllustrations=false) {
    const db=await this.source(book), translations=await this.translations(book,lang);
    const rows=queryRows(db,'SELECT id,para,chapter,pdf_start AS pdf,pdf_end AS pdfEnd,text,words FROM sentences WHERE page=? ORDER BY id',[page]);
    requireData(rows.length,'Page does not exist.');
    const entries=new Map();
    if(translations) eachRow(translations,'SELECT sid,payload FROM entries WHERE sid BETWEEN ? AND ?',
      [rows[0].id,rows.at(-1).id],r=>entries.set(r.sid,JSON.parse(r.payload)));
    for (const row of rows) {
      row.words=JSON.parse(row.words);
      row.entry=entries.get(row.id);
    }
    if(withIllustrations && hasIllustrations(db)) {
      const byId=new Map(rows.map(row=>[row.id,row]));
      eachRow(db,`SELECT sid,width,height,mime,alt,data FROM illustrations
        WHERE sid BETWEEN ? AND ? ORDER BY sid,position`,[rows[0].id,rows.at(-1).id],r=>{
        (byId.get(r.sid).illustrations ??= []).push(r);
      });
    }
    return rows;
  }
  async readyPages(book,lang) {
    const entries=await this.translations(book,lang);
    if(!entries) return new Set();
    const ids=new Set(queryRows(entries,'SELECT sid FROM entries').map(r=>r.sid));
    const complete=new Map();
    eachRow(await this.source(book),'SELECT id,page FROM sentences ORDER BY id',[],r=>{
      complete.set(r.page,complete.get(r.page)!==false && ids.has(r.id));
    });
    return new Set([...complete].filter(([,ready])=>ready).map(([page])=>page));
  }
  async writeTranslations(book,lang,apply) {
    const db=await this.translations(book,lang,true);
    try {
      db.run('BEGIN');
      apply(db);
      db.run('COMMIT');
      await this.files.write(filename(book,lang),db.export());
    } catch(error) {
      this.closeTranslations(); // Next read sees the last atomically saved snapshot.
      throw error;
    }
  }
  async save(book,lang,sid,entry) {
    const source=await this.source(book);
    const [row]=queryRows(source,'SELECT words FROM sentences WHERE id=?',[sid]);
    requireData(row,'Unknown sentence.');
    const payload=JSON.stringify(entry);
    checkTranslation(payload,JSON.parse(row.words).length);
    await this.writeTranslations(book,lang,db=>db.run('INSERT OR IGNORE INTO entries VALUES(?,?)',[sid,payload]));
  }
  async importBytes(bytes,current,expected) {
    const db=new this.SQL.Database(bytes);
    try {
      db.run('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
      requireData(db.exec('PRAGMA quick_check(1)')[0]?.values[0][0]==='ok','Damaged SQLite file.');
      const info=metadata(db);
      if(expected) requireData(info.book===expected.book && info.format===(expected.lang?translationFormat:bookFormat)
        && (!expected.lang || expected.lang===info.lang),'File differs from the catalogue.');
      if(info.format===translationFormat) {
        requireData(info.book===current,'Open the matching book before its translation.');
        storedTable(db,'entries');
        const source=await this.source(current);
        const counts=new Map();
        eachRow(source,'SELECT id,words FROM sentences',[],r=>counts.set(r.id,JSON.parse(r.words).length));
        await this.writeTranslations(current,info.lang,dest=>{
          const insert=dest.prepare('INSERT OR '+(expected?'REPLACE':'IGNORE')+' INTO entries(sid,payload) VALUES(?,?)');
          try {
            eachRow(db,'SELECT sid,payload FROM entries',[],r=>{
              requireData(counts.has(r.sid),'Unknown sentence.');
              checkTranslation(r.payload,counts.get(r.sid));
              insert.run([r.sid,r.payload]);
            });
          } finally {insert.free();}
        });
        return info;
      }
      requireData(info.format===bookFormat,'Unsupported book format.');
      storedTable(db,'sentences');
      let previousPage=-1,lastId=0;
      eachRow(db,'SELECT id,page,para,chapter,pdf_start,pdf_end,text,words FROM sentences ORDER BY id',[],r=>{
        requireData(Number.isInteger(r.id) && r.id>lastId && Number.isInteger(r.page) && r.page>=0
          && (r.page===previousPage || r.page===previousPage+1),'Invalid pagination.');
        checkWords(r.text,JSON.parse(r.words));
        lastId=r.id; previousPage=r.page;
      });
      requireData(lastId>0,'Empty book.');
      if(hasIllustrations(db)) validateIllustrations(db);
      const path=filename(info.book);
      if(expected || await this.files.size(path)<0) {
        await this.files.write(path,bytes);
        if(this.openSource?.book===info.book){this.openSource.db.close();this.openSource=null;}
      }
      return await this.describe(info.book);
    } finally {db.close();}
  }
  async fromText(name,lang,text) {
    const book=await digestHex(new TextEncoder().encode(bookFormat+'\n'+lang+'\n'+text));
    if(await this.files.size(filename(book))>=0) return this.describe(book);
    const db=new this.SQL.Database();
    try {
      db.run('CREATE TABLE meta(format TEXT,book_id TEXT,lang TEXT,title TEXT)');
      db.run('INSERT INTO meta VALUES(?,?,?,?)',[bookFormat,book,lang,name]);
      db.run('CREATE TABLE sentences(id INTEGER PRIMARY KEY,page INTEGER,para INTEGER,chapter TEXT,pdf_start INTEGER,pdf_end INTEGER,text TEXT,words TEXT); CREATE INDEX pages ON sentences(page,id)');
      const sentence=new Intl.Segmenter(lang,{granularity:'sentence'}), word=new Intl.Segmenter(lang,{granularity:'word'});
      let page=0,size=0,para=0,sid=0,pdf=0;
      const insert=db.prepare("INSERT INTO sentences VALUES(?,?,?,'',?,?,?,?)");
      try {
        for(const sheet of text.split('\f')) {
          pdf++;
          for(const paragraph of sheet.split(/[\r\n\v\u0085\u2028\u2029]+/)) {
            para++;
            for(const {segment} of sentence.segment(paragraph)) {
              for(let start=0;start<segment.length;) {
                let end=Math.min(start+1050,segment.length);
                if(end<segment.length) {
                  const space=segment.lastIndexOf(' ',end-1);
                  if(space>start+500) end=space+1;
                  else if(/[\uD800-\uDBFF]/.test(segment[end-1])) end--;
                }
                const part=segment.slice(start,end).trim();
                start=end;
                if(!part) continue;
                if(size && size+part.length>1400){page++;size=0;}
                const words=Array.from(word.segment(part)).filter(w=>w.isWordLike).map(w=>[w.index,w.segment.length]);
                insert.run([++sid,page,para,pdf,pdf,part,JSON.stringify(words)]);
                size+=part.length+1;
              }
            }
          }
        }
      } finally {insert.free();}
      requireData(sid,'No readable text in this file.');
      await this.files.write(filename(book),db.export());
    } finally {db.close();}
    return this.describe(book);
  }
}
