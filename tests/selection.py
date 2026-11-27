"""Exercise the built reader with a simulated Android bridge in mobile Chromium."""
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


BRIDGE = """
window.calls = [];
window.replies = [];
window.AiPages = {postMessage(message) {
  const q = JSON.parse(message);
  calls.push(q);
  const send = value => queueMicrotask(() => AiPages.onmessage({data:JSON.stringify({id:q.id,value})}));
  if (q.method === 'ai.run') { replies.push(send); return; }
  if (q.method === 'text.incoming') return send(window.fixture);
  if (q.method === 'book.page') return send(window.testPages?.[q.page] ?? window.testRows);
  if (q.method === 'speech.speak') return send('spoken');
  if (q.method === 'storage.read') return send(localStorage.getItem('testState') ||
    JSON.stringify({source:window.testSource || 'es', target:window.testTarget || 'en', grammarFallback:window.testFallback}));
  if (q.method === 'storage.write') { localStorage.setItem('testState', q.value); return send(null); }
  send(null);
}};
"""

PACK = """
window.fixture = {format:'reader.book.1',book:'test',lang:'es',title:'Test',pages:1};
window.testRows = ['Dijo «sí, sí».', 'Llegó. Volvió.'].map((text,id) => {
  const words = Array.from(new Intl.Segmenter('es',{granularity:'word'}).segment(text))
    .filter(p=>p.isWordLike).map(p=>[p.index,p.segment.length]);
  return {id,para:0,text,words,entry:{translation:id ? 'He arrived. He returned.' : 'He said “yes, yes”.',
    groups:words.map((_,i)=>[[i], 'lemma', 'meaning '+i])}};
});
"""


def open_reader(browser, fixture):
    page = browser.new_page(viewport={"width": 320, "height": 640}, has_touch=True, is_mobile=True)
    dist = Path(__file__).resolve().parents[1] / "dist"
    page.route("http://localhost/**", lambda route: route.fulfill(
        path=dist / (urlparse(route.request.url).path.lstrip("/") or "index.html")))
    page.add_init_script(fixture + BRIDGE)
    page.goto("http://localhost/")
    expect(page.locator("#reader")).to_be_visible()
    return page


def spoken(page):
    page.locator("#pronounce").tap()
    return page.evaluate("calls.filter(q => q.method === 'speech.speak').at(-1).text")


def verify_pack(browser):
    page = open_reader(browser, PACK)
    target = page.locator("#passage .passageWord").nth(2)
    toggle = page.locator("#sentence")
    answer = page.locator("#answer")
    target.tap()
    expect(answer).to_have_text("meaning 2\nlemma")
    assert spoken(page) == "sí"
    expect(page.locator("#rules")).to_be_hidden()
    toggle.tap()
    expect(toggle).to_have_text("Word")
    expect(toggle).to_be_focused()
    expect(page.locator(".activeSentence")).to_have_text("Dijo «sí, sí».")
    expect(answer).to_have_text("He said “yes, yes”.")
    assert spoken(page) == "Dijo «sí, sí»."
    toggle.tap()
    expect(target).to_have_class("passageWord active")
    expect(answer).to_have_text("meaning 2\nlemma")
    expect(toggle).to_be_focused()
    expect(page.locator(".activeSentence")).to_have_count(0)
    assert spoken(page) == "sí"
    assert page.evaluate("replies.length") == 0
    assert page.locator("#popup").evaluate("p => p.scrollWidth <= p.clientWidth")

    page.get_by_role("button", name="Volvió", exact=True).tap()
    toggle.tap()
    expect(page.locator(".activeSentence")).to_have_text("Volvió.")
    assert spoken(page) == "Volvió."
    page.evaluate("replies.shift()('He returned.')")
    expect(answer).to_have_text("He returned.")
    page.locator("#close").tap()
    expect(page.locator("#popup")).to_be_hidden()
    expect(page.locator(".activeSentence")).to_have_count(0)
    page.close()


