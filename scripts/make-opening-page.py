"""Build a first-page asset from the exact SQLite files in a reader catalogue."""
import argparse
import base64
import hashlib
import json
import sqlite3
from contextlib import closing
from pathlib import Path


def checked_database(path, asset):
    if hashlib.sha256(path.read_bytes()).hexdigest() != asset["sha256"]:
        raise ValueError(f"{path} differs from the catalogue")
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA trusted_schema=OFF")
    return db


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalogue", type=Path)
    parser.add_argument("slug")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("translations", nargs="*", metavar="LANG=FILE")
    args = parser.parse_args()
    item = next(b for b in json.loads(args.catalogue.read_bytes())["books"] if b["id"] == args.slug)
    with closing(checked_database(args.source, item["source"])) as db:
        info = dict(db.execute("SELECT format,book_id AS book,lang,title FROM meta").fetchone())
        info["pages"] = db.execute("SELECT max(page)+1 FROM sentences").fetchone()[0]
        if info["book"] != item["bookId"] or info["pages"] != item["pages"]:
            raise ValueError("Source metadata differs from the catalogue")
        rows = [dict(r) for r in db.execute("""
            SELECT id,para,chapter,pdf_start AS pdf,pdf_end AS pdfEnd,text,words
            FROM sentences WHERE page=0 ORDER BY id""")]
        by_id = {row["id"]: row for row in rows}
        for row in rows:
            row["words"] = json.loads(row["words"])
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='illustrations'").fetchone():
            for image in db.execute("""
                SELECT sid,width,height,mime,alt,data FROM illustrations
                WHERE sid IN (SELECT id FROM sentences WHERE page=0) ORDER BY sid,position"""):
                image = dict(image)
                image["data"] = base64.b64encode(image["data"]).decode()
                by_id[image.pop("sid")].setdefault("illustrations", []).append(image)
    languages = {}
    for spec in args.translations:
        lang, path = spec.split("=", 1)
        asset = item["languages"][lang]
        with closing(checked_database(Path(path), asset)) as db:
            entries = {sid: json.loads(payload) for sid, payload in db.execute(
                "SELECT sid,payload FROM entries WHERE sid BETWEEN ? AND ?", (min(by_id), max(by_id))) if sid in by_id}
        languages[lang] = {"sha256": asset["sha256"], "entries": entries}
    packet = {"info": info, "page": 0, "rows": rows, "languages": languages}
    data = json.dumps(packet, separators=(",", ":"), ensure_ascii=False).encode()
    if len(data) > 4 * 1024 * 1024:
        raise ValueError("Opening page exceeds the 4 MiB limit")
    args.output.write_bytes(data)
    print(json.dumps({"sourceSha256": item["source"]["sha256"], "sha256": hashlib.sha256(data).hexdigest()}))


if __name__ == "__main__":
    main()
