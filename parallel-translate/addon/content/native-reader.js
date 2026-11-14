/* Zotero 10.0.8 adapter. Source DOM, character offsets and annotations remain native. */
(function (root) {
  "use strict";
  class NativeSession {
    constructor(app, reader) {
      this.app = app; this.reader = reader; this.internal = reader._internalReader;
      this.doc = reader._iframeWindow.document; this.win = this.doc.defaultView;
      this.closed = false; this.expanded = true; this.links = new Map(); this.refIDs = new Map(); this.sourceListeners = [];
      const previous=reader._parallelTranslateSession;
      this.before = previous?.closed ? previous.before : {split:this.internal.splitType,size:this.internal._state.splitSize,reading:Boolean(this.internal._primarySDTView)};
      // The facade scopes open requests and cancellation to this tab.
      this.facade = Object.create(app); this.facade.nativeSession = this;
      for (const name of ["subscribe","saveSettings","saveKey","listModels","startJob","pauseJob","testConnection","createFromAttachment","findSavedTranslation","prepareAttachment","readPDF","checkSource","getSettings","getAppearance","saveAppearance","hasKey","keyFor","referenceStore","referenceDetails","referenceAbstract"]) this.facade[name] = app[name].bind(app);
      this.facade.open = () => { this.facade.openRequest = {sequence:++app.openSequence,itemID:reader.itemID,sourceWindow:Zotero.getMainWindow()}; app.emit(); };
      this.facade.pauseAll = () => {
        const jobs = [...app.jobs.values()].filter(j=>j.document.attachmentID===reader.itemID);
        for (const job of jobs) app.pauseJob(job.id);
        return jobs.map(j=>app.runners.get(j.id)?.promise).filter(Boolean);
      };
      this.facade.startJob = async id => {
        if(this.closed || !this.isActive())return;
        return app.startJob(id);
      };
    }
    mount() {
      const r = this.internal, doc = this.doc;
      if (!r?._setReadingMode || !r.toggleVerticalSplit || !r._secondaryViewContainer) throw new Error("当前 Zotero 不支持此阅读模式接口。本版需要 Zotero 10.0.8。");
      this.reader._parallelTranslateSession=this;
      r.toggleVerticalSplit(true); r._lastViewPrimary = true;
      this.container = r._secondaryViewContainer;
      this.style = doc.createElement("style");
      this.style.textContent = ".paralleltranslate-native-container{position:relative!important}.paralleltranslate-native-container>iframe:not(.paralleltranslate-native-panel){visibility:hidden!important;pointer-events:none!important}.paralleltranslate-native-panel{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;border:0!important;background:var(--material-background,#fff);z-index:5}";
      doc.head.append(this.style); this.container.classList.add("paralleltranslate-native-container");
      this.placeholder = doc.createElement("div"); this.placeholder.id = "paralleltranslate-native-panel";
      this.placeholder.className="paralleltranslate-native-panel";
      this.container.append(this.placeholder);
      // The reader is a content browser. Keep privileged API/settings code in a chrome browser
      // owned by the same tab, positioned over the native secondary pane (no privilege bridge).
      const owner=readerWindow(this.reader),host=this.reader._tabContainer || this.reader._iframe.parentNode;
      this.frame=owner.document.createXULElement("browser");
      this.frame.setAttribute("aria-label","中文译文");
      this.frame.setAttribute("disablehistory","true");
      this.frame.style.cssText="position:fixed;z-index:10;border:0;min-width:0;min-height:0";
      this.frame.addEventListener("DOMContentLoaded",event=>{
        if(event.target!==this.frame.contentDocument || this.closed)return;
        this.frame.contentWindow.ParallelTranslateContext={app:this.facade,sourceWindow:Zotero.getMainWindow(),nativeSession:this};
      },true);
      this.facade.open();
      this.frame.setAttribute("src","chrome://paralleltranslate/content/workspace.xhtml");host.append(this.frame);
      this.divider=new root.ParallelNativeDivider(this,host);
      this.tabHost=this.reader._tabContainer;
      this.tabSelected=event=>this.positionPanel(event.detail.selected);this.tabHost?.addEventListener("tab-selection-change",this.tabSelected);
      this.resizeObserver=new this.win.ResizeObserver(()=>this.schedulePosition());this.resizeObserver.observe(this.container);
      this.outerResizeObserver=new owner.ResizeObserver(()=>this.schedulePosition());this.outerResizeObserver.observe(this.reader._iframe);
      this.positionPanel();
      this.setPressed(true);
      this.unload = () => this.close(false); this.win.addEventListener("unload",this.unload,{once:true});
      this.observer = new this.win.MutationObserver(() => {
        if (this.closed) return;
        if (!this.frame.isConnected || !this.placeholder.isConnected || !r.splitType) { this.close(false); return; }
        this.attachSource();
      });
      this.observer.observe(r._primaryViewContainer,{childList:true});
      this.observer.observe(this.container,{childList:true});
      // Mount the visible panel before awaiting parsing. Zotero keeps the PDF readable meanwhile.
      this.sourceReady = Promise.resolve(r._setReadingMode(true,true)).then(async () => {
        // Zotero resolves the transition before the overlay is initialized. Its destroy()
        // requires that initialization, even when the user has already closed our panel.
        await r._primarySDTView?.initializedPromise;
        if (!this.closed) this.attachSource();
      }).catch(error => { if (!this.closed) this.reading?.message("Zotero 阅读模式暂不可用，左侧保留 PDF。",true); Zotero.logError(error); });
      this.attachSource();
    }
    schedulePosition(){
      if(this.closed || this.positionFrame)return;
      this.positionFrame=this.win.requestAnimationFrame(()=>{this.positionFrame=null;this.positionPanel();});
    }
    positionPanel(selected){
      if(this.closed)return;
      this.frame.hidden=!(typeof selected==="boolean"?selected:this.isActive());
      this.frame.style.display=this.frame.hidden?"none":"";
      this.reading?.citations?.setActive(!this.frame.hidden);
      if(this.frame.hidden){this.divider?.position(null,null,true);return;}
      const outer=this.reader._iframe.getBoundingClientRect(),pane=this.container.getBoundingClientRect();
      const position=this.expanded?{left:outer.left+"px",top:outer.top+"px",width:outer.width+"px",height:outer.height+"px"}:{left:outer.left+pane.left+"px",top:outer.top+pane.top+"px",width:pane.width+"px",height:pane.height+"px"};
      for(const [key,value] of Object.entries(position))if(this.frame.style[key]!==value)this.frame.style[key]=value;
      this.divider?.position(outer,pane,this.expanded);
      if(this.reading?.citations&&!this.reading.citations.card.hidden)this.reading.citations.place();
    }
    isActive(){return !this.reader.tabID || readerWindow(this.reader).Zotero_Tabs?.selectedID===this.reader.tabID;}
    setPressed(value) { this.doc.getElementById("parallel-translate-shortcut")?.setAttribute("aria-pressed",String(value)); }
    async structured() {
      const value = await this.internal._loadSDT();
      if (!value?.structure) throw new Error("Zotero 尚未能解析这份文档，请稍后重试。");
      // A separate value prevents repair code or future extensions from changing native offsets.
      return JSON.parse(JSON.stringify(value.structure));
    }
    async borrowPDF() {
      const view = this.internal._primaryView;
      await view.initializedPromise;
      const pdf = view._iframeWindow?.PDFViewerApplication?.pdfDocument;
      if (this.closed || !pdf) throw new Error("原文阅读器已关闭或 PDF 尚未加载。");
      return pdf;
    }
    async crop(pageNumber,rect){
      if(this.closed)throw new Error("阅读器已关闭");
      const cache = this.cropCache ||= new Map(), key = JSON.stringify([pageNumber, rect]);
      if (cache.has(key)) { const hit=cache.get(key); cache.delete(key); cache.set(key,hit); return hit; }
      const pending = this.cropPending ||= new Map();
      if(pending.has(key))return pending.get(key);
      const batches = this.cropBatches ||= new Map();
      let batch=batches.get(pageNumber);
      if(!batch){batch={entries:[]};batches.set(pageNumber,batch);batch.timer=setTimeout(()=>this.flushCrops(pageNumber,batch),0);}
      const entry={key,rect:[...rect]};
      const promise=new Promise((resolve,reject)=>Object.assign(entry,{resolve,reject}));
      entry.promise=promise;pending.set(key,promise);batch.entries.push(entry);return promise;
    }
    async flushCrops(pageNumber,batch){
      if(this.cropBatches.get(pageNumber)===batch)this.cropBatches.delete(pageNumber);
      try{
        if(this.closed)throw Error("阅读器已关闭");
        // Zotero renders the union once, then slices it. Main images, index
        // previews and thumbnails requested together need only one page pass.
        const renderer=this.internal._primaryView._pdfRenderer,rects=batch.entries.map(e=>e.rect);
        let combine=true;
        if(rects.length>1&&renderer._preparePageRegion){
          const pdf=await this.borrowPDF(),page=await pdf.getPage(pageNumber);
          const bounds=rects.reduce((a,b)=>[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])]);
          const scale=renderer._preparePageRegion(page,this.clone(bounds))?.viewport.scale;
          // A large union must not hit Zotero's canvas cap and reduce the
          // resolution of a smaller image that could be rendered at full size.
          combine=Number.isFinite(scale)&&rects.every(rect=>renderer._preparePageRegion(page,this.clone(rect))?.viewport.scale===scale);
        }
        if(this.closed)throw Error("阅读器已关闭");
        const images=combine?await renderer.renderRegionCrops(pageNumber-1,this.clone(rects)):await Promise.all(rects.map(async rect=>(await renderer.renderRegionCrops(pageNumber-1,this.clone([rect])))[0]));
        if(this.closed)throw Error("阅读器已关闭");
        for(const [i,entry] of batch.entries.entries()){
          const image=images[i];
          if(!image){entry.reject(Error("图像加载失败"));continue;}
          if(image.length<=2_000_000){this.cropCache.set(entry.key,image);while(this.cropCache.size>8)this.cropCache.delete(this.cropCache.keys().next().value);}
          entry.resolve(image);
        }
      }catch(error){for(const entry of batch.entries)entry.reject(error);}
      finally{for(const entry of batch.entries)if(this.cropPending.get(entry.key)===entry.promise)this.cropPending.delete(entry.key);}
    }
    clone(value){return Components.utils.cloneInto(value,this.win);}
    unwrap(value){return Components.utils.waiveXrays(value);}
    bind(reading) {
      this.reading = reading;
      reading.citations?.setActive(this.isActive());
      const structure = this.internal._sdt?.structure;
      if (structure) this.updateLinks(structure);
      this.attachSource();
    }
    attachSource() {
      const view = this.internal._primarySDTView || this.internal._primaryView;
      if (!view || this.sourceView === view || this.closed) return;
      this.detachSource(); this.sourceView = view;
      Promise.resolve(view.initializedPromise).then(() => {
        if (this.closed || this.sourceView !== view) return;
        const win = view._iframeWindow, doc = view._iframeDocument || win.document;
        this.sourceWindow = win; this.sourceDocument = doc;
        if (this.reading && this.internal._sdt) this.updateLinks(this.internal._sdt.structure);
        this.sourceNodes=[...doc.querySelectorAll("#sdt-content > [data-ref-path]")];
        this.sourceStyle = doc.createElement("style"); this.sourceStyle.textContent = ".paralleltranslate-source-active{outline:2px solid #729d80;outline-offset:4px;border-radius:2px}"; doc.head.append(this.sourceStyle);
        const listen = (target,type,fn,capture=false,passive=true) => { target.addEventListener(type,fn,{passive,capture}); this.sourceListeners.push(()=>target.removeEventListener(type,fn,capture)); };
        for (const type of ["wheel","pointerdown","keydown"]) listen(doc,type,()=>{this.lastScrollRef=null;if(this.reading)this.reading.scrollOrigin="native";});
        listen(doc,"pointerdown",event=>this.reading?.citations?.outsidePointer(event));
        listen(win,"keydown",event=>this.reading?.citations?.handleKey(event),true,false);
        listen(doc,"click",event=>{
          if (!this.reading || win.getSelection()?.toString()) return;
          const element = event.target.closest?.("[data-ref-path]"), ref = element?.dataset.refPath;
          const id = ref && this.idForRef(ref);
          if (id) this.reading.focusBlock(id,"native");
        });
        listen(win,"scroll",()=>{
          if (!this.reading || this.reading.scrollOrigin !== "native" || this.sourceFrame) return;
          this.sourceFrame = this.win.requestAnimationFrame(()=>{this.sourceFrame=null;this.syncFromSource();});
        },true);
      }).catch(error=>{if(!this.closed)Zotero.logError(error);});
    }
    updateLinks(structure) {
      if(this.linkedElements===this.reading.elements)return;
      this.linkedElements=this.reading.elements;
      const originals=new Map((this.app.jobs.get(this.reading.job.id)?.structure||[]).map(b=>[b.id,b]));
      const sourceElements=this.reading.elements.map(b=>{const source=originals.get(b.sourceIDs?.[0]);return b.edited&&source?{...b,kind:source.kind,source:source.source}:b;});
      this.links=root.ParallelNativeLink.link(sourceElements,structure);
      this.refIDs.clear();
      for(const [id,matches] of this.links)for(const match of matches){
        const existing=this.reading.blocks.get(this.refIDs.get(match.ref));if(existing?.groupID&&existing.groupID===this.reading.blocks.get(id)?.groupID)continue;
        if(!this.refIDs.has(match.ref)||!match.captionFallback)this.refIDs.set(match.ref,id);
      }
    }
    idForRef(ref) {
      while(ref){if(this.refIDs.has(ref))return this.refIDs.get(ref);const at=ref.lastIndexOf(".");ref=at<0?"":ref.slice(0,at);}
    }
    syncFromSource() {
      if (this.closed || !this.reading?.syncEnabled()) return;
      const win=this.sourceWindow, doc=this.sourceDocument;
      if (!doc) return;
      const anchor=root.ParallelNativeLink.nearest(this.sourceNodes||[],0,win.innerHeight);
      const id=anchor&&this.idForRef(anchor.node.dataset.refPath);
      if(id){this.reading.highlight(id);this.reading.center(this.reading.translationPane,this.reading.rows.get(id),anchor.fraction);}
    }
    navigate(block, fraction=.5) {
      if(this.closed)return;
      const matches=this.links.get(block.id)||[],match=matches[Math.min(matches.length-1,Math.floor(fraction*matches.length))];
      const view=this.internal._primarySDTView;
      const node=match && view?._iframeDocument?.querySelector('[data-ref-path="'+match.ref+'"]');
      if (node) {
        const scrolling=this.reading?.scrollOrigin==="translation";
        if(scrolling && this.lastScrollRef===match.ref)return;
        this.lastScrollRef=scrolling?match.ref:null;
        this.highlighted?.classList.remove("paralleltranslate-source-active");this.highlighted=node;node.classList.add("paralleltranslate-source-active");
        view.navigate(this.clone({href:"#sdt-"+match.ref}),this.clone({behavior:"instant",block:"center",skipHistory:this.reading?.scrollOrigin==="translation"}));
      } else {
        const anchor=block.anchors?.[0];
        if(view)view.navigate(this.clone({pageIndex:block.page-1}),this.clone({behavior:"instant"}));
        else this.internal._primaryView.navigate(this.clone(anchor?{position:{pageIndex:anchor.page-1,rects:[anchor.rect]}}:{pageIndex:block.page-1}),this.clone({behavior:"instant"}));
      }
      this.internal._lastViewPrimary=true;
    }
    detachSource() {
      for(const remove of this.sourceListeners)remove();this.sourceListeners=[];
      if(this.sourceFrame)this.win.cancelAnimationFrame(this.sourceFrame);this.sourceFrame=null;
      this.highlighted?.classList.remove("paralleltranslate-source-active");this.highlighted=null;
      this.sourceNodes=[];this.sourceStyle?.remove();this.sourceStyle=null;this.sourceWindow=null;this.sourceDocument=null;
    }
    close(restore=true) {
      this.cropCache?.clear();
      if(this.closed)return this.closePromise;
      this.closed=true;this.observer?.disconnect();this.resizeObserver?.disconnect();this.outerResizeObserver?.disconnect();this.win.removeEventListener("unload",this.unload);
      for(const batch of this.cropBatches?.values()||[]){clearTimeout(batch.timer);for(const entry of batch.entries)entry.reject(Error("阅读器已关闭"));}
      this.cropBatches?.clear();this.cropPending?.clear();
      if(this.positionFrame)this.win.cancelAnimationFrame(this.positionFrame);this.positionFrame=null;this.divider?.close();
      this.tabHost?.removeEventListener("tab-selection-change",this.tabSelected);
      this.detachSource();this.reading?.close();
      this.setPressed(false);
      if(this.app.nativeSessions.get(this.reader)===this)this.app.nativeSessions.delete(this.reader);
      const r=this.internal,tools=this.reading?.tools;
        // Wait for native initialization before destroying its overlay. A replacement session
        // inherits the original baseline and owns restoration; late cleanup cannot close it.
        this.closePromise=Promise.allSettled([this.sourceReady,tools?.closePromise,...(restore?[tools?.pendingComment,...(tools?.annotationOperations?.values()||[])]:[])]).then(()=>{
          this.frame?.remove();this.placeholder?.remove();this.style?.remove();
          if(this.reader._parallelTranslateSession!==this)return;
          this.container?.classList.remove("paralleltranslate-native-container");
          if(restore&&!this.win.closed&&!this.reader._isTabClosed){
            if(this.before.split==="vertical")r.toggleVerticalSplit(true);else if(this.before.split==="horizontal")r.toggleHorizontalSplit(true);else r.disableSplitView();
            r.setSplitViewSize(this.before.size);return r._setReadingMode(true,this.before.reading);
          }
        }).catch(e=>Zotero.logError(e)).finally(()=>{
          if(this.reader._parallelTranslateSession===this)delete this.reader._parallelTranslateSession;
        });
      return this.closePromise;
    }
  }
  function readerWindow(reader){return reader._iframe.ownerDocument.defaultView;}
  root.ParallelNativeSession=NativeSession;
})(this);