def verify_bookmarks(browser):
    page = open_reader(browser, PACK + "window.fixture.pages=2;window.fixture.chapters=[{chapter:'First',id:0,page:0}];"
        "window.testPages=[window.testRows,[{...window.testRows[0],id:4}]];")
    target = page.locator("#passage .passageWord").nth(2)
    target.tap()
    mark = page.locator("#markSelection")
    mark.tap()
    expect(mark).to_have_attribute("aria-pressed", "true")
    pink = "rgb(255, 201, 223)"
    target.tap()
    expect(target).to_have_css("background-color", pink)
    expect(page.locator("#passage .passageWord").nth(1)).not_to_have_css("background-color", pink)
    target.tap()
    page.locator("#sentence").tap()
    expect(mark).to_have_attribute("aria-pressed", "false")
    mark.tap()
    expect(mark).to_have_attribute("aria-pressed", "true")
    page.reload()
    expect(target).to_have_css("background-color", pink)
    expect(target.locator("..")).to_have_css("background-color", pink)
    page.locator("#next").tap()
    expect(page.locator("#count")).to_have_text("2 / 2")
    expect(target).not_to_have_css("background-color", pink)
    for index in (0, 1):
        page.keyboard.press("Alt+ArrowDown")
        expect(page.locator("#chapterSection")).not_to_have_attribute("open", "")
        expect(page.locator("#bookmarkSection")).not_to_have_attribute("open", "")
        expect(page.locator("#chapterSection summary")).to_be_visible()
        page.locator("#chapterSection summary").tap()
        expect(page.locator("#chapterList button")).to_have_text("First · p. 1")
        page.locator("#bookmarkSection summary").tap()
        expect(page.locator(".bookmarkRow")).to_have_count(2)
        expect(page.locator(".bookmarkRow strong")).to_have_text("sí")
        page.locator(".bookmarkRow").nth(index).locator("button").first.tap()
        if index:
            expect(page.locator(".activeSentence")).to_have_text("Dijo «sí, sí».")
        else:
            expect(target).to_have_class("passageWord active")
        expect(mark).to_have_attribute("aria-pressed", "true")
    mark.tap()
    expect(mark).to_have_attribute("aria-pressed", "false")
    expect(target.locator("..")).not_to_have_css("background-color", pink)
    expect(target).to_have_css("background-color", pink)
    page.keyboard.press("Alt+ArrowDown")
    page.locator("#bookmarkSection summary").tap()
    page.get_by_role("button", name="Remove bookmark for sí").tap()
    expect(page.locator("#bookmarkList")).to_have_text("No bookmarks yet.")
    page.locator("#navigationClose").tap()
    expect(target).not_to_have_css("background-color", pink)
    page.close()


def verify_pending(browser):
    page = open_reader(browser, "window.fixture={name:'test.txt',text:'¿Qué dijo? Otra frase.'};")
    word = page.get_by_role("button", name="dijo", exact=True)
    toggle = page.locator("#sentence")
    answer = page.locator("#meaning")
    word.tap()
    page.wait_for_function("replies.length === 1")
    toggle.tap()
    assert spoken(page) == "¿Qué dijo?"
    page.evaluate("replies.shift()('stale word translation')")
    page.wait_for_function("replies.length === 1")
    expect(answer).to_have_text("Translating…")
    toggle.tap()
    assert spoken(page) == "dijo"
    page.evaluate("replies.shift()('stale sentence translation')")
    page.wait_for_function("replies.length === 1")
    expect(answer).to_have_text("Translating…")
    page.evaluate("replies.shift()('said')")
    expect(answer).to_have_text("said")
    word.tap()
    expect(page.locator("#popup")).to_be_hidden()
    page.close()


