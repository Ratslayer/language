'use strict';

// Map surface forms back to candidate lemmas without losing homographs such as "saw".
function indexEnglishForms(d) {
  function add(word,lemma,tag) {
    let forms=d.inflections.get(word);
    if (!forms) d.inflections.set(word,forms=[]);
    forms.push({lemma,tag});
  }
  const verbs=new Set(d.verbRules.keys());
  const nouns=new Set(d.plurals.keys());
  for (const [word,tags] of d.tags) {
    if (tags.includes('VB') || tags[0]==='VBP') verbs.add(word);
    if (tags.includes('NN')) nouns.add(word);
  }
  for (const lemma of verbs) {
    const forms=principalParts(lemma,{},d);
    ['VBZ','VBD','VBN','VBG'].forEach((tag,i)=>add(forms[i],lemma,tag));
  }
  for (const word of ['is','am','are','was','were','been','being'])
    add(word,'be',({is:'VBZ',am:'VBP',are:'VBP',was:'VBD',were:'VBD',been:'VBN',being:'VBG'})[word]);
  for (const lemma of nouns) add(d.plurals.get(lemma) || regularPlural(lemma),lemma,'NNS');
  for (const [key,[comparative,superlative]] of d.degrees) {
    const [pos,lemma]=key.split(':'),prefix=pos==='A' ? 'JJ' : 'RB';
    add(comparative,lemma,prefix+'R'); add(superlative,lemma,prefix+'S');
  }
}

const englishSegments=new Intl.Segmenter('en',{granularity:'word'});
let lastAnalysis;
function sentenceTokens(sentence,d) {
  if (lastAnalysis?.sentence===sentence && lastAnalysis.dictionary===d) return lastAnalysis.tokens;
  const tokens=[],choices=[];
  for (const {segment,index,isWordLike} of englishSegments.segment(sentence)) {
    if (!segment.trim()) continue;
    const normal=segment.toLowerCase().replaceAll('’',"'");
    let known=d.tags.get(normal) || d.tags.get(normal.replace(/our/g,'or'));
    if (!known && normal.endsWith('ly') && d.tags.get(normal.slice(0,-2))?.includes('JJ')) known=['RB'];
    const derived=d.inflections.get(normal)?.map(f=>f.tag);
    const tags=known || derived || [/^\d+(?:[.,]\d+)*$/.test(normal) ? 'CD' : isWordLike ? 'UNK' : normal];
    choices.push(tags);
    tokens.push({index,value:segment,normal,pos:tags[0],tags,tag:isWordLike ? 'word' : 'punctuation'});
  }
  applyEnglishTagRules(tokens,choices);
  lastAnalysis={sentence,dictionary:d,tokens};
  return tokens;
}

const subjectPronouns={i:'1s',you:'',he:'3s',she:'3s',it:'3s',we:'1p',they:'3p'};
const beForms=/^(am|is|are|was|were|be|been|being)$/;
const haveForms=/^(have|has|had|having)$/;
function contraction(word,nextTag) {
  const pronoun=/^(i|you|he|she|it|we|they)\x27(m|re|ve|ll|s|d)$/.exec(word);
  if (pronoun) {
    const fixed={m:'am',re:'are',ve:'have',ll:'will'};
    const aux=fixed[pronoun[2]] || (pronoun[2]==='s' && nextTag==='VBG' ? 'is' :
      pronoun[2]==='d' && nextTag==='VBN' ? 'had' : pronoun[2]==='d' && nextTag==='VB' ? 'would' : '');
    return {subject:subjectPronouns[pronoun[1]],aux,expanded:aux ? pronoun[1]+' '+aux : ''};
  }
  if (word.endsWith("n't")) {
    const stem=word.slice(0,-3);
    const aux=({ca:'can',wo:'will',sha:'shall'})[stem] || stem;
    if (/^(is|are|was|were|have|has|had|do|does|did|can|will|shall|could|would|should|must|might|need)$/.test(aux))
      return {aux,expanded:aux+' not'};
  }
  return null;
}
function auxiliaryChain(tokens,index) {
  const chain=[];
  let i=index-1;
  while (i>=0) {
    const t=tokens[i];
    if (t.pos.startsWith('RB') || t.normal==='not') {i--;continue;}
    const short=contraction(t.normal,tokens[index].pos);
    if (short?.aux) {
      chain.unshift(short.aux);
      if (short.subject!==undefined) return {chain,subject:short.subject};
      i--;continue;
    }
    if (!(beForms.test(t.normal) || haveForms.test(t.normal) || ['will','would','do','does','did'].includes(t.normal) || t.pos==='MD')) break;
    chain.unshift(t.normal); i--;
  }
  const subject=tokens[i]?.normal;
  // In questions the finite auxiliary comes before the subject ("Have you eaten?").
  if (Object.hasOwn(subjectPronouns,subject) && i>0) {
    const before=tokens[i-1].normal;
    if (haveForms.test(before) || beForms.test(before) || /^(do|does|did|will)$/.test(before))
      chain.unshift(before);
  }
  return {chain,subject:Object.hasOwn(subjectPronouns,subject) ? subjectPronouns[subject] : ''};
}

