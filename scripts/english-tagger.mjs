import {createRequire} from 'node:module';
import {basename} from 'node:path';
import {build} from 'esbuild';
import lexicon from 'wink-lexicon/src/lexicon.js';
import massNouns from 'wink-lexicon/src/uncountable-nouns.js';

const require=createRequire(import.meta.url);
const tables=['value-rules-le0','pos-rules-le0','value-rules-ge0','pos-rules-ge0'];

// The published rules contain repeated keys and regexes. Keep the data in the
// compressed dictionary; run wink's original engine over those same tables.
export async function browserTagger() {
  const result=await build({
    stdin:{contents:'module.exports=(tokens,tags)=>require("wink-pos-tagger/src/rules-engine.js")(tokens,tags)',resolveDir:process.cwd()},
    bundle:true,write:false,globalName:'applyEnglishTagRules',
    plugins:[{name:'packed-rule-tables',setup(build) {
      build.onLoad({filter:/(pos|value)-rules-(ge0|le0)\.js$/}, ({path})=>({
        contents:'module.exports = englishRuleTables['+tables.indexOf(basename(path,'.js'))+']'
      }));
    }}]
  });
  return result.outputFiles[0].text;
}

export function taggerData(english) {
  const groups=new Map();
  function add(word,tags) {
    if (!/^[a-z]+$/.test(word)) return;
    const key=tags.join(' ');
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(word);
  }
  for (const [word,tags] of Object.entries(lexicon)) add(word,tags);
  const pos={N:'NN',V:'VB',A:'JJ',Adv:'RB',P:'IN',C:'CC'};
  for (const [word,entry] of Object.entries(english)) {
    if (/^[A-Z][a-z]+$/.test(word) && entry.N && !Object.hasOwn(lexicon,word.toLowerCase())) {
      add(word.toLowerCase(),['NNP']); continue;
    }
    if (Object.hasOwn(lexicon,word)) continue;
    if (typeof entry.value==='number') {add(word,['CD']);continue;}
    if (!(entry.ldv || Object.values(entry).some(e=>e.ldv) || (entry.A && word.length<=5))) continue;
    const tags=Object.keys(pos).filter(p=>entry[p]).map(p=>pos[p]);
    if (tags.length) add(word,tags);
  }
  const rules=tables.map(name=>require('wink-pos-tagger/src/rules/'+name+'.js'));
  return {lexicon:Array.from(groups,([tags,words])=>[tags,words.sort().join(' ')]),
    mass:Object.keys(massNouns).join(' '), rules:JSON.parse(JSON.stringify(rules,
      (key,value)=>value instanceof RegExp ? [value.source,value.flags] : value))};
}
