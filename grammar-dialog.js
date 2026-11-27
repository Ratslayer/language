'use strict';

function grammarDialog(dialog, lookupAgain, savedRussianNote) {
  const el = id => dialog.querySelector('#'+id);
  const picker = el('grammarTense'), table = el('grammarTable');
  const original=el('originalGrammar');
  let current, originalNote, translatedNote, revision = 0;
  function renderRows(card, word, dictionary, lang) {
    const verb = card.pos==='verb' || card.pos==='auxiliary' || card.pos==='auxiliary verb';
    const lemma = card.lemma.toLowerCase().replace(/^to /,'');
    const tense = picker.value;
    const rows = verb ? verbRows(lemma,principalParts(lemma,card,dictionary),tense,card.voice==='passive')
      : wordForms(card,dictionary);
    const body = table.tBodies[0];
    body.replaceChildren();
    const matching = rows.filter(([,value])=>value.toLowerCase()===word.toLowerCase());
    for (const [i,[label,value]] of rows.entries()) {
      const tr = body.insertRow();
      const th = document.createElement('th');
      th.scope='row'; th.textContent=grammarTerm(label,lang); tr.append(th);
      if (verb && tense && !label.startsWith('You (')) th.lang='en';
      const cell=tr.insertCell(); cell.lang='en'; cell.textContent=value;
      const active = verb && tense ? tense===card.tense && subjectIds[i]===card.subject :
        value.toLowerCase()===word.toLowerCase() && (matching.length===1 || card.form.includes(label.toLowerCase()));
      if (active) tr.setAttribute('aria-current','true');
    }
    table.hidden=!rows.length;
  }
  async function update(selection,lang) {
    if (!dialog.open) return;
    const version=++revision;
    const {grammar:card,button,grammarError} = selection;
    const word=button.textContent;
    dialog.lang=lang;
    const ui=text=>grammarText(text,lang);
    el('closeRules').setAttribute('aria-label',ui('Close rules'));
    el('verbFormLabel').textContent=ui('Verb form');
    table.setAttribute('aria-label',ui('Word forms'));
    el('retryRules').textContent=ui('Retry grammar lookup');
    el('grammarTitle').textContent=word;
    el('ruleLabel').textContent=card ? grammarLabel(card,lang) : '';
    const useRussian=lang==='ru' && card;
    const note=useRussian ? card.noteRu || russianGrammarNote(card,word) : card?.note;
    const noteEl=el('ruleNote');
    noteEl.textContent=note || ui(grammarError || '');
    const legacyNote=useRussian && !card.noteRu && selection.grammarSource!=='Local rules' ? card.note : '';
    if (originalNote!==legacyNote) {
      originalNote=legacyNote;
      original.open=false;
      original.querySelector('p').textContent=legacyNote;
      translatedNote=legacyNote ? savedRussianNote(legacyNote) : null;
    }
    original.hidden=!legacyNote;
    if (translatedNote) translatedNote.then(text=>{
      if (text && version===revision && dialog.open) noteEl.textContent=text;
    });
    el('retryRules').hidden=!grammarError || !window.AiPages;
    const sameCard = current===card;
    current=card;
    const verb=card && ['verb','auxiliary','auxiliary verb'].includes(card.pos);
    el('tenseControl').hidden=!verb;
    table.hidden=true;
    if (!card) return;
    if (verb && !sameCard) {
      picker.replaceChildren(new Option(ui('Principal parts'),''),
        ...englishTenses.map(t=>new Option(grammarTerm(t[0].toUpperCase()+t.slice(1),lang)+(card.voice==='passive'?' · '+grammarTerm('passive',lang):''),t)));
      picker.value=card.pos==='verb' ? card.tense || '' : '';
    }
    try {
      const dictionary=await englishDictionary();
      if (version!==revision || !dialog.open) return;
      picker.onchange=()=>renderRows(card,word,dictionary,lang);
      renderRows(card,word,dictionary,lang);
    } catch {
      noteEl.append(' '+ui('Word forms could not be loaded.'));
    }
  }
  el('closeRules').onclick=()=>dialog.close();
  el('retryRules').onclick=lookupAgain;
  dialog.addEventListener('close',()=>{revision++;current=null;originalNote=null;translatedNote=null;});
  return {open(selection,lang) {dialog.showModal();update(selection,lang);},update};
}
