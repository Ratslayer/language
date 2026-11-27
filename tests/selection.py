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
  if (q.method === 'book.page') return send(window.testRows);
  if (q.method === 'speech.speak') return send('spoken');
  if (q.method === 'storage.read') return send(JSON.stringify({source:window.testSource || 'es', target:window.testTarget || 'en'}));
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
      ['An avid reader.', 'avid', 'avid', null]
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
    assert page.locator(".translationHeading").locator("button").all_text_contents() == ["🔊", "Sentence", "Rules", "×"]
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
    for word, note in [("through", "route"), ("better", "sings")]:
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
    expect(page.locator("#meaning")).to_have_text("gloss")
    rules.tap()
    page.wait_for_function("replies.length === 1")
    page.evaluate("""replies.shift()(JSON.stringify({lemma:'avid',pos:'adjective',form:'base form',
      note:'Avid describes the reader.'}))""")
    expect(dialog.locator("#ruleNote")).to_contain_text("describes the reader")
    dialog.locator("#closeRules").tap()
    page.locator("#close").tap()
    page.get_by_role("button", name="avid", exact=True).tap()
    expect(label).to_have_text("adjective, base form")
    assert page.evaluate("replies.length") == 0
    page.close()


def verify_live_english(browser):
    page = open_reader(browser, """window.testSource='en';window.testTarget='ru';
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
        assert "grammar" in page.evaluate("calls.filter(q=>q.method==='ai.run').at(-1).prompt")
        page.locator("#rules").tap()
        page.evaluate("raw=>replies.shift()(raw)", json.dumps(answer))
        expect(page.locator("#ruleNote")).to_have_text(answer["grammar"]["note"])
        expect(page.locator("#grammarTable tr[aria-current=true] td")).to_have_text("saw")
        page.locator("#closeRules").tap()
        expect(page.locator("#meaning")).to_have_text(answer["translation"])
        expect(page.locator("#word")).to_have_text(answer["grammar"]["lemma"])
    saw.nth(0).tap()
    expect(page.locator("#grammarLabel")).to_contain_text("verb, past simple")
    assert page.evaluate("replies.length") == 0
    assert page.evaluate("""
      (()=>{const row={text:'My feet hurt.', words:[[0,2],[3,4],[8,4]]};
        return generationPrompt(row,'ru').includes('grammar as a separate top-level array');
      })()""")
    page.close()


if __name__ == "__main__":
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH"))
        try:
            verify_pack(browser)
            verify_pending(browser)
            verify_english_rules(browser)
            verify_live_english(browser)
        finally:
            browser.close()
