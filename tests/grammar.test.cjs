const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const source = name => readFileSync(require.resolve('../'+name),'utf8');

async function grammar() {
  const {englishMorphology}=await import('../scripts/english-morphology.mjs');
  const context={Blob,Response,DecompressionStream,Uint8Array,atob, englishMorphologyGzip:englishMorphology()};
  return vm.runInNewContext(source('page-files.js')+'\n'+source('english-grammar.js')+
    '\n({englishDictionary,principalParts,verbRows,wordForms,dictionaryGrammar,cleanGrammar})',context);
}

test('English paradigms use lexical exceptions, agreement, auxiliaries and both voices', async()=>{
  const g=await grammar(), d=await g.englishDictionary();
  const parts=(lemma)=>g.principalParts(lemma,{},d);
  assert.equal(parts('eat').join('/'),'eats/ate/eaten/eating');
  assert.equal(parts('stop').join('/'),'stops/stopped/stopped/stopping');
  assert.equal(g.verbRows('eat',parts('eat'),'present simple',false).map(row=>row[1]).join('/'),'eat/eat/eats/eat/eat/eat');
  assert.equal(g.verbRows('eat',parts('eat'),'past perfect',false)[2][1],'had eaten');
  assert.equal(g.verbRows('eat',parts('eat'),'present perfect',true)[2][1],'has been eaten');
  assert.equal(g.verbRows('be',parts('be'),'past simple',false)[5][1],'were');
  assert.equal(g.verbRows('eat',parts('eat'),'present continuous',false)[0][1],'am eating');
  assert.equal(g.dictionaryGrammar('feet','foot',d).form,'plural');
  assert.equal(g.wordForms({lemma:'foot',pos:'noun',form:'plural'},d)[1][1],'feet');
  for (const [pos,lemma] of [['adjective','good'],['adverb','well']])
    assert.equal(g.wordForms({lemma,pos,form:'comparative'},d)[1][1],'better');
  assert.equal(g.cleanGrammar({lemma:'under',pos:'preposition',note:'Introduces the location.'}).pos,'preposition');
  assert.equal(g.cleanGrammar({pos:'noun'}),null);
});
