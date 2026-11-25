"""Tap a prepared word through the real AI Pages WebView and OCR the device screenshot."""
import base64
import json
from pathlib import Path
import re
import csv
import io
import subprocess
import time
import xml.etree.ElementTree as ET

PACKAGE = 'app.aipages'
HOST = Path('host')

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
    print('Missing tap target:', label, flush=True)
    print(adb('logcat','-d','-t','650','chromium:I','AndroidRuntime:W','*:S').decode(errors='replace')[-5000:])
    subprocess.run(['node','check_webview.cjs'])
    raise AssertionError(label)

def check_screen(*terms):
    deadline = time.monotonic()+20
    while True:
        shot = adb('exec-out','screencap','-p')
        text = subprocess.run(['tesseract','stdin','stdout','-l','eng','--psm','6'],input=shot,
                              stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=True).stdout.decode()
        if all(re.search(r'\b'+re.escape(t)+r'\b',' '.join(text.split()),re.I) for t in terms):
            print('Device screenshot shows:', ', '.join(terms),flush=True)
            return
        if time.monotonic()>=deadline:
            subprocess.run(['node','check_webview.cjs'])
            raise AssertionError(terms)
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
adb('shell','am','start','-W','-n',PACKAGE+'/.MainActivity')
tap('Language Reader')
tap('soledad')
tap('Muchos')
check_screen('many','mucho')
def js(expression):
    return json.loads(subprocess.check_output(['node','check_webview.cjs',expression]))
def wait_value(expression, expected):
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        if js(expression)==expected: return
        time.sleep(.3)
    raise AssertionError((expression,expected,js(expression)))

def tap_selector(selector):
    # Two labels can contain the same word. Use the passage button's rectangle for a physical tap.
    sel=json.dumps(selector)
    js(f'document.querySelector({sel}).scrollIntoView({{block:"center"}}); true')
    target=js(f'(()=>{{const e=document.querySelector({sel}),r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {{x,y,width:innerWidth,hit:e.contains(document.elementFromPoint(x,y))}};}})()')
    assert target['hit'],(selector,target)
    adb('shell','uiautomator','dump','/data/local/tmp/reader-window.xml')
    ax=ET.fromstring(adb('exec-out','cat','/data/local/tmp/reader-window.xml'))
    bounds=[list(map(int,re.findall(r'\d+',n.get('bounds')))) for n in ax.iter('node') if n.get('class')=='android.webkit.WebView']
    if bounds:
        x0,y0,x2,y2=max(bounds,key=lambda r:(r[2]-r[0])*(r[3]-r[1]))
    else:
        root_box=list(map(int,re.findall(r'\d+',ax.find('node').get('bounds'))))
        tools=next(n for n in ax.iter('node') if n.get('text','').lower()=='tools')
        x0,_,x2,y2=root_box
        y0=list(map(int,re.findall(r'\d+',tools.get('bounds'))))[3]
    scale=(x2-x0)/target['width']
    adb('shell','input','tap',str(round(x0+scale*target['x'])),str(round(y0+scale*target['y'])))
    print('Tapped Android screen at',selector,flush=True)

tap_selector('.passageWord.active')
wait_value('document.getElementById("popup").hidden',True)
tap_selector('.passageWord')
check_screen('many','mucho')
tap('Translate sentence')
check_screen('firing squad')

js('document.getElementById("pageNumber").scrollIntoView(); document.getElementById("pageNumber").focus(); document.getElementById("pageNumber").select(); true')
adb('shell','input','text','12')
adb('shell','input','keyevent','KEYCODE_ENTER')
wait_value('document.getElementById("count").textContent','12 / 634')
adb('shell','input','swipe','150','460','150','250','350')
time.sleep(1.2)
position=js('window.scrollY')
assert position>20,('No book scroll',position)
def native_position():
    raw=adb('exec-out','run-as',PACKAGE,'cat','shared_prefs/tool-language.xml')
    state=json.loads(ET.fromstring(raw).find("string[@name='state']").text)
    return state['bookmarks'].get(state['packId'])
print('Before restart, device scroll and stored bookmark:',position,native_position(),flush=True)
adb('shell','am','force-stop',PACKAGE)
adb('shell','am','start','-W','-n',PACKAGE+'/.MainActivity')
tap('Language Reader')
tap('soledad')
wait_value('!document.getElementById("reader").hidden && document.getElementById("pageNumber").value==="12"',True)
deadline=time.monotonic()+8
restored=js('window.scrollY')
while abs(restored-position)>2 and time.monotonic()<deadline:
    time.sleep(.25)
    restored=js('window.scrollY')
print('After reopen, device scroll and stored bookmark:',restored,native_position(),flush=True)
assert abs(restored-position)<=2,(restored,position)
print('Android second tap, jump to page 12, process restart and restored scroll passed:',restored,flush=True)
