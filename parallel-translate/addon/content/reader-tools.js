(function(root){
  'use strict';
  const D=root.ParallelDocument,M=root.ParallelReaderModel;
  const $=id=>document.getElementById(id),E=(tag,cls,text)=>{const n=document.createElementNS('http://www.w3.org/1999/xhtml',tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const button=(text,action,cls='quiet')=>{const n=E('button',cls,text);n.type='button';n.addEventListener('click',action);return n;};
  const field=(label,input)=>{const n=E('label','reader-field');n.append(E('span','',label),input);return n;};
  const select=options=>{const n=E('select');for(const [value,text] of options){const o=E('option','',text);o.value=value;n.append(o);}return n;};
  const colors=['#ffd400','#ff6666','#5fb236','#2ea8e5','#a28ae5','#e56eee','#f19837','#aaaaaa'];
  const escaped=text=>String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const plain=text=>{const n=E('textarea');n.innerHTML=String(text||'').replace(/<br\s*\/?>/gi,'\n').replace(/<\/p>/gi,'\n').replace(/<[^>]*>/g,'');return n.value.trim();};
  class ReaderTools{
    constructor(reading,message){
      this.reading=reading;this.app=reading.app;this.host=this.app.readerHost;this.native=reading.native;this.message=message;this.mode='target';this.tab='headings';this.epoch=0;this.annotations=[];this.figureQueue=[];this.figureActive=0;
      reading.tools=this;document.body.classList.add('reader-workspace');document.body.dataset.readingMode='target';
      this.sidebar=E('aside','reader-sidebar');this.sidebar.setAttribute('aria-label','目录');
      const top=E('div','reader-sidebar-heading','目录');this.sidebar.append(top);this.sidebarToggle=button('‹',()=>this.toggleSidebar(),'reader-collapse');root.ParallelIcons?.set(this.sidebarToggle,'chevron-left');this.sidebarToggle.setAttribute('aria-label','收起目录');this.sidebarToggle.setAttribute('aria-expanded','true');$('reader').append(this.sidebarToggle);
      const tabs=E('div','reader-tabs');tabs.setAttribute('role','tablist');this.tabButtons={};
      for(const [id,label,icon] of [['headings','标题','list'],['figures','图表','image'],['annotations','注释','comment']]){const b=button(label,()=>this.selectTab(id));root.ParallelIcons?.put(b,icon);b.setAttribute('role','tab');this.tabButtons[id]=b;tabs.append(b);}
      this.sidebar.append(tabs);this.sidebarBody=E('div','reader-sidebar-body');this.sidebar.append(this.sidebarBody);$('reader').prepend(this.sidebar);
      this.modes=E('div','reader-modes');this.modes.setAttribute('aria-label','阅读模式');this.modeButtons={};
      for(const [id,label] of [['source','原文'],['target','译文'],['paired','上下对照']]){const b=button(label,()=>this.setMode(id));this.modeButtons[id]=b;this.modes.append(b);}
      const legacy=$('target-label').parentElement;legacy.hidden=true;
      const bar=document.querySelector('.topbar');$('progress-label').after(this.modes);
      this.pending=E('span','reader-pending');this.pending.hidden=true;this.modes.after(this.pending);
      this.tagRetry=button('重试标签',()=>this.run(async()=>{await this.app.markTranslated(this.base);this.update();}));this.tagRetry.hidden=true;bar.insertBefore(this.tagRetry,$('start'));
      this.retry=button('更新译文',()=>this.run(async()=>{for(const [id,g] of Object.entries(this.record?.state.groups||{}))if(!g.deleted&&g.segments.some(s=>s.status!=='complete'))await this.host.translate(this.base,id);}));this.cancelUpdate=button('取消更新',()=>this.host.cancel(this.record));this.retry.hidden=true;this.cancelUpdate.hidden=true;bar.insertBefore(this.retry,$('start'));bar.insertBefore(this.cancelUpdate,$('start'));
      const sync=$('sync-scroll'),syncLabel=field('同步',sync);syncLabel.classList.add('reader-sync');bar.insertBefore(syncLabel,$('close-native'));
      this.expand=button('⛶',()=>this.native?.setExpanded(!this.native.expanded),'icon-button reader-expand');root.ParallelIcons?.set(this.expand,'minimize');this.expand.setAttribute('aria-label','还原阅读区域');this.expand.title='铺满 / 还原';bar.insertBefore(this.expand,$('close-native'));
      this.thumb=E('div','reader-thumbnail');this.thumbButton=button('',()=>this.original());this.thumbCanvas=E('canvas');this.thumbLabel=E('span','','PDF');this.thumbButton.append(this.thumbCanvas,this.thumbLabel);
      this.thumb.append(this.thumbButton);$('reading-panes').append(this.thumb);
      this.figureObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){this.figureObserver.unobserve(entry.target);this.figureQueue.push(entry.target);}this.paintFigures();},{root:this.sidebarBody,rootMargin:'100px'});
      reading.rowsHost.addEventListener('dblclick',event=>{const source=event.target.closest?.('.source'),row=source?.closest('[data-block-id]');if(!row||event.target.closest('a,button,input,textarea,.katex,.reader-highlight,.pt-citation,[contenteditable]'))return;event.preventDefault();clearTimeout(this.selectionTimer);this.selection=null;this.edit(row.dataset.blockId,undefined,source.dataset.cellIndex===undefined?undefined:Number(source.dataset.cellIndex));});
      reading.rowsHost.addEventListener('mouseup',()=>{clearTimeout(this.selectionTimer);this.selectionTimer=setTimeout(()=>this.captureSelection(),220);});
      reading.translationPane.addEventListener('scroll',()=>{clearTimeout(this.scrollTimer);this.scrollTimer=setTimeout(()=>this.scrolled(),120);},{passive:true});
      reading.rowsHost.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key==='F2')&&!event.isComposing&&!event.target.closest('a,button,input,textarea,.reader-highlight,[contenteditable]')){const row=event.target.closest('[data-block-id]'),cell=event.target.closest('[data-cell-index]');if(row&&this.mode!=='target'){event.preventDefault();this.edit(row.dataset.blockId,undefined,cell?Number(cell.dataset.cellIndex):undefined);}}});
      this.initializeInteractions();
      this.selectTab('headings');this.setMode('target');
    }
    fail(error){if(!this.closed)this.message(error?.safeMessage||error?.message||String(error),true);}
    run(fn){return Promise.resolve().then(fn).catch(error=>this.fail(error));}
    setJob(job){
      if(this.closed)return;
      if(this.base?.id!==job.id){
        this.epoch++;this.base=job;this.record=null;this.outline=null;this.outlineKey=null;this.annotations=[];this.restored=false;this.thumbPage=null;this.loadError=null;this.tableError=null;
        this.annotationSearch='';this.annotationColor=null;
        this.reading.setJob(M.effective(job));this.renderSidebar();
        this.ready=Promise.resolve();
        if(!job.preview){
          const epoch=this.epoch;
          const metadata=Promise.resolve().then(async()=>{
            if(this.closed||epoch!==this.epoch)return false;
            const changed=await this.native?.readerMetadata(job);
            // Geometry may finish after the last translation checkpoint. Persist
            // it through the same coalesced writer so restarts reuse that work.
            if(changed&&!this.closed&&epoch===this.epoch&&!this.app.closed){
              try{await this.app.saveJob(job);}catch(error){
                if(!this.closed&&epoch===this.epoch)this.message('图表缓存暂未保存，下次启动将重新校验。',true);
              }
            }
            return changed;
          }).catch(error=>{
            if(!this.closed&&epoch===this.epoch){this.tableError=error;this.message('部分表格方向暂未能识别，已保留原图。',true);}
            return true;
          });
          this.ready=Promise.all([metadata,this.host.load(job)]).then(([changed,record])=>{
            if(this.closed||epoch!==this.epoch)return;
            this.record=record;if(changed)this.reading.job={...this.reading.job,readerRevision:-1};this.update();
          }).catch(error=>{if(epoch===this.epoch){this.loadError=error;this.fail(error);}});
        }
      }else this.base=job;
      this.update();
    }
    update(){
      if(!this.base||this.closed)return;
      const view=M.effective(this.base,this.record?.state),changed=this.reading.job?.readerRevision!==view.readerRevision;
      if(!this.editor)this.reading.setJob(view);this.pending.hidden=!view.readerPending;this.pending.textContent=this.record&&this.host.running.has(this.record.key)?'正在更新…':'待更新';
      this.retry.hidden=!view.readerPending||!!(this.record&&this.host.running.has(this.record.key));this.cancelUpdate.hidden=!(this.record&&this.host.running.has(this.record.key));
      if(view.readerPending)$('progress-label').textContent='待更新';
      const warning=this.app.tagWarnings?.get(this.base.id);this.tagRetry.hidden=!warning;this.tagRetry.title=warning||'';if(warning&&this.tagWarning!==warning)this.message(warning,true);this.tagWarning=warning;
      if(this.record&&!this.restored){this.restored=true;const p=this.record.state.position;if(p?.id&&this.reading.rows.has(p.id))requestAnimationFrame(()=>{if(!this.closed)this.reading.focusBlock(p.id,'restore',p.fraction||0);});
        const draft=this.app.readerRecoveryDrafts?.get(this.base.id)||this.record.state.editDraft;if(draft&&draft.cellIndex===undefined&&M.editable(this.reading.blocks.get(draft.id))){this.message('已恢复上次未提交的英文校订草稿。',false);this.edit(draft.id,draft.input,draft.cellIndex);}
        else {const noteDraft=this.app.readerRecoveryComments?.get(this.base.id)||this.record.state.annotationDraft;if(noteDraft?.attachmentKey===this.base.document.attachmentKey&&noteDraft.libraryID===this.base.document.libraryID)this.run(async()=>{await this.refreshAnnotations();const note=this.annotations.find(n=>n.key===noteDraft.noteKey);if(note||this.reading.blocks.has(noteDraft.selection?.id))this.annotationDialog({note,selection:noteDraft.selection,draft:noteDraft});});}
      }
      if(changed)this.renderSidebar();
      const outlineKey=this.base.id+':'+(view.readerRevision||0);
      if(this.outlineKey!==outlineKey){this.outlineKey=outlineKey;this.loadOutline();}
      clearTimeout(this.annotationTimer);this.annotationTimer=setTimeout(()=>this.refreshAnnotations(),180);
      this.scrolled(false);
    }
    async loadOutline(){
      const epoch=this.epoch;try{
        const outline=await this.native?.readerOutline();if(this.closed||epoch!==this.epoch)return;
        this.outline=outline?.length?outline:null;if(this.tab==='headings')this.renderSidebar();
      }catch(error){this.fail(error);}
    }
    toggleSidebar(){const hidden=this.sidebar.hidden;this.sidebar.hidden=!hidden;document.body.classList.toggle('sidebar-collapsed',!hidden);if(root.ParallelIcons)root.ParallelIcons.set(this.sidebarToggle,hidden?'chevron-left':'chevron-right');else this.sidebarToggle.textContent=hidden?'‹':'›';this.sidebarToggle.setAttribute('aria-expanded',String(hidden));this.sidebarToggle.setAttribute('aria-label',hidden?'收起目录':'展开目录');}
    setMode(mode,confirmed=false){
      if(mode===this.mode&&this.modeButtons[mode]?.getAttribute('aria-pressed')==='true')return;
      if(!confirmed&&!this.confirmLeave(()=>this.setMode(mode,true)))return;
      const anchor=this.reading.translationAnchor(),navigation=this.reading.navigation;this.mode=mode;document.body.dataset.readingMode=mode;
      for(const [key,b] of Object.entries(this.modeButtons))b.setAttribute('aria-pressed',String(key===mode));
      if(anchor)requestAnimationFrame(()=>{if(!this.closed&&this.reading.navigation===navigation)this.reading.focusBlock(anchor.id,'mode',anchor.fraction);});
    }
    selectTab(tab){this.tab=tab;for(const [key,b] of Object.entries(this.tabButtons))b.setAttribute('aria-selected',String(tab===key));this.renderSidebar();}
    renderSidebar(){
      if(this.closed)return;this.figureObserver?.disconnect();this.figureQueue=[];this.sidebarBody.replaceChildren();
      if(!this.base)return;
      if(this.tab==='headings')this.renderHeadings();else if(this.tab==='figures')this.renderFigures();else this.renderAnnotations();
    }
    resolveHeading(item){
      if(item.blockID)return {id:item.blockID};
      const href=item.location?.href||'',ref=href.startsWith('#sdt-')?href.slice(5):null;
      const id=ref?this.native?.idForRef(ref):null;if(id)return {id};
      const position=item.location?.position||item.location,page=Number.isInteger(position?.pageIndex)?position.pageIndex+1:null;
      return {page};
    }
    renderHeadings(){
      let outline=this.outline;
      if(!outline){outline=this.reading.elements?.filter(b=>b.kind==='heading').map(b=>({title:b.source,blockID:b.id,level:b.level||1}))||[];}
      else if(this.record?.state.order.length||this.reading.elements.some(b=>b.edited&&b.kind==='heading')||Object.values(this.record?.state.groups||{}).some(g=>g.sourceIDs.some(id=>this.base.structure?.find(b=>b.id===id)?.kind==='heading'))){
        const flat=[],seen=new Set(),positions=new Map(this.reading.elements.map((b,i)=>[b.id,i]));
        const collect=(items,level)=>{for(const item of items){const target=this.resolveHeading(item),b=this.reading.blocks.get(target.id);if(!(b?.edited&&b.kind!=='heading')){flat.push({title:b?.edited?b.source:item.title,blockID:target.id,location:item.location,level:b?.edited?b.level||level:level,rank:positions.get(target.id)??this.reading.elements.findIndex(b=>b.page===target.page)});if(target.id)seen.add(target.id);}collect(item.items||item.children||[],level+1);}};collect(outline,1);
        for(const b of this.reading.elements)if(b.edited&&b.kind==='heading'&&!seen.has(b.id))flat.push({title:b.source,blockID:b.id,level:b.level||2,rank:positions.get(b.id)});
        flat.sort((a,b)=>a.rank-b.rank);outline=[];const stack=[];
        for(const item of flat){item.items=[];while(stack.length&&stack.at(-1).level>=item.level)stack.pop();(stack.length?stack.at(-1).items:outline).push(item);stack.push(item);}
      }
      const add=(items,parent,depth)=>{for(const item of items){
        const row=E('div','reader-outline-row');row.style.setProperty('--depth',String(item.level?item.level-1:depth));
        row.dataset.depth=String(item.level?item.level-1:depth);
        const target=this.resolveHeading(item),b=button(item.title||'无标题',()=>{if(target.id)this.reading.focusBlock(target.id,'index');else if(target.page){this.reading.goPage(target.page);this.message('此目录项提供页级位置，已定位到该页正文。',false);}else this.message('此目录项暂未对应到阅读文本。',true);},'reader-index-link');
        if(target.id)b.dataset.indexId=target.id;b.title=item.title||'';
        const children=item.items||item.children||[];
        if(children.length){const group=E('div','reader-outline-children'),toggle=button('▾',()=>{group.hidden=!group.hidden;if(root.ParallelIcons)root.ParallelIcons.set(toggle,group.hidden?'chevron-right':'chevron-down');else toggle.textContent=group.hidden?'▸':'▾';toggle.setAttribute('aria-expanded',String(!group.hidden));},'reader-outline-toggle');root.ParallelIcons?.set(toggle,'chevron-down');toggle.setAttribute('aria-label','展开或折叠 '+item.title);toggle.setAttribute('aria-expanded','true');row.append(toggle,b);parent.append(row,group);add(children,group,depth+1);}
        else{row.append(b);parent.append(row);}
      }};add(outline,this.sidebarBody,0);
      if(!outline.length)this.sidebarBody.append(E('p','reader-empty','未找到可用目录'));
    }
    renderFigures(){
      const list=this.reading.elements?.filter(b=>['image','table'].includes(b.kind)&&!b.tableMergedInto)||[];
      for(const block of list){
        const caption=this.reading.elements.filter(b=>b.assetID===block.id||block.captionIDs?.includes(b.id)).map(b=>b.source).join(' ');
        const card=button('',()=>this.reading.focusBlock(block.id,'index'),'reader-figure-card'),canvas=E('canvas');canvas.dataset.figureId=block.id;canvas.dataset.epoch=String(this.epoch);canvas.setAttribute('aria-label',caption||'图表预览');
        card.append(canvas,E('span','',caption||(block.kind==='table'?'表格':'图片')+' · 第 '+block.page+' 页'));this.sidebarBody.append(card);this.figureObserver.observe(canvas);
      }
      if(!list.length)this.sidebarBody.append(E('p','reader-empty','未找到图表'));
    }
    paintFigures(){
      while(this.figureActive<2&&this.figureQueue.length){
        const canvas=this.figureQueue.shift(),block=this.reading.blocks.get(canvas.dataset.figureId),anchor=(block?.tableCropAnchors||block?.anchors)?.[0];
        if(!anchor||!canvas.isConnected)continue;
        const epoch=this.epoch,session=this.reading.session;
        this.figureActive++;
        session.page(anchor.page).then(async({page})=>{
          if(!canvas.isConnected||epoch!==this.epoch)return;
          const {rotation,paintWidth}=this.reading.assetGeometry(block,anchor,page,220);
          await session.paint(page,anchor.rect,canvas,paintWidth);
          if(!canvas.isConnected||epoch!==this.epoch||this.closed){canvas.width=canvas.height=0;return;}
          const turned=this.reading.rotateCanvas(canvas,rotation);
          if(turned!==canvas){turned.dataset.figureId=block.id;turned.dataset.epoch=String(epoch);canvas.replaceWith(turned);}
        }).catch(()=>canvas.setAttribute('aria-label','预览不可用，点击定位图表')).finally(()=>{this.figureActive--;if(!this.closed)this.paintFigures();});
      }
    }
    scrolled(save=true){
      if(!this.base||this.closed)return;const anchor=this.reading.translationAnchor(),block=anchor&&this.reading.blocks.get(anchor.id);if(!block)return;
      const page=block.anchors?.[Math.min((block.anchors?.length||1)-1,Math.floor(anchor.fraction*(block.anchors?.length||1)))]?.page||block.page;
      this.reading.currentPage=page;this.reading.pageChanged(page);this.updateThumbnail(page);
      const rows=this.reading.elements,at=rows.findIndex(b=>b.id===block.id);let id;
      for(let n=at;n>=0;n--)if(rows[n].kind==='heading'){id=rows[n].id;break;}
      for(const b of this.sidebarBody.querySelectorAll('[data-index-id]'))b.classList.toggle('current',b.dataset.indexId===id);
      if(save&&this.record){clearTimeout(this.positionTimer);this.positionTimer=setTimeout(()=>this.run(()=>this.host.mutate(this.base,state=>{state.position=anchor;return state;})),1200);}
    }
    async updateThumbnail(page){
      if(this.thumbPage===page||!this.reading.session)return;this.thumbPage=page;this.thumbLabel.textContent='第 '+page+' 页';const epoch=this.epoch;
      try{const pdfPage=await this.reading.session.page(page),rect=Array.from(pdfPage.page?.view||pdfPage.view||[]);if(epoch!==this.epoch||this.thumbPage!==page||this.closed)return;
        const canvas=E('canvas');await this.reading.session.paint(pdfPage.page||pdfPage,rect,canvas,125);if(epoch!==this.epoch||this.thumbPage!==page||this.closed)return;this.thumbCanvas.replaceWith(canvas);this.thumbCanvas=canvas;
      }catch(_){this.thumbLabel.textContent='第 '+page+' 页 · 查看原文';}
    }
    original(page=this.thumbPage||1,key){return this.run(async()=>{if(!this.confirmLeave(()=>this.original(page,key)))return;if(this.native)await this.native.showOriginal(page,key);else await this.reading.goPage(page);});}
    annotationMetaKey(key){return this.base.document.libraryID+':'+this.base.document.attachmentKey+':'+key;}
    associations(annotation){
      const meta=this.record?.state.annotations[this.annotationMetaKey(annotation.key)];
      if(meta?.sourceIDs?.length)return this.reading.elements.filter(b=>(b.sourceIDs||[b.id]).some(id=>meta.sourceIDs.includes(id)));
      const page=(annotation.position?.pageIndex??-2)+1,rects=annotation.position?.rects||[];
      // Centre-in-box alone misses annotations whose highlight spans the anchor
      // edge (headers, first/last lines). Fall back to the block whose anchor
      // overlaps the note rect most, so a locatable PDF note still resolves.
      const inside=b=>b.anchors?.some(a=>a.page===page&&rects.some(r=>{const x=(r[0]+r[2])/2,y=(r[1]+r[3])/2;return x>=a.rect[0]&&x<=a.rect[2]&&y>=a.rect[1]&&y<=a.rect[3];}));
      let blocks=this.reading.elements.filter(inside);
      if(blocks.length)return blocks;
      const overlap=(a,r)=>{const w=Math.max(0,Math.min(a.rect[2],r[2])-Math.max(a.rect[0],r[0])),h=Math.max(0,Math.min(a.rect[3],r[3])-Math.max(a.rect[1],r[1]));return w*h;};
      let best=null,bestArea=0;
      for(const b of this.reading.elements){let area=0;for(const a of b.anchors||[])if(a.page===page)for(const r of rects)area+=overlap(a,r);if(area>bestArea){bestArea=area;best=b;}}
      return best?[best]:[];
    }
  }
  root.ParallelReaderTools=ReaderTools;
})(this);