def verify_english_rules(browser):
    fixture = """
    window.fixture={format:'reader.book.1',book:'grammar-test',lang:'en',title:'Grammar',pages:1};
    const examples=[
      ['Her feet hurt.', 'Feet', 'foot', null],
      ['She had already eaten.', 'eaten', 'eat', {lemma:'eat',pos:'verb',form:'past participle',
        tense:'past perfect',subject:'3s',note:'Had eaten places this meal before another past event.'}],
      ['They went through the door.', 'through', 'through', {lemma:'through',pos:'preposition',form:'',
        note:'Through marks the route they took.'}],
      ['She sings better.', 'better', 'well', {lemma:'well',pos:'adverb',form:'comparative',
        note:'Better describes how she sings.'}],
      ['An avid reader.', 'avid', 'avid', null],
      ['She said “flarnix”.', 'flarnix', 'flarnix', null],
      ['She said “zandor”.', 'zandor', 'zandor', {lemma:'zandor',pos:'noun',form:'singular',note:'A fictional name.'}]
    ];
    window.testRows=examples.map(([text,word,lemma,grammar],id)=>{
      const tokens=Array.from(new Intl.Segmenter('en',{granularity:'word'}).segment(text)).filter(t=>t.isWordLike);
      return {id:id+1,para:id,text,words:tokens.map(t=>[t.index,t.segment.length]),
        entry:{translation:'Whole sentence',groups:tokens.map((t,i)=>[[i],t.segment.toLowerCase()===word.toLowerCase()?lemma:t.segment,'gloss']),
          grammar:tokens.map(t=>t.segment.toLowerCase()===word.toLowerCase()?grammar:null)}};
    });
    """
    page = open_reader(browser, fixture)
    rules = page.locator("#rules")
    dialog = page.locator("#grammarDialog")
    table = dialog.locator("table")
    label = page.locator("#grammarLabel")
    page.get_by_role("button", name="feet", exact=True).tap()
    expect(page.locator("#word")).to_have_text("foot")
    expect(label).to_contain_text("noun, plural")
    expect(page.locator("#grammarSource")).to_have_text("")
    assert page.locator(".translationHeading").locator("button").all_text_contents() == ["🔊", "", "Sentence", "Rules", "×"]
    assert page.locator(".translationHeading strong").count() == 0
    assert page.locator("#word").evaluate("e=>getComputedStyle(e).fontWeight") in ("700", "bold")
    assert label.evaluate("e=>getComputedStyle(e).fontStyle") == "italic"
    assert page.locator("#popup").evaluate("p=>p.scrollWidth <= p.clientWidth")
    rules.tap()
    expect(table.locator("tr")).to_have_count(2)
    expect(table.locator("[aria-current=true] td")).to_have_text("feet")
    page.evaluate("dispatchEvent(new Event('tool-back'))")
    expect(dialog).to_be_hidden()
    expect(rules).to_be_focused()
    expect(page.locator("#popup")).to_be_visible()
    page.get_by_role("button", name="eaten", exact=True).tap()
    expect(label).to_contain_text("past participle, past perfect")
    expect(page.locator("#grammarSource")).to_have_text("")
    rules.tap()
    expect(table.locator("[aria-current=true] td")).to_have_text("had eaten")
    dialog.locator("select").select_option("present simple")
    expect(table.locator("td")).to_have_text(["eat", "eat", "eats", "eat", "eat", "eat"])
    page.keyboard.press("Escape")
    expect(dialog).to_be_hidden()
    page.locator("#sentence").tap()
    expect(rules).to_be_hidden()
    expect(page.locator("#wordDetails")).to_be_hidden()
    page.locator("#sentence").tap()
    expect(rules).to_be_visible()
    for word, note in [("through", "preposition"), ("better", "adverb")]:
        page.get_by_role("button", name=word, exact=True).tap()
        rules.tap()
        expect(dialog.locator("#ruleNote")).to_contain_text(note)
        if word == "through":
            expect(table).to_be_hidden()
        else:
            expect(table.locator("[aria-current=true] td")).to_have_text("better")
        dialog.locator("#closeRules").tap()
    assert page.evaluate("replies.length") == 0
    page.get_by_role("button", name="avid", exact=True).tap()
    expect(label).to_have_text("adjective, base form")
    expect(page.locator("#grammarSource")).to_have_text("")
    page.get_by_role("button", name="zandor", exact=True).tap()
    expect(page.locator("#grammarSource")).to_have_text("From book")
    page.get_by_role("button", name="flarnix", exact=True).tap()
    expect(page.locator("#meaning")).to_have_text("gloss")
    expect(page.locator("#word")).to_have_text("flarnix")
    expect(label).to_be_empty()
    expect(page.locator("#grammarSource")).to_be_empty()
    expect(rules).to_be_hidden()
    assert page.evaluate("calls.filter(q=>q.method==='ai.run').length") == 0
    settings = page.get_by_role("button", name="Settings", exact=True)
    settings.tap()
    checkbox = page.get_by_role("checkbox", name="Fallback to LLM when grammar is missing")
    expect(checkbox).to_be_hidden()
    page.get_by_text("Experiments", exact=True).tap()
    expect(checkbox).not_to_be_checked()
    checkbox.check()
    expect(page.locator("#settingsDialog")).to_be_visible()
    assert page.locator("#settingsDialog").evaluate("d=>d.scrollHeight <= d.clientHeight+1")
    page.evaluate("dispatchEvent(new Event('tool-back'))")
    expect(page.locator("#settingsDialog")).to_be_hidden()
    expect(settings).to_be_focused()
    page.wait_for_function("!history.state?.languageSettings")
    page.reload()
    settings.tap()
    page.get_by_text("Experiments", exact=True).tap()
    expect(checkbox).to_be_checked()
    page.keyboard.press("Escape")
    page.get_by_role("button", name="flarnix", exact=True).tap()
    page.wait_for_function("replies.length === 1")
    expect(rules).to_be_hidden()
    expect(label).to_be_empty()
    page.evaluate("""replies.shift()(JSON.stringify({lemma:'flarnix',pos:'adjective',form:'base form',
      note:'A fictional adjective.'}))""")
    rules.tap()
    expect(dialog.locator("#ruleNote")).to_contain_text("fictional adjective")
    expect(page.locator("#grammarSource")).to_have_text("Luna")
    dialog.locator("#closeRules").tap()
    settings.tap()
    checkbox.uncheck()
    page.locator("#closeSettings").tap()
    page.wait_for_function("!history.state?.languageSettings")
    page.reload()
    page.get_by_role("button", name="flarnix", exact=True).tap()
    expect(label).to_have_text("adjective, base form")
    expect(page.locator("#grammarSource")).to_have_text("Saved grammar")
    settings.tap()
    page.get_by_text("Experiments", exact=True).tap()
    expect(checkbox).not_to_be_checked()
    page.go_back()
    expect(page.locator("#settingsDialog")).to_be_hidden()
    expect(page.locator("#reader")).to_be_visible()
    assert page.evaluate("replies.length") == 0
    page.close()


