'use strict';

const englishTenses = ['present simple','past simple','future simple','present continuous','past continuous',
  'future continuous','present perfect','past perfect','future perfect','present perfect continuous',
  'past perfect continuous','future perfect continuous'];
const englishSubjects = ['I','You (singular)','He / she / it','We','You (plural)','They'];
const subjectIds = ['1s','2s','3s','1p','2p','3p'];
function grammarInstructions(lang) {
  return 'For each grammar object use English labels: {lemma,pos,form,note,forms?,tense?,subject?,voice?,verbForms?}. '+
  'lemma is the English dictionary form. pos is a short part of speech (noun, proper noun, verb, auxiliary, modal, adjective, adverb, pronoun, article, determiner, preposition, conjunction, particle, numeral, etc.). '+
  'form is a short comma-separated description of the selected occurrence (e.g. plural, comparative, past participle). note is one short learner-friendly English explanation of its specific use in the sentence. '+
  'For verbs also identify the whole construction, including separated auxiliaries, using tense from '+englishTenses.join(', ')+
  ', subject from 1s/2s/3s/1p/2p/3p only when unambiguous, and voice="passive" when applicable. For a selected auxiliary or modal, describe its role in the note and omit tense. For other constructions outside the list omit tense. '+
  'For a verb outside the usual spelling patterns you may give verbForms=[third-person singular,past,past participle,-ing form]. '+
  'For nouns, adjectives, adverbs, pronouns and determiners provide forms as [label,word] pairs for applicable number, degree or case forms. For mass nouns or invariable words omit forms. '+
  'Distinguish good/adjective and well/adverb when analysing better. For prepositions and other invariable words explain the relationship here.'+
    (lang==='ru' ? ' Also include noteRu, the same explanation in natural Russian, keeping English examples intact. Keep the other fields in English.' : '');
}
function cleanGrammar(value) {
  const short = (v,n) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= n;
  if (!value || !short(value.lemma,150) || !short(value.pos,40) || !short(value.note,700)) return null;
  const card = {lemma:value.lemma.trim(), pos:value.pos.trim().toLowerCase(), note:value.note.trim(),
    form:short(value.form,110) ? value.form.trim().toLowerCase() : ''};
  if (short(value.noteRu,1000)) card.noteRu=value.noteRu.trim();
  if (englishTenses.includes(value.tense)) card.tense = value.tense;
  if (subjectIds.includes(value.subject)) card.subject = value.subject;
  if (value.voice === 'passive') card.voice = value.voice;
  if (Array.isArray(value.forms)) card.forms = value.forms.slice(0,12)
    .filter(pair => Array.isArray(pair) && short(pair[0],60) && short(pair[1],150))
    .map(([label,word]) => [label.trim(),word.trim()]);
  if (Array.isArray(value.verbForms) && value.verbForms.length === 4 && value.verbForms.every(v=>short(v,120)))
    card.verbForms = value.verbForms.map(v=>v.trim());
  return card;
}
function grammarLabel(card,lang) {
  return [card.pos, card.form, card.tense && !card.form.includes(card.tense) ? card.tense : '']
    .filter(Boolean).map(label=>grammarTerm(label,lang)).join(', ');
}
let morphologyTask,englishRuleTables;
function englishDictionary() {
  return morphologyTask ??= (async () => {
    const stream = new Blob([decodeBytes(englishMorphologyGzip)]).stream().pipeThrough(new DecompressionStream('gzip'));
    const {verbs,plurals,degrees,lexicon,mass,rules}=JSON.parse(await new Response(stream).text(),
      (key,value)=>key==='matches' ? new RegExp(...value) : value);
    const verbRules = new Map();
    for (const [rule,lemmas] of verbs) for (const lemma of lemmas) verbRules.set(lemma,rule);
    englishRuleTables=rules;
    const dictionary={verbRules,plurals:new Map(Object.entries(plurals)),degrees:new Map(Object.entries(degrees)),
      tags:new Map(),mass:new Set(mass.split(' ')),inflections:new Map()};
    for (const [names,words] of lexicon) {
      const tags=names.split(' ');
      for (const word of words.split(' ')) dictionary.tags.set(word,tags);
    }
    indexEnglishForms(dictionary);
    return dictionary;
  })();
}
function regularPlural(lemma) {
  if (/[^aeiou]y$/.test(lemma)) return lemma.slice(0,-1)+'ies';
  return lemma + (/(?:s|sh|ch|x|z)$/.test(lemma) ? 'es' : 's');
}
function regularVerb(lemma) {
  const past = /[^aeiou]y$/.test(lemma) ? lemma.slice(0,-1)+'ied' : lemma+(/e$/.test(lemma) ? 'd' : 'ed');
  return [regularPlural(lemma),past,past,lemma.replace(/ie$/,'y').replace(/([^eoy])e$/,'$1')+'ing'];
}
function principalParts(lemma, card, dictionary) {
  if (lemma === 'be') return ['is','was','been','being'];
  const rule = dictionary.verbRules.get(lemma);
  if (rule) return rule.slice(1).map(ending => lemma.slice(0,lemma.length-rule[0].length)+ending);
  return card.verbForms || regularVerb(lemma);
}
function verbRows(lemma, parts, tense, passive) {
  const [third,past,participle,progressive] = parts;
  if (!tense) return [['Base form',lemma],['Third-person singular',third],['Past simple',lemma==='be'?'was / were':past],
    ['Past participle',participle],['-ing form',progressive]];
  const [time] = tense.split(' '), perfect = tense.includes('perfect'), continuous = tense.includes('continuous');
  return englishSubjects.map((subject,i) => {
    const be = time === 'past' ? (i===0 || i===2 ? 'was' : 'were') : (i===0 ? 'am' : i===2 ? 'is' : 'are');
    let words;
    if (perfect) {
      const have = time==='future' ? 'will have' : time==='past' ? 'had' : i===2 ? 'has' : 'have';
      words = [have, continuous || passive ? 'been' : '', continuous && passive ? 'being' : '',
        passive || !continuous ? participle : progressive];
    } else if (continuous || passive) {
      words = [time==='future' ? 'will be' : be, continuous && passive ? 'being' : '', passive ? participle : progressive];
    } else {
      words = [time==='future' ? 'will '+lemma : lemma==='be' ? be : time==='past' ? past : i===2 ? third : lemma];
    }
    return [subject, words.filter(Boolean).join(' ')];
  });
}
function wordForms(card, dictionary) {
  const lemma = card.lemma.toLowerCase();
  if (card.pos==='noun' && /\b(singular|plural)\b/.test(card.form) && !/(uncountable|mass|plural.only|singular.only)/.test(card.form)) {
    const plural = dictionary.plurals.get(lemma);
    if (plural) return [['Singular',card.lemma],['Plural',plural]];
    if (!card.forms?.length) return [['Singular',card.lemma],['Plural',regularPlural(lemma)]];
  }
  if (card.pos==='adjective' || card.pos==='adverb') {
    const degree = dictionary.degrees.get((card.pos==='adjective' ? 'A:' : 'Adv:')+lemma);
    if (degree) return [['Base',card.lemma],['Comparative',degree[0]],['Superlative',degree[1]]];
  }
  return card.forms || [];
}
// Older editions have only a dictionary form. Offer an offline analysis when that entry
// identifies an irregular plural or a degree unambiguously; other uses need sentence annotation.
function dictionaryGrammar(word, lemma, dictionary) {
  const base = lemma?.toLowerCase(), selected = word.toLowerCase();
  if (!base || base===selected) return null;
  if (dictionary.plurals.get(base) === selected)
    return {lemma,pos:'noun',form:'plural',note:selected+' is the irregular plural of '+lemma+'.'};
  for (const [pos,prefix] of [['adjective','A:'],['adverb','Adv:']]) {
    const pair = dictionary.degrees.get(prefix+base);
    if (!pair?.includes(selected)) continue;
    if (dictionary.degrees.has((prefix==='A:'?'Adv:':'A:')+base)) return null;
    const form = pair[0]===selected ? 'comparative' : 'superlative';
    return {lemma,pos,form,note:selected+' is the '+form+' form of '+lemma+'.'};
  }
  return null;
}

// The build uses the same defaults to retain only lexical exceptions.
if (typeof module==='object' && module.exports) module.exports={regularVerb,regularPlural};
