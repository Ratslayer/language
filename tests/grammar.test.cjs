const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const source = name => readFileSync(require.resolve('../'+name),'utf8');

async function grammar() {
  const {englishMorphology}=await import('../scripts/english-morphology.mjs');
  const context={Blob,Response,DecompressionStream,Uint8Array,atob,englishMorphologyGzip:englishMorphology(),
    applyEnglishTagRules:require('wink-pos-tagger/src/rules-engine.js')};
  return vm.runInNewContext(source('page-files.js')+'\n'+source('english-grammar.js')+'\n'+source('english-analysis.js')+
    '\n({englishDictionary,principalParts,verbRows,wordForms,dictionaryGrammar,localEnglishGrammar,cleanGrammar})',context);
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

test('offline English analysis identifies occurrences without a saved lemma', async()=>{
  const g=await grammar(),d=await g.englishDictionary();
  const check=(sentence,word,pos,lemma,form,tense,index=sentence.indexOf(word))=>{
    const card=g.localEnglishGrammar(sentence,index,word,undefined,d);
    assert.ok(card,sentence+' / '+word);
    assert.equal(card.pos,pos,word); assert.equal(card.lemma,lemma,word);
    if (form!==undefined) assert.equal(card.form,form,word);
    if (tense!==undefined) assert.equal(card.tense,tense,word);
  };
  const sentence='The quiet children walked slowly through the garden.';
  check(sentence,'The','article','the','definite');
  check(sentence,'quiet','adjective','quiet','base form');
  check(sentence,'children','noun','child','plural');
  check(sentence,'walked','verb','walk','past simple','past simple');
  check(sentence,'slowly','adverb','slowly');
  check(sentence,'through','preposition','through');
  check(sentence,'garden','noun','garden','singular');
  check('She saw a saw.','saw','verb','see','past simple','past simple');
  check('She saw a saw.','saw','noun','saw','singular',undefined,10);
  check('She had already eaten.','eaten','verb','eat','past participle','past perfect');
  check('They are eating.','eating','verb','eat','-ing form','present continuous');
  check('They’re eating.','eating','verb','eat','-ing form','present continuous');
  check('Have you eaten?','eaten','verb','eat','past participle','present perfect');
  check('My feet hurt.','hurt','verb','hurt','base or past form','');
  check('She sings better.','better','adverb','well','comparative');
  check('It was a better book.','better','adjective','good','comparative');
  check('I eat.','I','pronoun','I'); check('An avid reader.','avid','adjective','avid');
  assert.equal(g.localEnglishGrammar('She had flarned.',8,'flarned','flarn',d).tense,'past perfect');
  assert.equal(g.localEnglishGrammar('A flarnix.',2,'flarnix','',d),null);
  assert.equal(g.localEnglishGrammar('That saw.',0,'saw','',d),null);
});
