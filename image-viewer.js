'use strict';
function createImageViewer(dialog) {
  const surface=dialog.querySelector('canvas'),context=surface.getContext('2d');
  const close=dialog.querySelector('[data-close]'),zoomOut=dialog.querySelector('[data-out]');
  const zoomIn=dialog.querySelector('[data-in]'),reset=dialog.querySelector('[data-fit]');
  let image,opener,zoom=1,x=0,y=0,frame=0,lastTap=null,press=null;
  const pointers=new Map();
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const fit=()=>Math.min(surface.clientWidth/image.width,surface.clientHeight/image.height);
  const limit=()=>Math.max(8,1/fit());
  function paint() {
    if(!image || !surface.clientWidth || !surface.clientHeight) return;
    const w=surface.clientWidth,h=surface.clientHeight,dpr=window.devicePixelRatio || 1;
    if(surface.width!==Math.round(w*dpr)) surface.width=Math.round(w*dpr);
    if(surface.height!==Math.round(h*dpr)) surface.height=Math.round(h*dpr);
    const width=image.width*fit()*zoom,height=image.height*fit()*zoom;
    const dx=Math.max(0,(width-w)/2),dy=Math.max(0,(height-h)/2);
    x=clamp(x,-dx,dx); y=clamp(y,-dy,dy);
    context.setTransform(surface.width/w,0,0,surface.height/h,0,0);
    context.clearRect(0,0,w,h);
    context.drawImage(image,(w-width)/2+x,(h-height)/2+y,width,height);
    zoomOut.disabled=reset.disabled=zoom<=1;
    zoomIn.disabled=zoom>=limit();
  }
  function redraw() {
    if(!frame) frame=requestAnimationFrame(()=>{frame=0;paint();});
  }
  function transform(factor,fromX=0,fromY=0,toX=fromX,toY=fromY) {
    const next=clamp(zoom*factor,1,limit());
    x=toX+(x-fromX)*next/zoom;
    y=toY+(y-fromY)*next/zoom;
    zoom=next;
    if(zoom===1) x=y=0;
    redraw();
  }
  function fitImage() { zoom=1; x=y=0; redraw(); }
  function point(event) {
    const rect=surface.getBoundingClientRect();
    return {x:event.clientX-rect.left-rect.width/2,y:event.clientY-rect.top-rect.height/2};
  }
  function pair() {
    const [a,b]=pointers.values();
    return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,d:Math.hypot(b.x-a.x,b.y-a.y)};
  }
  surface.onpointerdown=event=>{
    if(event.button!==0) return;
    surface.setPointerCapture(event.pointerId);
    const p=point(event);
    pointers.set(event.pointerId,p);
    press=pointers.size===1 ? {...p,time:performance.now()} : null;
    if(!press) lastTap=null;
  };
  surface.onpointermove=event=>{
    const old=pointers.get(event.pointerId);
    if(!old) return;
    const before=pointers.size===2 ? pair() : null;
    const p=point(event);
    pointers.set(event.pointerId,p);
    if(press && Math.hypot(p.x-press.x,p.y-press.y)>8) {press=null;lastTap=null;}
    if(before) {
      const after=pair();
      if(before.d>0 && after.d>0) transform(after.d/before.d,before.x,before.y,after.x,after.y);
    } else if(pointers.size===1) transform(1,old.x,old.y,p.x,p.y);
  };
  surface.onpointerup=event=>{
    if(!pointers.delete(event.pointerId)) return;
    const p=point(event),time=performance.now();
    if(press && time-press.time<350 && Math.hypot(p.x-press.x,p.y-press.y)<8) {
      if(lastTap && time-lastTap.time<350 && Math.hypot(p.x-lastTap.x,p.y-lastTap.y)<32) {
        if(zoom>1) fitImage();
        else transform(2.5,p.x,p.y);
        lastTap=null;
      } else lastTap={...p,time};
    }
    press=null;
  };
  surface.onlostpointercapture=surface.onpointercancel=event=>{
    if(pointers.delete(event.pointerId)) {press=null;lastTap=null;}
  };
  surface.addEventListener('wheel',event=>{
    event.preventDefault();
    const p=point(event),delta=event.deltaY*(event.deltaMode===1 ? 16 : event.deltaMode===2 ? surface.clientHeight : 1);
    transform(Math.exp(-clamp(delta,-500,500)*0.002),p.x,p.y);
  },{passive:false});
  zoomOut.onclick=()=>transform(1/1.5);
  zoomIn.onclick=()=>transform(1.5);
  reset.onclick=fitImage;
  close.onclick=()=>dialog.close();
  // Chromium may suppress the compatibility click immediately after a multi-touch gesture.
  dialog.querySelector('.imageControls').addEventListener('touchend',event=>{
    const button=event.target.closest('button'),touch=event.changedTouches[0];
    if(button && !button.disabled && !event.touches.length && touch &&
       document.elementFromPoint(touch.clientX,touch.clientY)===button) {
      event.preventDefault();
      button.click();
    }
  },{passive:false});
  dialog.onkeydown=event=>{
    const directions={ArrowLeft:[64,0],ArrowRight:[-64,0],ArrowUp:[0,64],ArrowDown:[0,-64]};
    if(directions[event.key]) {
      const [dx,dy]=directions[event.key];transform(1,0,0,dx,dy);
    } else if(event.key==='+' || event.key==='=') transform(1.5);
    else if(event.key==='-') transform(1/1.5);
    else if(event.key==='0') fitImage();
    else return;
    event.preventDefault();
  };
  new ResizeObserver(redraw).observe(surface);
  dialog.onclose=()=>{
    image=null; press=lastTap=null; pointers.clear();
    surface.width=surface.height=1;
    if(opener?.isConnected) opener.focus({preventScroll:true});
    opener=null;
  };
  return (canvas,button,label)=>{
    image=canvas; opener=button; zoom=1; x=y=0;
    surface.setAttribute('aria-label',label);
    dialog.showModal();
    paint();
  };
}
