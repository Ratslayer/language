'use strict';

// During a drag the passage keeps its normal document scroll. Only the two page layers move.
class PageSlider {
  constructor(reader, preview) {
    this.reader=reader;
    this.preview=preview;
    this.body=preview.firstElementChild;
    this.footer=reader.querySelector('nav').cloneNode(true);
    for(const child of this.footer.querySelectorAll('[id]')) child.removeAttribute('id');
    this.reduced=matchMedia('(prefers-reduced-motion: reduce)');
    this.animations=[];
    this.offset=0;
    this.target=null;
  }
  position(element,x) { element.style.transform=x ? 'translate3d('+x+'px,0,0)' : ''; }
  reset() {
    for(const animation of this.animations) animation.cancel();
    this.animations=[];
    this.position(this.reader,0);
    this.position(this.preview,0);
    this.preview.hidden=true;
    this.body.replaceChildren();
    this.target=null;
    this.offset=0;
  }
  // The real passage (including canvases and word handlers) changes layers without being copied.
  mount(article,title,page,total) {
    const heading=document.createElement('h1');
    heading.className='readingTitle';
    heading.textContent=title;
    const [prev,count,next]=this.footer.children;
    prev.disabled=page===0;
    next.disabled=page===total-1;
    count.textContent=(page+1)+' / '+total;
    this.footer.hidden=total<2;
    this.body.replaceChildren(heading,article,this.footer);
    this.preview.hidden=false;
    this.preview.scrollTop=0;
  }
  drag(dx,width,step,target) {
    if(this.reduced.matches) return;
    if(this.animations.length) this.reset();
    this.offset=target ? Math.max(-width,Math.min(width,dx)) : dx*.14;
    this.position(this.reader,this.offset);
    if(this.target!==target) {
      this.target=target;
      this.preview.hidden=true;
      this.body.replaceChildren();
      if(target) {
        if(!target.article) {
          const loading=document.createElement('p');
          loading.textContent='Loading page…';
          this.mount(loading,target.title,target.page,target.total);
        }
        const show=()=>{
          if(this.target!==target || !target.article) return;
          this.mount(target.article,target.title,target.page,target.total);
          target.paint();
        };
        if(target.article) show();
        else target.ready.then(show,()=>{});
      }
    }
    this.position(this.preview,this.offset+step*width);
  }
  slide(element,from,to,duration) {
    const transform=x=>'translate3d('+x+'px,0,0)';
    const animation=element.animate([{transform:transform(from)},{transform:transform(to)}],
      {duration,easing:'cubic-bezier(.18,.72,.26,1)',fill:'both'});
    this.animations.push(animation);
    return animation;
  }
  settle(readerFrom,readerTo,previewFrom,previewTo,duration) {
    if(!this.preview.hidden) this.slide(this.preview,previewFrom,previewTo,duration);
    const last=this.slide(this.reader,readerFrom,readerTo,duration);
    last.onfinish=()=>{if(this.animations.includes(last)) this.reset();};
  }
  snapBack() {
    if(!this.offset || this.reduced.matches) {this.reset();return;}
    const side=this.offset<0 ? innerWidth : -innerWidth;
    this.settle(this.offset,0,side+this.offset,side,100);
  }
  commit(step,oldPage,target,display) {
    const width=innerWidth,dx=this.target===target ? this.offset : 0;
    const article=document.getElementById('passage'),y=window.scrollY;
    const status=['progress','status'].map(id=>document.getElementById(id)).filter(el=>!el.hidden && el.textContent)
      .map(el=>{const p=document.createElement('p');p.className=el.id+'Copy';p.textContent=el.textContent;return p;});
    this.reset();
    display();
    if(this.reduced.matches || Math.abs(step*width+dx)<1) return;
    this.mount(article,target.title,oldPage,target.total);
    this.body.firstElementChild.after(...status);
    this.preview.scrollTop=y;
    const remaining=Math.abs(step*width+dx)/width;
    this.settle(step*width+dx,0,dx,-step*width,Math.max(65,Math.min(150,150*remaining)));
  }
}