def verify_live_english(browser):
    page = open_reader(browser, """window.testSource='en';window.testTarget='ru';window.testFallback=true;
      window.fixture={name:'live.txt',text:'She saw a saw.'};""")
    answers = [
        {"translation": "увидела", "grammar": {"lemma": "see", "pos": "verb", "form": "past simple",
         "tense": "past simple", "subject": "3s", "note": "Saw tells what she perceived."}},
        {"translation": "пилу", "grammar": {"lemma": "saw", "pos": "noun", "form": "singular",
         "note": "A saw is the tool she saw.", "forms": [["Singular", "saw"], ["Plural", "saws"]]}}
    ]
    import json
    saw = page.get_by_role("button", name="saw", exact=True)
    for i, answer in enumerate(answers):
        saw.nth(i).tap()
        page.wait_for_function("replies.length === 1")
        assert "{translation,lemma}" in page.evaluate("calls.filter(q=>q.method==='ai.run').at(-1).prompt")
        expect(page.locator("#grammarSource")).to_have_text("")
        page.locator("#rules").tap()
        page.evaluate("raw=>replies.shift()(raw)", json.dumps(answer))
        expect(page.locator("#ruleLabel")).to_contain_text(["глагол", "существительное"][i])
        expect(page.locator("#grammarTable tr[aria-current=true] td")).to_have_text("saw")
        page.locator("#closeRules").tap()
        expect(page.locator("#meaning")).to_have_text(answer["translation"])
        expect(page.locator("#word")).to_have_text(answer["grammar"]["lemma"])
    saw.nth(0).tap()
    expect(page.locator("#grammarLabel")).to_have_text("глагол, прошедшее простое")
    assert page.evaluate("replies.length") == 0
    page.close()