function localVerb(token,lemma,tag,tokens,i,d) {
  const word=token.normal;
  const {chain,subject}=auxiliaryChain(tokens,i);
  const first=chain[0],last=chain.at(-1);
  const parts=principalParts(lemma,{},d);
  let form=({VB:'base form',VBP:'base form',VBZ:'third-person singular',VBD:'past simple',VBN:'past participle',VBG:'-ing form'})[tag];
  if (tag==='VBP' && lemma==='be' && word!=='be') form=word==='am'?'first-person singular':'present form';
  let tense='',voice='';
  if (last && (beForms.test(last) || haveForms.test(last)) && word===parts[2]) form='past participle';
  const finite=first || word;
  const time=first==='will' ? 'future' : /^(was|were|had|did)$/.test(finite) || (!first && tag==='VBD') ? 'past' : 'present';
  const perfect=chain.some(w=>haveForms.test(w)) && (form==='past participle' || chain.includes('been'));
  const passive=!!last && beForms.test(last) && form==='past participle';
  const continuous=chain.some(w=>beForms.test(w)) && (form==='-ing form' || chain.includes('being'));
  if (passive) voice='passive';
  if (perfect || continuous || passive || first==='will' || ['do','does','did'].includes(first)) {
    if (!first || first==='will' || !/^(can|could|may|might|must|should|would|shall)$/.test(first))
      tense=[time,perfect?'perfect':'',continuous?'continuous':(!perfect?'simple':'')].filter(Boolean).join(' ');
  } else if (!first && ['VBP','VBZ','VBD','VB'].includes(tag) && tokens[i-1]?.normal!=='to') {
    if (tag!=='VB' || subject) tense=time+' simple';
  }
  // "They cut it" can describe the present or past. The surface form cannot distinguish them.
  if (!first && lemma===word && parts[1]===word && (form!=='past participle' || prevIsSubject(tokens[i-1])) && tag!=='VBZ') {
    form='base or past form'; tense='';
  }
  let next=i+1;
  while (tokens[next]?.pos.startsWith('RB')) next++;
  const following=tokens[next];
  const auxiliary=(beForms.test(word) && ['VBG','VBN'].includes(following?.pos)) ||
    (haveForms.test(word) && following?.pos==='VBN') || (/^(do|does|did)$/.test(word) && following?.pos==='VB');
  const pos=auxiliary?'auxiliary':'verb';
  if (auxiliary) tense='';
  const note=tense ? '“'+tokens[i].value+'” is used in the '+tense+(passive?' passive':'')+' here.' :
    '“'+tokens[i].value+'” is a '+form+' of “'+lemma+'”.';
  return {lemma,pos,form,tense,subject,voice,note};
}

function prevIsSubject(t) { return t && (t.pos==='PRP' || t.pos.startsWith('NN')); }

