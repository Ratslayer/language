import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const vendor = 'node_modules/sql.js/';
const compressed = gzipSync(await readFile(vendor+'dist/sql-wasm-browser.wasm'), {level:9});
const bundle = [
  '/* '+await readFile(vendor+'LICENSE','utf8')+' */',
  await readFile(vendor+'dist/sql-wasm-browser.js','utf8'),
  'const sqliteGzip = '+JSON.stringify(compressed.toString('base64'))+';',
  await readFile('page-files.js','utf8'), await readFile('reader-store.js','utf8'),
  await readFile('pronunciation.js','utf8'),
  await readFile('opening-pages.js','utf8'), await readFile('book-catalogue.js','utf8'), await readFile('image-viewer.js','utf8'), await readFile('page-slider.js','utf8'), await readFile('app.js','utf8'),
];
await mkdir('dist',{recursive:true});
await writeFile('dist/app.js',bundle.join('\n;\n'));
for (const name of ['index.html','style.css']) await copyFile(name,'dist/'+name);
