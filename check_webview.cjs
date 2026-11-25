(async()=>{
 const cp=require('node:child_process');
 const pid=cp.execFileSync('adb',['shell','pidof','app.aipages']).toString().trim();
 cp.execFileSync('adb',['forward','tcp:9222','localabstract:webview_devtools_remote_'+pid]);
 const tabs=await(await fetch('http://localhost:9222/json/list')).json();
 for(const t of tabs){
  const ws=new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no});
  ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:'JSON.stringify({browser:navigator.userAgent,title:document.title,h:innerHeight,w:innerWidth,books:document.querySelectorAll(".bookCard").length,words:document.querySelectorAll(".passageWord").length,source:typeof hasShelf,popup:document.querySelector("#popup")?.getBoundingClientRect()})',returnByValue:true}}));
  console.log(await new Promise(ok=>ws.onmessage=e=>ok(e.data)));ws.close();
 }
})().catch(console.error);
