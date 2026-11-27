import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import zopfli from '@gfx/zopfli';
import { transform } from 'esbuild';

import { englishMorphology } from './scripts/english-morphology.mjs';
import { browserTagger } from './scripts/english-tagger.mjs';

const vendor = 'node_modules/sql.js/';
// Denser build-time gzip and Z85 keep the localized reader within the legacy signed catalogue's size limit.
const compressed = Buffer.from(await zopfli.gzipAsync(await readFile(vendor+'dist/sql-wasm-browser.wasm'), {}));
const alphabet='0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';
function encode85(bytes) {
  const padded=Buffer.alloc(Math.ceil(bytes.length/4)*4);
  bytes.copy(padded);
  let result='';
  for(let i=0;i<padded.length;i+=4) {
    let n=padded.readUInt32BE(i),group='';
    for(let j=0;j<5;j++) {group=alphabet[n%85]+group; n=Math.floor(n/85);}
    result+=group;
  }
  return result;
}
const notices=[await readFile(vendor+'LICENSE','utf8'),await readFile('node_modules/wink-pos-tagger/LICENSE','utf8'),
  await readFile('node_modules/wink-lexicon/LICENSE','utf8'),
  'wink-lexicon includes fnTBL data, copyright Johns Hopkins University, Radu Florian and Grace Ngai (https://www.cs.jhu.edu/~rflorian/fntbl/license.html).',
  'English morphology adapted from jsRealB, RALI, Université de Montréal. https://github.com/rali-udem/jsRealB — CC BY 4.0 https://creativecommons.org/licenses/by/4.0/'];
const bundle = [
  await readFile(vendor+'dist/sql-wasm-browser.js','utf8'),
  'const sqliteAlphabet='+JSON.stringify(alphabet)+',sqliteSize='+compressed.length+',sqliteGzip='+JSON.stringify(encode85(compressed))+';',
  await readFile('page-files.js','utf8'), await readFile('reader-store.js','utf8'),
  'const englishMorphologyGzip = '+JSON.stringify(englishMorphology())+';',
  await browserTagger(),await readFile('english-grammar.js','utf8'),await readFile('english-analysis.js','utf8'),await readFile('grammar-russian.js','utf8'),await readFile('grammar-dialog.js','utf8'),
  await readFile('pronunciation.js','utf8'),
  await readFile('opening-pages.js','utf8'), await readFile('book-catalogue.js','utf8'), await readFile('image-viewer.js','utf8'), await readFile('page-slider.js','utf8'), await readFile('app.js','utf8'),
];
await mkdir('dist',{recursive:true});
const {code}=await transform('(()=>{\n'+bundle.join('\n;\n')+'\n})()',{minify:true,charset:'utf8',target:'es2022',legalComments:'none'});
await writeFile('dist/app.js','/* '+notices.join('\n')+' */\n'+code);
for (const name of ['index.html','style.css']) await copyFile(name,'dist/'+name);
