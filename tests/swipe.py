"""Run against npm run build with Python Playwright and Chromium (CHROMIUM_PATH is optional)."""
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import expect, sync_playwright


def verify(browser, url):
    page = browser.new_page(viewport={"width": 390, "height": 760}, has_touch=True, is_mobile=True)
    cdp = page.context.new_cdp_session(page)

    def touch(kind, x=None):
        points = [] if x is None else [{"id": 1, "x": x, "y": 360}]
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": points})

    def offset():
        return page.locator("#reader").evaluate("el => el.getBoundingClientRect().left") - origin

    page.goto(url)
    page.locator("#importBook").tap()
    page.locator("#file").set_input_files({
        "name": "drag.txt", "mimeType": "text/plain",
        "buffer": " ".join(f"Sentence number {n}." for n in range(400)).encode(),
    })
    reader = page.locator("#reader")
    passage = page.locator("#passage")
    preview = page.locator("#pagePreview")
    expect(reader).to_be_visible()
    origin = reader.bounding_box()["x"]
    original = passage.text_content()

    for start, end, number in [(290, 165, "2"), (100, 225, "1")]:
        touch("touchStart", start)
        touch("touchMove", end)
        expect(preview.locator("article")).to_be_visible()
        assert abs(offset() - (end - start)) < 1
        incoming = preview.locator("article").text_content()
        assert incoming and incoming != passage.text_content()
        touch("touchEnd")
        expect(page.locator("#pageNumber")).to_have_value(number)
        assert passage.text_content() == incoming
        expect(preview).to_be_hidden()

    touch("touchStart", 290)
    touch("touchMove", 190)
    assert abs(offset() + 100) < 1
    touch("touchCancel")
    expect(preview).to_be_hidden()
    assert abs(offset()) < 1 and passage.text_content() == original

    page.emulate_media(reduced_motion="reduce")
    touch("touchStart", 290)
    touch("touchMove", 160)
    assert abs(offset()) < 1
    touch("touchEnd")
    expect(page.locator("#pageNumber")).to_have_value("2")
    expect(preview).to_be_hidden()
    page.close()


if __name__ == "__main__":
    dist = Path(__file__).resolve().parents[1] / "dist"
    handler = partial(SimpleHTTPRequestHandler, directory=str(dist))
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server, sync_playwright() as playwright:
        Thread(target=server.serve_forever, daemon=True).start()
        browser = playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH"))
        try:
            verify(browser, f"http://127.0.0.1:{server.server_port}/")
        finally:
            browser.close()
            server.shutdown()