function localEnglishGrammar(sentence,index,word,hint,d) {
  const tokens=sentenceTokens(sentence,d);
  const i=tokens.findIndex(t=>t.index===index && t.value===word);
  if (i<0) return null;
  const t=tokens[i],prev=tokens[i-1],next=tokens[i+1],w=t.normal;
  const short=contraction(w,next?.pos);
  if (short) return {lemma:word,pos:'contraction',form:short.expanded,
    note:short.expanded ? '“'+word+'” is short for “'+short.expanded+'”.' : 'The ending of “'+word+'” represents a contracted auxiliary.'};
  const base=typeof hint==='string' ? hint.toLowerCase().trim().replace(/^to /,'') : '';
  let tag=t.pos;
  if (tag==='UNK' && base && base!==w) {
    const parts=principalParts(base,{},d);
    const {chain}=auxiliaryChain(tokens,i);
    if (parts[3]===w) tag='VBG';
    else if (parts[2]===w && chain.length) tag='VBN';
    else if (parts[1]===w && w.endsWith('ed')) tag='VBD';
    else if ((d.plurals.get(base) || regularPlural(base))===w && ['DT','PRP$','JJ','CD'].includes(prev?.pos)) tag='NNS';
  }
  // wink ranks the common verb reading of "saw" ahead of its noun reading.
  if (prev && ['DT','PRP$','IN'].includes(prev.pos) && t.tags.includes('NN') &&
      tag.startsWith('VB') && tag!=='VBG' && !(next?.pos.startsWith('NN'))) tag='NN';
  if (prev?.pos==='IN' && t.tags.includes('VBG') && w.endsWith('ing') && next?.tag==='word') tag='VBG';
  if (t.tags.includes('JJ') && /^(get|gets|got|feel|feels|felt|seem|seems|seemed)$/.test(prev?.normal)) tag='JJ';
  if (t.tags.includes('RBR') && d.inflections.get(w)?.some(f=>f.tag==='RBR') &&
      prev?.pos.startsWith('VB') && !beForms.test(prev.normal)) tag='RBR';
  if (beForms.test(prev?.normal) && t.tags.includes('VBG')) tag='VBG';
  if (prevIsSubject(prev) && tag==='NNS' && t.tags[0]==='VBZ') tag='VBZ';
  if (prevIsSubject(prev) && tag==='VBN' && t.tags.includes('VBD') &&
      !auxiliaryChain(tokens,i).chain.length) tag='VBD';
  const prefix=tag.slice(0,2);
  const forms=(d.inflections.get(w) || []).filter(f=>f.tag===tag);
  const matches=forms.filter(f=>f.lemma!==w);
  let lemma=matches.find(f=>f.lemma===base)?.lemma || matches[0]?.lemma || w;
  if (beForms.test(w) && prefix==='VB') lemma='be';
  if (prefix==='VB') {
    if (base && base!==w && principalParts(base,{},d).includes(w) && !beForms.test(w)) lemma=base;
    return localVerb(t,lemma,tag,tokens,i,d);
  }
  let pos,form='';
  if (tag==='NN' || tag==='NNS') {
    pos='noun'; form=tag==='NNS' ? 'plural' : d.mass.has(w) && !/^(a|an|one)$/.test(prev?.normal) ? 'uncountable' : 'singular';
    if (tag==='NNS' && base && (d.plurals.get(base) || regularPlural(base))===w) lemma=base;
    if (tag==='NNS' && lemma===w && d.plurals.get(w)!==w)
      return {lemma,pos,form,forms:[['Plural',word]],note:'“'+word+'” is a plural noun here.'};
  } else if (tag==='NNP' || tag==='NNPS') {
    pos='proper noun'; form=tag==='NNPS'?'plural':''; lemma=t.value;
  } else if (prefix==='JJ' || prefix==='RB') {
    pos=prefix==='JJ'?'adjective':'adverb';
    form=tag.endsWith('R')?'comparative':tag.endsWith('S')?'superlative':prefix==='JJ'?'base form':'';
  } else if (tag==='IN' || tag==='TO') {
    if (w==='to' && (next?.pos==='VB' || next?.pos==='VBP')) pos='infinitive marker';
    else if (/^(although|because|if|unless|whereas|whether|though|that)$/.test(w) ||
        (/^(after|as|before|since|until|while)$/.test(w) && next?.pos==='PRP')) pos='conjunction';
    else pos='preposition';
  } else if (tag==='DT' && /^(a|an|the)$/.test(w)) {
    pos='article'; form=w==='the'?'definite':'indefinite';
  } else {
    pos=({DT:'determiner',PDT:'determiner',WDT:'determiner',PRP:'pronoun',WP:'pronoun',WP$:'determiner',
      PRP$:'determiner',MD:'modal verb',CC:'conjunction',CD:'numeral',UH:'interjection',RP:'particle',
      WRB:'adverb',EX:'pronoun'})[tag];
    if (tag==='PRP$' || tag==='WP$') form='possessive';
    if (w==='i') lemma='I';
  }
  if (!pos) return dictionaryGrammar(word,base,d);
  return {lemma,pos,form,note:'“'+t.value+'” functions as '+(/^[aeiou]/.test(pos)?'an ':'a ')+pos+' in this sentence.'};
}
