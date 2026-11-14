/* Per-paper actions in this plugin's native Zotero progress dialog. */
(function(root){
  'use strict';
  const selector='button.paralleltranslate-cancel-task';
  class QueueView {
    constructor(app){
      this.app=app;this.windows=new Map();this.pending=new Map();this.closed=false;
      this.observer={observe:(win,topic)=>{if(topic==='domwindowopened')this.watch(win,true);else if(topic==='domwindowclosed'){this.unwatch(win);this.detach(win);}}};
      Services.ww.registerNotification(this.observer);
      for(const win of Services.wm.getEnumerator(null))this.watch(win);
    }
    watch(win,opening=false){
      if(this.closed||this.pending.has(win)||this.windows.has(win))return;
      if(!opening&&win.document.readyState==='complete'){this.attach(win);return;}
      const loaded=event=>{
        if(event.target!==win.document||win.document.documentURI==='about:blank')return;
        this.unwatch(win);if(!this.closed)this.attach(win);
      };
      this.pending.set(win,{loaded});
      // The initial about:blank document unloads before the real dialog loads.
      // Only a closed window or the destination document may release this listener.
      win.addEventListener('load',loaded);
    }
    unwatch(win){
      const pending=this.pending.get(win);if(!pending)return;
      win.removeEventListener('load',pending.loaded);this.pending.delete(win);
    }
    attach(win){
      if(this.closed||this.windows.has(win)||win.document.documentURI!=='chrome://zotero/content/progressQueueDialog.xhtml'||win.arguments?.[0]?.progressQueue?.getID()!==this.app.progress.getID())return;
      const doc=win.document,tree=doc.getElementById('tree');if(!tree)return;
      const state={win,tree,frame:null};
      state.style=doc.createElementNS('http://www.w3.org/1999/xhtml','style');
      state.style.textContent=`#tree .paralleltranslate-task-message{position:relative;box-sizing:border-box;padding-inline-end:60px!important}
        #tree ${selector}{position:absolute;inset-inline-end:5px;top:50%;transform:translateY(-50%);box-sizing:border-box;min-width:46px;height:22px;padding:0 6px;border:1px solid var(--color-border,#9998);border-radius:4px;background:var(--material-background,#fff);color:inherit;font:inherit;font-size:12px;line-height:18px;cursor:pointer}
        #tree ${selector}:disabled{opacity:.4;cursor:default}
        #tree ${selector}:focus-visible{outline:2px solid var(--color-accent,#315d48);outline-offset:1px}`;
      doc.documentElement.append(state.style);
      state.schedule=()=>{if(this.closed||state.frame!==null)return;state.frame=win.requestAnimationFrame(()=>{state.frame=null;this.render(state);});};
      state.action=event=>{
        const button=event.target.closest?.(selector);if(!button||!tree.contains(button))return;
        if(['keydown','keypress'].includes(event.type)&&!['Enter',' '].includes(event.key))return;
        event.stopPropagation();
        if(event.type!=='click')return;
        event.preventDefault();if(button.disabled)return;
        const row=this.rowFor(button.closest('.row'));
        // Native rows are virtualized. Never act on a recycled row before refreshing its identity.
        if(row&&button.dataset.attachmentId===String(row.id))this.app.cancelAttachment(row.id);
        this.render(state);
      };
      state.events=['click','dblclick','mousedown','mouseup','keydown','keypress'];
      for(const type of state.events)tree.addEventListener(type,state.action,true);
      state.mutations=new win.MutationObserver(state.schedule);
      state.mutations.observe(tree,{childList:true,subtree:true,attributes:true,attributeFilter:['id']});
      state.unload=()=>this.detach(win);win.addEventListener('unload',state.unload,{once:true});
      for(const name of ['rowadded','rowupdated','rowdeleted','empty'])this.app.progress.addListener(name,state.schedule);
      this.windows.set(win,state);
      doc.getElementById('cancel-button')?.setAttribute('label','全部取消');
      this.render(state);
    }
    rowFor(node){
      const match=node?.id?.match(/-progress-queue-table-row-(\d+)$/);
      return match?this.app.progress.getRows()[Number(match[1])]:null;
    }
    render(state){
      if(this.closed||state.win.closed)return;
      for(const node of state.tree.querySelectorAll('.row')){
        const row=this.rowFor(node),cell=node.lastElementChild;if(!row||!cell)continue;
        cell.classList.add('paralleltranslate-task-message');
        let button=cell.querySelector(selector);
        if(!button){button=state.win.document.createElementNS('http://www.w3.org/1999/xhtml','button');button.className='paralleltranslate-cancel-task';button.type='button';button.textContent='取消';cell.append(button);}
        button.dataset.attachmentId=String(row.id);button.disabled=!this.app.canCancelAttachment(row.id);
        button.setAttribute('aria-label','取消翻译：'+row.fileName);button.title=button.disabled?'任务已结束':'取消此篇翻译，保留已完成译文';
      }
    }
    detach(win){
      const state=this.windows.get(win);if(!state)return;
      state.mutations.disconnect();if(state.frame!==null)win.cancelAnimationFrame(state.frame);
      for(const type of state.events)state.tree.removeEventListener(type,state.action,true);
      for(const name of ['rowadded','rowupdated','rowdeleted','empty'])this.app.progress.removeListener(name,state.schedule);
      win.removeEventListener('unload',state.unload);
      state.tree.querySelectorAll(selector).forEach(button=>button.remove());
      state.tree.querySelectorAll('.paralleltranslate-task-message').forEach(cell=>cell.classList.remove('paralleltranslate-task-message'));
      state.style.remove();this.windows.delete(win);
    }
    close(){
      if(this.closed)return;this.closed=true;Services.ww.unregisterNotification(this.observer);
      for(const win of [...this.pending.keys()])this.unwatch(win);
      for(const win of [...this.windows.keys()])this.detach(win);
    }
  }
  root.ParallelQueueView=QueueView;
})(this);
