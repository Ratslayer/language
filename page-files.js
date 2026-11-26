'use strict';
function decodeBytes(encoded) {
  return Uint8Array.from(atob(encoded), c=>c.charCodeAt(0));
}
async function loadSqlite() {
  const stream = new Blob([decodeBytes(sqliteGzip)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return initSqlJs({wasmBinary:await new Response(stream).arrayBuffer()});
}
class PageFiles {
  constructor(call) { this.call = call; }
  list(path='') { return this.call('files.list',{path}); }
  size(path) { return this.call('files.size',{path}); }
  remove(path) { return this.call('files.remove',{path}); }
  move(path,to) { return this.call('files.move',{path,to}); }
  temporary() { return 'work/'+crypto.randomUUID(); }
  async read(path) {
    const size=await this.size(path);
    if (size<0) throw new Error('Missing file: '+path);
    const data=new Uint8Array(size);
    for (let offset=0; offset<size;) {
      const part=decodeBytes(await this.call('files.read',{path,offset}));
      if (!part.length) throw new Error('The file changed while reading it.');
      data.set(part,offset);
      offset+=part.length;
    }
    return data;
  }
  async write(path,bytes) {
    const temp=this.temporary();
    try {
      for (let offset=0; offset<bytes.length || offset===0; offset+=192*1024) {
        const end=Math.min(bytes.length,offset+192*1024);
        let binary='';
        for(let pos=offset;pos<end;pos+=8192)
          binary+=String.fromCharCode(...bytes.subarray(pos,Math.min(pos+8192,end)));
        await this.call('files.write',{path:temp,offset,data:btoa(binary)});
      }
      await this.move(temp,path);
    } finally { await this.remove(temp); }
  }
  async download(asset,maxBytes) {
    const path=this.temporary();
    try {
      await this.call('files.downloadDrive',{path,fileId:asset.fileId,maxBytes});
      const bytes=await this.read(path);
      if (asset.sha256 && await digestHex(bytes)!==asset.sha256)
        throw new Error('The download checksum differs from the catalogue. Refresh and retry.');
      return bytes;
    } finally { await this.remove(path); }
  }
}
async function digestHex(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
}
