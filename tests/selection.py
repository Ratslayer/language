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
  if (q.method === 'storage.read') return send(JSON.stringify({source:'es', target:'en'}));
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
    answer = page.locator("#answer")
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


if __name__ == "__main__":
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH"))
        try:
            verify_pack(browser)
            verify_pending(browser)
        finally:
            browser.close()