def verify_translation_only(browser):
    page = open_reader(browser, """window.testSource='en';window.testTarget='ru';
      window.fixture={name:'test.txt',text:'My feet hurt.'};""")
    for word, lemma, gloss in [("feet", "foot", "ступни"), ("hurt", "hurt", "болят")]:
        page.get_by_role("button", name=word, exact=True).tap()
        page.wait_for_function("replies.length === 1")
        prompt = page.evaluate("calls.filter(q=>q.method==='ai.run').at(-1).prompt")
        assert "{translation,lemma}" in prompt and "grammar" not in prompt
        page.evaluate("""([lemma,translation])=>replies.shift()(JSON.stringify({translation,lemma,
          grammar:{lemma:'unexpected',pos:'noun',form:'singular',note:'Unrequested AI grammar.'}}))""", [lemma, gloss])
        expect(page.locator("#meaning")).to_have_text(gloss)
        expect(page.locator("#word")).to_have_text(lemma)
        expect(page.locator("#grammarLabel")).not_to_be_empty()
        expect(page.locator("#grammarSource")).to_be_empty()
    assert page.evaluate("calls.filter(q=>q.method==='ai.run').length") == 2
    page.close()


def verify_grammar_without_translation(browser):
    page = open_reader(browser, """window.testSource='en';window.testTarget='ru';
      window.fixture={name:'local.txt',text:'The quiet children walked slowly through the garden.'};""")
    page.get_by_role("button", name="children", exact=True).tap()
    expect(page.locator("#grammarLabel")).to_have_text("существительное, множественное число")
    expect(page.locator("#meaning")).to_have_text("Translating…")
    page.locator("#rules").tap()
    expect(page.locator("#rules")).to_have_text("Правила")
    expect(page.locator("#ruleNote")).to_have_text("«children» — форма множественного числа существительного «child».")
    expect(page.locator("#grammarTable th")).to_have_text(["единственное число", "множественное число"])
    expect(page.locator("#grammarTable td")).to_have_text(["child", "children"])
    expect(page.locator("#originalGrammar")).to_be_hidden()
    page.evaluate("""()=>{const q=calls.find(q=>q.method==='ai.run');
      AiPages.onmessage({data:JSON.stringify({id:q.id,error:'HTTP 403'})});}""")
    expect(page.locator("#meaning")).to_have_text("HTTP 403")
    expect(page.locator("#grammarSource")).to_have_text("")
    expect(page.locator("#retryRules")).to_be_hidden()
    assert page.evaluate("calls.filter(q=>q.method==='ai.run').length") == 1
    page.close()


