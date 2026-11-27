// Adapted from the jsRealB English lexicon and tables, RALI, Université de Montréal.
// https://github.com/rali-udem/jsRealB/tree/master/data (CC BY 4.0).
import jsRealB from 'jsrealb';
import defaults from '../english-grammar.js';
import {gzipSync} from 'node:zlib';
import {taggerData} from './english-tagger.mjs';

export function englishMorphology() {
  jsRealB.loadEn();
  const rules = jsRealB.getRules();
  const verbs = new Map(), plurals = {}, degrees = {};
  for (const [lemma, word] of Object.entries(jsRealB.getLexicon())) {
    const verb = rules.conjugation[word.V?.tab];
    if (verb && [verb.t.ps,verb.t.p?.[2],verb.t.pp,verb.t.pr].every(v=>typeof v==='string')) {
      const endings = [verb.t.p[2], verb.t.ps, verb.t.pp, verb.t.pr];
      const stem = lemma.slice(0, lemma.length - verb.ending.length);
      const regular = defaults.regularVerb(lemma);
      // Keep "dyeing" distinct from "dying" (jsRealB assigns dye the generic silent-e pattern).
      if (lemma !== 'dye' && endings.some((ending,i) => stem + ending !== regular[i])) {
        const key = JSON.stringify([verb.ending,...endings]);
        if (!verbs.has(key)) verbs.set(key, []);
        verbs.get(key).push(lemma);
      }
    }
    const noun = rules.declension[word.N?.tab];
    const plural = noun?.declension.find(f => f.n === 'p');
    if (plural) {
      const form = lemma.slice(0, lemma.length - noun.ending.length) + plural.val;
      if (form !== defaults.regularPlural(lemma)) plurals[lemma.toLowerCase()] = form;
    }
    for (const pos of ['A','Adv']) {
      const table = rules.declension[word[pos]?.tab];
      const forms = ['co','su'].map(degree => table?.declension.find(f => f.f === degree)?.val);
      if (forms.every(f => typeof f === 'string')) {
        const stem = lemma.slice(0,lemma.length - table.ending.length);
        degrees[pos + ':' + lemma] = forms.map(f => stem + f);
      }
    }
  }
  const groups = Array.from(verbs, ([key, words]) => [JSON.parse(key), words]);
  return gzipSync(JSON.stringify({verbs:groups,plurals,degrees,...taggerData(jsRealB.getLexicon())}), {level:9}).toString('base64');
}
