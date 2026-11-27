'use strict';

// Analysis and stored annotations use English keys. Only the learner-facing text is translated.
const russianGrammarTerms = {
  noun:'существительное', 'proper noun':'имя собственное', verb:'глагол',
  auxiliary:'вспомогательный глагол', 'auxiliary verb':'вспомогательный глагол',
  modal:'модальный глагол', 'modal verb':'модальный глагол', adjective:'прилагательное',
  adverb:'наречие', pronoun:'местоимение', article:'артикль', determiner:'определитель',
  preposition:'предлог', conjunction:'союз', particle:'частица', numeral:'числительное',
  interjection:'междометие', contraction:'сокращение', 'infinitive marker':'показатель инфинитива',
  singular:'единственное число', plural:'множественное число', uncountable:'неисчисляемое',
  countable:'исчисляемое', 'mass noun':'неисчисляемое существительное', mass:'неисчисляемое',
  'plural only':'только множественное число', 'singular only':'только единственное число',
  base:'начальная форма', 'base form':'начальная форма', positive:'положительная степень',
  comparative:'сравнительная степень', superlative:'превосходная степень',
  definite:'определённый', indefinite:'неопределённый', possessive:'притяжательная форма',
  'first-person singular':'1-е лицо ед. ч.', 'second-person singular':'2-е лицо ед. ч.',
  'third-person singular':'3-е лицо ед. ч.', 'first-person plural':'1-е лицо мн. ч.',
  'second-person plural':'2-е лицо мн. ч.', 'third-person plural':'3-е лицо мн. ч.',
  'past participle':'причастие прошедшего времени', 'present participle':'причастие настоящего времени',
  '-ing form':'форма на -ing', 'present form':'форма настоящего времени',
  'base or past form':'начальная форма или форма прошедшего времени',
  'present simple':'настоящее простое', 'past simple':'прошедшее простое', 'future simple':'будущее простое',
  'present continuous':'настоящее длительное', 'past continuous':'прошедшее длительное', 'future continuous':'будущее длительное',
  'present perfect':'настоящее совершенное', 'past perfect':'прошедшее совершенное', 'future perfect':'будущее совершенное',
  'present perfect continuous':'настоящее совершенное длительное', 'past perfect continuous':'прошедшее совершенное длительное',
  'future perfect continuous':'будущее совершенное длительное',
  passive:'страдательный залог', active:'действительный залог', infinitive:'инфинитив', gerund:'герундий',
  'object form':'объектная форма', object:'объектная форма', objective:'объектная форма',
  subject:'форма подлежащего', subjective:'форма подлежащего', nominative:'именительный падеж',
  reflexive:'возвратная форма', personal:'личное', demonstrative:'указательное',
  relative:'относительное', interrogative:'вопросительное', invariable:'неизменяемая форма',
  'you (singular)':'You (ед. ч.)', 'you (plural)':'You (мн. ч.)'
};
const russianGrammarUI = {
  'Fallback to LLM when grammar is missing':'Обращаться к ИИ, если грамматический разбор отсутствует',
  Rules:'Правила', 'Local rules':'Локальные правила', 'Saved grammar':'Сохранённый разбор',
  'From book':'Из книги', 'No local grammar':'Нет локального разбора', 'Grammar unavailable':'Разбор недоступен',
  'Checking grammar…':'Проверяем грамматику…', 'Close rules':'Закрыть правила',
  'Verb form':'Форма глагола', 'Principal parts':'Основные формы', 'Word forms':'Формы слова',
  'Retry grammar lookup':'Повторить поиск', 'Word forms could not be loaded.':'Не удалось загрузить формы слова.',
  'The local rules could not identify this form. LLM fallback is off.':'Не удалось определить форму по локальным правилам. Обращение к ИИ выключено.',
  'This word has no saved grammar yet. Open the book in AI Pages to look it up.':'Для этого слова нет сохранённого разбора. Откройте книгу в AI Pages, чтобы получить разбор.',
  'The grammar lookup returned an incomplete answer.':'Получен неполный грамматический разбор.',
  'Grammar is unavailable offline for this word.':'Грамматический разбор этого слова недоступен офлайн.',
  'Open this reader in AI Pages to translate.':'Для перевода откройте книгу в AI Pages.',
  'Translation failed. Close and tap the word to retry.':'Не удалось получить перевод. Закройте окно и нажмите на слово ещё раз.',
  'Incomplete translation. Close and tap the word to retry.':'Получен неполный перевод. Закройте окно и нажмите на слово ещё раз.'
};
function grammarText(text,lang) {
  return lang==='ru' && Object.hasOwn(russianGrammarUI,text) ? russianGrammarUI[text] : text;
}
function grammarTerm(label,lang) {
  if (lang!=='ru') return label;
  return label.split(/\s*,\s*/).map(part=>{
    const key=part.toLowerCase().replace(/^(first|second|third) person /,'$1-person ');
    return Object.hasOwn(russianGrammarTerms,key) ? russianGrammarTerms[key] : part;
  }).join(', ');
}
function russianGrammarNote(card,word) {
  const selected='«'+word+'»', base='«'+card.lemma+'»';
  if (card.pos==='contraction') return card.form ? selected+' — сокращение от «'+card.form+'».' :
    'В конце '+selected+' стоит сокращённая форма вспомогательного глагола.';
  if (card.tense) {
    const name=card.tense.replace(/\b\w/g,c=>c.toUpperCase());
    const note='Здесь '+selected+' входит в форму '+name+' ('+grammarTerm(card.tense,'ru')+' время)'+
      (card.voice==='passive'?' в страдательном залоге':'')+'.';
    return card.tense==='past perfect' ? note+' Действие произошло до другого момента в прошлом.' : note;
  }
  if (card.pos==='noun') {
    if (card.form==='plural' && word.toLowerCase()!==card.lemma.toLowerCase())
      return selected+' — форма множественного числа существительного '+base+'.';
    if (card.form==='singular' || card.form==='plural')
      return 'Здесь '+selected+' — существительное '+(card.form==='plural'?'во множественном':'в единственном')+' числе.';
    if (card.form==='uncountable') return 'Здесь '+selected+' употребляется как неисчисляемое существительное.';
  }
  if (card.pos==='article') {
    if (card.form==='definite') return 'Артикль '+selected+' указывает, что читатель может понять, о ком или о чём идёт речь.';
    if (card.form==='indefinite') return 'Неопределённый артикль '+selected+' стоит перед исчисляемым существительным в единственном числе.';
  }
  if (card.form==='comparative' || card.form==='superlative')
    return selected+' — '+grammarTerm(card.form,'ru')+' слова '+base+'.';
  if (['verb','auxiliary','auxiliary verb'].includes(card.pos) && card.form)
    return 'Глагол '+base+' употреблён в форме «'+grammarTerm(card.form,'ru')+'» ('+word+').';
  return 'В этом предложении '+selected+' — '+grammarTerm(card.pos,'ru')+'.';
}