def verify_legacy_russian_note(browser):
    page = open_reader(browser, """
      window.testTarget='ru';
      window.fixture={format:'reader.book.1',book:'legacy',lang:'en',title:'Grammar',pages:1};
      window.testRows=[{id:1,para:0,text:'Zandor.',words:[[0,6]],entry:{translation:'Зандор.',
        groups:[[[0],'zandor','зандор']],grammar:[{lemma:'zandor',pos:'noun',form:'singular',note:'A fictional name.'}]}}];""")
    word = page.get_by_role("button", name="Zandor", exact=True)
    dialog = page.locator("#grammarDialog")
    note = dialog.locator("#ruleNote")
    word.tap()
    expect(page.locator("#grammarSource")).to_have_text("Из книги")
    page.locator("#rules").tap()
    expect(note).to_contain_text("существительное в единственном числе")
    dialog.locator("summary").tap()
    expect(dialog.locator("#originalGrammar p")).to_have_text("A fictional name.")
    assert page.evaluate("replies.length") == 0
    dialog.locator("#closeRules").tap()
    page.locator("#openSettings").tap()
    page.get_by_text("Experiments", exact=True).tap()
    page.get_by_role("checkbox", name="Обращаться к ИИ", exact=False).check()
    page.locator("#closeSettings").tap()
    word.tap()
    page.locator("#rules").tap()
    page.wait_for_function("replies.length === 1")
    assert "A fictional name." in page.evaluate("calls.filter(q=>q.method==='ai.run').at(-1).prompt")
    page.evaluate("replies.shift()('Вымышленное имя.')")
    expect(note).to_have_text("Вымышленное имя.")
    page.wait_for_function("localStorage.getItem('testState')?.includes('Вымышленное имя.')")
    page.reload()
    word.tap()
    page.locator("#rules").tap()
    expect(note).to_have_text("Вымышленное имя.")
    assert page.evaluate("replies.length") == 0
    dialog.locator("#closeRules").tap()
    page.evaluate("const t=document.getElementById('target'); t.value='fr'; t.dispatchEvent(new Event('change'))")
    word.tap()
    page.locator("#rules").tap()
    expect(note).to_have_text("A fictional name.")
    expect(dialog.locator("#ruleLabel")).to_have_text("noun, singular")
    expect(dialog.locator("#originalGrammar")).to_be_hidden()
    page.close()


def verify_shelf_settings(browser):
    page = open_reader(browser, PACK)
    page.evaluate("dispatchEvent(new Event('tool-back'))")
    expect(page.locator("#shelf")).to_be_visible()
    settings = page.get_by_role("button", name="Settings", exact=True)
    settings.tap()
    page.get_by_text("Experiments", exact=True).tap()
    expect(page.get_by_role("checkbox")).to_be_visible()
    page.get_by_text("Experiments", exact=True).tap()
    expect(page.get_by_role("checkbox")).to_be_hidden()
    page.locator("#closeSettings").tap()
    expect(settings).to_be_focused()
    expect(page.locator("#shelf")).to_be_visible()
    page.close()


def verify_page_preparation(browser):
    for enabled in (False, True):
        fixture = """
        window.testTarget='ru';
        window.fixture={format:'reader.book.1',book:'prep',lang:'en',title:'Grammar',pages:1};
        window.testRows=[{id:1,para:0,text:'Feet.',words:[[0,4]]}];
        """
        page = open_reader(browser, fixture + ("window.testFallback=true;" if enabled else ""))
        page.evaluate("document.getElementById('prepare').click()")
        page.wait_for_function("replies.length === 1")
        prompt = page.evaluate("calls.filter(q=>q.method==='ai.run').at(-1).prompt")
        assert ("grammar as a separate top-level array" in prompt) == enabled
        page.evaluate("""replies.shift()(JSON.stringify({translation:'Ступни.',groups:[[[0],'foot','ступни']]}))""")
        if enabled:
            assert "noteRu" in prompt
            page.wait_for_function("replies.length === 1")
            assert "noteRu" in page.evaluate("calls.filter(q=>q.method==='ai.run').at(-1).prompt")
            page.evaluate("""replies.shift()(JSON.stringify([{lemma:'foot',pos:'noun',form:'plural',note:'Plural of foot.',noteRu:'Форма множественного числа.'}]))""")
        page.wait_for_function("calls.some(q=>q.method==='book.save')")
        entry = page.evaluate("calls.find(q=>q.method==='book.save').entry")
        assert ("grammar" in entry) == enabled
        if enabled:
            assert entry["grammar"][0]["noteRu"] == "Форма множественного числа."
        assert page.evaluate("calls.filter(q=>q.method==='ai.run').length") == (2 if enabled else 1)
        page.close()


