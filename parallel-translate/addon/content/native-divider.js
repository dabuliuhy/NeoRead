/* Chrome-level drag surface keeps pointer events out of the two embedded browsers.
 * Preview only while dragging; native document reflow occurs once on release. */
(function(root){
  "use strict";
  const clamp=n=>Math.max(20,Math.min(80,n));
  class NativeDivider {
    constructor(session,host){
      this.session=session;this.win=host.ownerDocument.defaultView;this.doc=host.ownerDocument;
      const make=(name,style)=>{const n=this.doc.createElementNS("http://www.w3.org/1999/xhtml",name);n.style.cssText=style;return n;};
      this.make=make;
      this.handle=make("div","position:fixed;z-index:20;width:12px;cursor:col-resize;touch-action:none;user-select:none;background:transparent;outline-offset:-3px");
      this.handle.id="paralleltranslate-divider-"+(session.reader.tabID||session.reader.itemID);
      for(const [key,value] of Object.entries({role:"separator",tabindex:"0","aria-label":"调整原文与译文宽度","aria-orientation":"vertical","aria-valuemin":"20","aria-valuemax":"80",title:"拖动调整栏宽，松开应用；双击恢复均分"}))this.handle.setAttribute(key,value);
      this.handle.append(make("span","display:block;position:absolute;left:5px;width:2px;height:100%;background:#aab8ae"));
      this.handle.addEventListener("pointerdown",e=>this.start(e));
      this.handle.addEventListener("dblclick",()=>this.apply(50));
      this.handle.addEventListener("keydown",e=>{
        if(!["ArrowLeft","ArrowRight","Home"].includes(e.key))return;
        e.preventDefault();this.apply(e.key==="Home"?50:clamp(100-parseFloat(this.session.internal._state.splitSize)+(e.key==="ArrowRight"?2:-2)));
      });
      host.append(this.handle);
    }
    position(outer,pane,hidden){
      this.handle.hidden=hidden;this.handle.style.display=hidden?"none":"";
      if(hidden){this.finish(false);return;}
      Object.assign(this.handle.style,{left:outer.left+pane.left-6+"px",top:outer.top+pane.top+"px",height:pane.height+"px"});
      const source=100-parseFloat(this.session.internal._state.splitSize);
      this.handle.setAttribute("aria-valuenow",String(Math.round(source)));
      this.handle.setAttribute("aria-valuetext","原文 "+Math.round(source)+"%，译文 "+Math.round(100-source)+"%");
    }
    start(event){
      if(event.button!==0 || this.drag || this.session.closed)return;
      event.preventDefault();event.stopPropagation();
      const s=this.session,outer=s.reader._iframe.getBoundingClientRect();
      const bounds=s.doc.querySelector(".split-view-resizer")?.parentElement.getBoundingClientRect();
      if(!bounds?.width)return;
      s.resizing=true;if(s.reading)s.reading.scrollOrigin=null;
      this.drag={id:event.pointerId,left:outer.left+bounds.left,width:bounds.width,top:outer.top+bounds.top,height:bounds.height,source:100-parseFloat(s.internal._state.splitSize)};
      this.shield=this.make("div","position:fixed;inset:0;z-index:2147483646;cursor:col-resize;touch-action:none;user-select:none;background:transparent");
      this.shield.setAttribute("data-paralleltranslate-drag","");
      this.guide=this.make("div","position:fixed;width:2px;background:#315d48;pointer-events:none;box-shadow:0 0 0 1px white");
      this.label=this.make("span","position:absolute;top:12px;left:8px;padding:5px 8px;background:#315d48;color:white;border-radius:4px;white-space:nowrap;font:12px sans-serif");
      this.guide.append(this.label);this.shield.append(this.guide);this.doc.documentElement.append(this.shield);
      this.move=e=>{if(e.pointerId===this.drag?.id){e.preventDefault();e.stopPropagation();this.preview(e.clientX);}};
      this.up=e=>{if(e.pointerId===this.drag?.id){e.preventDefault();e.stopPropagation();this.preview(e.clientX);this.finish(true);}};
      this.cancel=e=>{if(!e || e.type!=="pointercancel" || e.pointerId===this.drag?.id)this.finish(false);};
      this.escape=e=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();this.finish(false);}};
      this.win.addEventListener("pointermove",this.move,true);this.win.addEventListener("pointerup",this.up,true);
      this.win.addEventListener("pointercancel",this.cancel,true);this.win.addEventListener("blur",this.cancel);
      this.win.addEventListener("resize",this.cancel);this.win.addEventListener("keydown",this.escape,true);
      try{this.handle.setPointerCapture(event.pointerId);}catch(_){} // Synthetic tests have no active hardware pointer.
      this.preview(event.clientX);
    }
    preview(x){
      const d=this.drag;if(!d)return;
      d.source=clamp((x-d.left)/d.width*100);
      if(this.paint)return;
      this.paint=this.win.requestAnimationFrame(()=>{this.paint=null;if(!this.drag)return;
        Object.assign(this.guide.style,{left:d.left+d.width*d.source/100+"px",top:d.top+"px",height:d.height+"px"});
        this.label.textContent="原文 "+Math.round(d.source)+"% · 译文 "+Math.round(100-d.source)+"%";
      });
    }
    apply(source){
      if(this.session.closed)return;
      this.session.resizing=true;if(this.session.reading)this.session.reading.scrollOrigin=null;
      this.session.internal.setSplitViewSize((100-clamp(source)).toFixed(2)+"%");
      this.session.schedulePosition();
      if(this.settle)this.win.cancelAnimationFrame(this.settle);
      this.settle=this.win.requestAnimationFrame(()=>{this.settle=this.win.requestAnimationFrame(()=>{this.settle=null;if(!this.drag)this.session.resizing=false;});});
    }
    finish(commit){
      const d=this.drag;if(!d)return;this.drag=null;
      if(this.paint)this.win.cancelAnimationFrame(this.paint);this.paint=null;
      this.win.removeEventListener("pointermove",this.move,true);this.win.removeEventListener("pointerup",this.up,true);
      this.win.removeEventListener("pointercancel",this.cancel,true);this.win.removeEventListener("blur",this.cancel);
      this.win.removeEventListener("resize",this.cancel);this.win.removeEventListener("keydown",this.escape,true);
      try{this.handle.releasePointerCapture(d.id);}catch(_){}
      this.shield.remove();this.shield=this.guide=this.label=null;
      if(commit)this.apply(d.source);else this.session.resizing=false;
    }
    close(){this.finish(false);if(this.settle)this.win.cancelAnimationFrame(this.settle);this.session.resizing=false;this.handle.remove();}
  }
  root.ParallelNativeDivider=NativeDivider;
})(this);
