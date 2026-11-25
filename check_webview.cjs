(async()=>{
 const cp=require('node:child_process');
 const pid=cp.execFileSync('adb',['shell','pidof','app.aipages']).toString().trim();
 cp.execFileSync('adb',['forward','tcp:9222','localabstract:webview_devtools_remote_'+pid]);
 const tabs=await(await fetch('http://localhost:9222/json/list')).json();
 const t=tabs.find(t=>t.title==='Language Reader');
 if(!t)throw Error('Reader WebView unavailable');
 const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no});
 const expression=process.argv[2]||'({browser:navigator.userAgent,title:document.title,words:document.querySelectorAll(".passageWord").length})';
 const reply=new Promise(ok=>{ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.id===1)ok(r)}});
 ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));
 const r=await reply;ws.close();
 if(r.result.exceptionDetails)throw Error(r.result.exceptionDetails.text);
 console.log(JSON.stringify(r.result.result.value??null));
})().catch(e=>{console.error(e);process.exitCode=1});
