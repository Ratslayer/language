'use strict';

function grammarDialog(dialog, lookupAgain) {
  const el = id => dialog.querySelector('#'+id);
  const picker = el('grammarTense'), table = el('grammarTable');
  let current, revision = 0;
  function renderRows(card, word, dictionary) {
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
      th.scope='row'; th.textContent=label; tr.append(th);
      tr.insertCell().textContent=value;
      const active = verb && tense ? tense===card.tense && subjectIds[i]===card.subject :
        value.toLowerCase()===word.toLowerCase() && (matching.length===1 || card.form.includes(label.toLowerCase()));
      if (active) tr.setAttribute('aria-current','true');
    }
    table.hidden=!rows.length;
  }
  async function update(selection) {
    if (!dialog.open) return;
    const version=++revision;
    const {grammar:card,button,grammarError,grammarMiss} = selection;
    const word=button.textContent;
    el('grammarTitle').textContent=word;
    el('ruleLabel').textContent=card ? grammarLabel(card) : '';
    el('ruleNote').textContent=card?.note || grammarMiss || grammarError || 'Checking grammar…';
    el('retryRules').hidden=!grammarError || !!grammarMiss || !window.AiPages;
    const sameCard = current===card;
    current=card;
    const verb=card && ['verb','auxiliary','auxiliary verb'].includes(card.pos);
    el('tenseControl').hidden=!verb;
    table.hidden=true;
    if (!card) return;
    if (verb && !sameCard) {
      picker.replaceChildren(new Option('Principal parts',''),
        ...englishTenses.map(t=>new Option(t[0].toUpperCase()+t.slice(1)+(card.voice==='passive'?' · passive':''),t)));
      picker.value=card.pos==='verb' ? card.tense || '' : '';
    }
    try {
      const dictionary=await englishDictionary();
      if (version!==revision || !dialog.open) return;
      picker.onchange=()=>renderRows(card,word,dictionary);
      renderRows(card,word,dictionary);
    } catch {
      el('ruleNote').textContent=card.note+' Word forms could not be loaded.';
    }
  }
  el('closeRules').onclick=()=>dialog.close();
  el('retryRules').onclick=lookupAgain;
  dialog.addEventListener('close',()=>{revision++;current=null;});
  return {open(selection) {dialog.showModal();update(selection);},update};
}
