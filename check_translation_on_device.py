"""Tap a prepared word through the real AI Pages WebView and OCR the device screenshot."""
import base64
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import csv
import io
import subprocess
import time
import xml.etree.ElementTree as ET

PACKAGE = 'app.aipages'
HOST = Path('host')
TEST = Path('phone-fixture')
TEST.mkdir()
SOURCE = '1_f_zhiRS4UjK8lzw5aXr80Iv2G7RpVTd'

def adb(*args, data=None):
    return subprocess.run(['adb', *args], input=data, stdout=subprocess.PIPE, check=True).stdout

def put(relative, data):
    adb('shell', 'run-as', PACKAGE, 'mkdir', '-p', str(Path(relative).parent))
    adb('exec-in', 'run-as', PACKAGE, 'sh', '-c', "'cat > "+relative+"'", data=data)

def prefs(name, **fields):
    root = ET.Element('map')
    for key, val in fields.items():
        ET.SubElement(root, 'string', name=key).text = val
    put('shared_prefs/'+name+'.xml', ET.tostring(root, encoding='utf-8', xml_declaration=True))

def screen_text(tsv=False):
    shot=adb('exec-out','screencap','-p')
    args=['tesseract','stdin','stdout','-l','eng','--psm','6']
    if tsv: args.append('tsv')
    return subprocess.run(args,input=shot,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=True).stdout.decode()

def tap_text(label):
    rows=[r for r in csv.DictReader(io.StringIO(screen_text(True)), delimiter='\t') if r['text'].strip()]
    tokens=label.casefold().split()
    for i in range(len(rows)-len(tokens)+1):
        run=rows[i:i+len(tokens)]
        if [r['text'].casefold().strip('.,:') for r in run] == tokens:
            r=run[0]
            adb('shell','input','tap',str(int(r['left'])+int(r['width'])//2),str(int(r['top'])+int(r['height'])//2))
            print('Tapped displayed text:',label,flush=True)
            return True
    return False

def tap(label):
    deadline = time.monotonic()+60
    labels = []
    while time.monotonic()<deadline:
        adb('shell','uiautomator','dump','/data/local/tmp/reader-window.xml')
        root = ET.fromstring(adb('exec-out','cat','/data/local/tmp/reader-window.xml'))
        labels = []
        for node in root.iter('node'):
            name = node.get('text') or node.get('content-desc') or ''
            labels.append(name)
            if label.casefold() in name.casefold():
                x1,y1,x2,y2 = map(int,re.findall(r'\d+', node.get('bounds')))
                if x2>x1 and y2>y1:
                    adb('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2))
                    return
        if tap_text(label): return
        time.sleep(.5)
    print('Screen OCR:', screen_text(), flush=True)
    print(adb('logcat','-d','-t','650','chromium:I','AndroidRuntime:W','*:S').decode(errors='replace')[-5000:])
    subprocess.run(['node','check_webview.cjs'])
    raise AssertionError((label, [s for s in labels if s]))

def check_screen(*terms):
    deadline = time.monotonic()+20
    while True:
        shot = adb('exec-out','screencap','-p')
        text = subprocess.run(['tesseract','stdin','stdout','-l','eng','--psm','6'],input=shot,
                              stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=True).stdout.decode()
        if all(re.search(r'\b'+re.escape(t)+r'\b',text,re.I) for t in terms):
            print('Device screenshot shows:', ', '.join(terms),flush=True)
            return
        if time.monotonic()>=deadline:
            subprocess.run(['node','check_webview.cjs'])
            raise AssertionError(text)
        time.sleep(1)

adb('install','-r',str(HOST/'app/build/outputs/apk/debug/app-debug.apk'))
catalogue = (HOST/'feed/catalog.json').read_bytes()
payload = json.loads(base64.b64decode(json.loads(catalogue)['payload']))
reader = next(p for p in payload['pages'] if p['id']=='language')
assert all(Path(n).read_text()==s for n,s in reader['files'].items()), 'Signed catalogue does not contain the tested page'
print('Testing signed reader', reader['version'],flush=True)
key=(HOST/'app/src/main/assets/ai-pages-public.txt').read_text().strip()
prefs('page-feed', **{'public-key':key})
put('files/catalog.json',catalogue)
prefs('language-catalogue',source=SOURCE,books='[]')
prefs('tool-language',state=json.dumps({'catalogueSource':SOURCE}))
fixture='Muchos libros.'
book_id=hashlib.sha256(('reader.book.1\nes\n'+fixture).encode()).hexdigest()
for suffix,fmt,lang in [('book','reader.book.1','es'),('en','reader.translation.1','en')]:
    name=f'{book_id}.{suffix}.sqlite'
    db=sqlite3.connect(TEST/name)
    with db:
        db.execute('CREATE TABLE meta(format TEXT,book_id TEXT,lang TEXT,title TEXT)')
        db.execute('INSERT INTO meta VALUES(?,?,?,?)',(fmt,book_id,lang,'Translation check'))
        if suffix=='book':
            db.execute('CREATE TABLE sentences(id INTEGER PRIMARY KEY,page INTEGER,para INTEGER,chapter TEXT,pdf_start INTEGER,pdf_end INTEGER,text TEXT,words TEXT)')
            db.execute('INSERT INTO sentences VALUES(1,0,0,"",1,1,?,?)',(fixture,'[[0,6],[7,6]]'))
        else:
            db.execute('CREATE TABLE entries(sid INTEGER PRIMARY KEY,payload TEXT)')
            db.execute('INSERT INTO entries VALUES(1,?)',(json.dumps({'translation':'Many books.','groups':[[[0],'mucho','many'],[[1],'libro','books']]}),))
    db.close()
    put('files/language-books/'+name,(TEST/name).read_bytes())
adb('shell','am','start','-W','-n',PACKAGE+'/.MainActivity')
tap('Language Reader')
tap('Translation check')
print('In book:',screen_text(),flush=True)
tap('Muchos')
check_screen('many','mucho')
tap('Translate sentence')
check_screen('Many books')