def verify_dialog_height(browser):
    page = open_reader(browser, """window.testSource='en';window.testTarget='ru';window.testFallback=true;
      window.fixture={name:'test.txt',text:'She had already flarned.'};""")
    dialog = page.locator("#grammarDialog")
    page.get_by_role("button", name="flarned", exact=True).tap()
    page.wait_for_function("replies.length === 1")
    expect(page.locator("#grammarLabel")).to_be_empty()
    expect(page.locator("#rules")).to_be_hidden()

    def dimensions():
        return dialog.evaluate("""d => {
          const box=d.getBoundingClientRect();
          return {height:box.height, top:box.top, bottom:box.bottom, overflow:d.scrollHeight-d.clientHeight};
        }""")

    def fits():
        size = dimensions()
        assert size["overflow"] <= 1 and size["top"] >= -1, size
        assert size["bottom"] <= page.viewport_size["height"] + 1, size
        return size["height"]

    error = "OpenAI could not complete the request, HTTP 403"
    page.evaluate("""error => {const q=calls.filter(q=>q.method==='ai.run').at(-1);
      AiPages.onmessage({data:JSON.stringify({id:q.id,error})});}""", error)
    expect(page.locator("#grammarLabel")).to_have_text("")
    page.locator("#rules").tap()
    expect(dialog.locator("#ruleNote")).to_have_text(error)
    expect(dialog.locator("#retryRules")).to_be_in_viewport()
    error_height = fits()
    dialog.locator("#retryRules").tap()
    expect(dialog.locator("#ruleNote")).to_be_empty()
    assert fits() < error_height
    page.wait_for_function("replies.length===2")
    page.evaluate("""replies.pop()(JSON.stringify({translation:'example',grammar:{lemma:'flarn',pos:'verb',
      form:'past participle',tense:'past perfect',subject:'3s',note:'The meal happened before another past event.',noteRu:'Действие произошло до другого момента в прошлом.'}}))""")
    expect(dialog.locator("#ruleNote")).to_have_text("Действие произошло до другого момента в прошлом.")
    expect(dialog.locator("select option:checked")).to_have_text("прошедшее совершенное")
    expect(dialog.locator("tr[aria-current=true] td")).to_have_text("had flarned")
    expect(dialog.locator("tbody tr")).to_have_count(6)
    card_height = fits()
    # Just under a full screen must still fit without an internal scroll area.
    page.set_viewport_size({"width": 320, "height": int(card_height)+3})
    fits()
    for height in [220, 180]:
        page.set_viewport_size({"width": 540, "height": height})
        size=dimensions()
        assert abs(size["height"]-height) <= 1 and size["overflow"] > 1, size
        dialog.locator("tr").last.scroll_into_view_if_needed()
        expect(dialog.locator("tr").last).to_be_in_viewport()
    page.set_viewport_size({"width": 320, "height": 700})
    fits()
    page.evaluate("dispatchEvent(new Event('tool-back'))")
    expect(dialog).to_be_hidden()
    expect(page.locator("#grammarLabel")).to_contain_text("прошедшее совершенное")
    page.close()


if __name__ == "__main__":
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH"))
        try:
            verify_pack(browser)
            verify_bookmarks(browser)
            verify_pending(browser)
            verify_english_rules(browser)
            verify_live_english(browser)
            verify_translation_only(browser)
            verify_grammar_without_translation(browser)
            verify_legacy_russian_note(browser)
            verify_shelf_settings(browser)
            verify_page_preparation(browser)
            verify_dialog_height(browser)
        finally:
            browser.close()
        # Android WebView enables this Blink setting for WRAP_CONTENT, even when
        # its parent actually measures the WebView at the full screen height.
        legacy = playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH"),
                                            args=["--blink-settings=forceZeroLayoutHeight=true"])
        try:
            verify_dialog_height(legacy)
            verify_english_rules(legacy)
        finally:
            legacy.close()
