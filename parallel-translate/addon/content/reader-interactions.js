(function(root){
  'use strict';
  const S=root.ParallelReaderSelection,M=root.ParallelReaderModel;
  const E=(tag,cls,text)=>{const n=document.createElementNS('http://www.w3.org/1999/xhtml',tag);n.className=cls||'';if(text!==undefined)n.textContent=text;return n;};
  const ICONS={'▤':'comment','↗':'external','×':'trash'};
  const button=(text,fn,cls='quiet',title)=>{const n=E('button',cls,text);n.type='button';if(title){n.title=title;n.setAttribute('aria-label',title);}if(ICONS[text]&&root.ParallelIcons)root.ParallelIcons.set(n,ICONS[text]);n.addEventListener('click',fn);return n;};
  const colors=['#ffd400','#ff6666','#5fb236','#2ea8e5','#a28ae5','#e56eee','#f19837','#aaaaaa'];
  const plain=html=>{const n=E('textarea');n.innerHTML=String(html||'').replace(/<br\s*\/?>/gi,'\n').replace(/<\/p>/gi,'\n').replace(/<[^>]*>/g,'');return n.value.trim();};
  const escaped=text=>String(text||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  function textNodes(node){const list=[],walk=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let n;while((n=walk.nextNode()))if(!n.parentElement.closest('[data-reader-layout],.katex,button,script,style'))list.push(n);return list;}
  const textOf=node=>textNodes(node).map(n=>n.data).join('');
  function wrap(node,from,to,note,open){
    let at=0;const pieces=[];for(const n of textNodes(node)){const a=Math.max(0,from-at),b=Math.min(n.length,to-at);if(b>a)pieces.push({n,a,b});at+=n.length;}
    for(const {n,a,b} of pieces.reverse()){
      const range=document.createRange();range.setStart(n,a);range.setEnd(n,b);const mark=E('mark','reader-highlight');mark.dataset.annotationKey=note.key;mark.style.setProperty('--annotation-color',M.color(note.color));mark.tabIndex=0;
      if(note.type==='underline')mark.classList.add('reader-underline');if(note.local)mark.classList.add('reader-local-highlight');
      mark.title=plain(note.comment)||'注释';mark.setAttribute('aria-label',mark.title);mark.append(range.extractContents());range.insertNode(mark);
      mark.addEventListener('click',e=>{e.stopPropagation();if(!window.getSelection()?.isCollapsed)return;open(mark.getBoundingClientRect());});
      mark.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();open(mark.getBoundingClientRect());}});
    }
  }
  Object.assign(root.ParallelReaderTools.prototype,{
    initializeInteractions(){
      this.rangeCache=new Map();this.annotationOperations=new Map();
      this.highlightObserver=new MutationObserver(()=>{clearTimeout(this.highlightTimer);this.highlightTimer=setTimeout(()=>this.markAnnotations(),50);});
      this.observeHighlights();
      this.outsidePopup=event=>{
        if(this.noteDialog&&!this.noteDialog.contains(event.target)){const p=this.noteDialog;if(p.dirty())this.run(()=>p.save());else p.close();}
        if(this.selectionPopup&&!this.selectionPopup.contains(event.target))this.closeSelectionPopup();
      };
      this.popupKeys=event=>{if(event.key==='Escape'){if(this.noteDialog){event.preventDefault();this.noteDialog.close();}else this.closeSelectionPopup();}};
      this.repositionPopups=()=>{const selection=window.getSelection(),rect=selection?.rangeCount&&!selection.isCollapsed?selection.getRangeAt(0).getBoundingClientRect():this.selectionRect;if(this.selectionPopup)this.placePopup(this.selectionPopup,rect);if(this.noteDialog){const mark=[...this.reading.rowsHost.querySelectorAll('.reader-highlight')].find(n=>n.dataset.annotationKey===this.noteDialog.anchorKey);this.placePopup(this.noteDialog,mark?.getBoundingClientRect()||rect);}};
      document.addEventListener('pointerdown',this.outsidePopup);document.addEventListener('keydown',this.popupKeys);
      // The mouseup handler on rowsHost alone misses selections released over
      // row padding, figure boxes or the gutter; selectionchange fires for mouse,
      // keyboard and touch until the user pauses, then the debounce captures.
      this.selectionChange=()=>{if(this.editor||this.closed)return;const s=window.getSelection();if(!s||s.isCollapsed){clearTimeout(this.selectionTimer);return;}clearTimeout(this.selectionTimer);this.selectionTimer=setTimeout(()=>this.captureSelection(),200);};
      document.addEventListener('selectionchange',this.selectionChange);
      window.addEventListener('resize',this.repositionPopups);
    },
    observeHighlights(){if(!this.closed)this.highlightObserver?.observe(this.reading.rowsHost,{childList:true,subtree:true});},
    expandedChanged(){if(this.expand){root.ParallelIcons?.set(this.expand,this.native?.expanded?'minimize':'maximize');this.expand.setAttribute('aria-label',this.native?.expanded?'还原阅读区域':'铺满阅读标签页');this.expand.setAttribute('aria-pressed',String(!!this.native?.expanded));}},
    closeSelectionPopup(){this.selectionPopup?.remove();this.selectionPopup=null;},
    placePopup(popup,rect){
      const r=rect||this.selectionRect||{left:innerWidth/2,top:innerHeight/3,bottom:innerHeight/3},box=popup.getBoundingClientRect();
      popup.style.left=Math.max(8,Math.min(innerWidth-box.width-8,r.left))+'px';
      const above=r.top-box.height-10;popup.style.top=Math.max(8,Math.min(innerHeight-box.height-8,above>=8?above:r.bottom+10))+'px';
    },
    captureSelection(){
      if(this.editor||this.closed)return;const selection=window.getSelection();if(!selection?.rangeCount||selection.isCollapsed)return;
      if(this.mode==='target'){
        const now=Date.now();
        if(now-(this.targetHintAt||0)>8000){this.targetHintAt=now;this.message('高亮和评论只能在“原文”或“上下对照”模式下选择英文。',true);}
        this.closeSelectionPopup();return;
      }
      const range=selection.getRangeAt(0),ranges=[];
      for(const source of this.reading.rowsHost.querySelectorAll('.source')){
        if(!range.intersectsNode(source)||source.closest('.reader-deleted'))continue;
        const nodes=textNodes(source),display=nodes.map(n=>n.data).join('');let at=0,from=null,to=null;
        for(const n of nodes){if(range.intersectsNode(n)){const a=n===range.startContainer?range.startOffset:0,b=n===range.endContainer?range.endOffset:n.length;if(b>a){if(from===null)from=at+a;to=at+b;}}at+=n.length;}
        if(from===null||!display.slice(from,to).trim())continue;
        const id=source.closest('[data-block-id]').dataset.blockId,block=this.reading.blocks.get(id);
        const sourceText=source.dataset.readerText||root.ParallelMath.withInline(block.source,block.inlineMath),found=S.locate(display,from,to,sourceText);
        if(found.status!=='matched')continue;
        if(block.keywordParts){for(const part of block.keywordParts){const a=Math.max(found.from,part.from),b=Math.min(found.to,part.to);if(b>a)ranges.push({id,sourceIDs:[part.id],sourceText:part.source,from:a-part.from,to:b-part.from,text:part.source.slice(a-part.from,b-part.from)});}}
        else ranges.push({id,sourceIDs:block.sourceIDs||[id],sourceText,from:found.from,to:found.to,text:found.text,...(source.dataset.cellIndex!==undefined?{cellIndex:Number(source.dataset.cellIndex)}:{})});
      }
      if(!ranges.length){this.closeSelectionPopup();return;}
      this.selection={id:ranges[0].id,side:'source',text:ranges.map(r=>r.text).join('\n'),ranges};this.selectionRect=range.getBoundingClientRect();this.selectionToolbar();
    },
    selectionToolbar(){
      this.closeSelectionPopup();const popup=this.selectionPopup=E('div','reader-selection-toolbar');popup.setAttribute('role','toolbar');popup.setAttribute('aria-label','选区注释');
      popup.addEventListener('pointerdown',e=>e.preventDefault());
      for(const color of colors){const b=button('',()=>{const selection=this.selection;this.lastColor=color;this.closeSelectionPopup();this.run(()=>this.createAnnotation(selection,'',color));},'reader-swatch','高亮 '+color);b.style.background=color;popup.append(b);}
      popup.append(E('span','reader-popup-divider'),button('▤',()=>this.annotationDialog({selection:this.selection,rect:this.selectionRect}),'icon-button','添加评论'),button('↗',()=>{const b=this.reading.blocks.get(this.selection.id);this.closeSelectionPopup();this.original(b?.page||1);},'icon-button','查看原文'));
      document.body.append(popup);this.placePopup(popup,this.selectionRect);
    },
    async createAnnotation(selection,comment,color){
      if(!this.record||selection?.side!=='source'||!selection.ranges?.length)throw Error('选区尚未就绪');
      const id='local-'+(root.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));
      const note={key:id,local:true,type:'highlight',selection:M.copy(selection),ranges:M.copy(selection.ranges),text:selection.text,comment:escaped(comment),color:M.color(color),status:'pending',created:Date.now()};
      await this.host.mutate(this.base,state=>{(state.localAnnotations||={})[id]=note;return state;});
      window.getSelection()?.removeAllRanges();await this.refreshAnnotations();await this.syncLocalAnnotation(id);return id;
    },
    async syncLocalAnnotation(id){
      if(this.annotationOperations.has(id))return this.annotationOperations.get(id);
      const operation=(async()=>{
        const note=this.record.state.localAnnotations?.[id];if(!note)return;
        try{
          const block=this.reading.blocks.get(note.selection.id)||this.reading.elements.find(b=>note.ranges.some(r=>(b.sourceIDs||[b.id]).some(x=>r.sourceIDs.includes(x))));
          const entries=await this.native.readerAnnotationCreate(this.base,block,note.selection,note.comment,note.color,note.prepared,entries=>this.host.mutate(this.base,state=>{const current=state.localAnnotations?.[id];if(!current)throw Error('本地注释已移除');current.prepared=entries;return state;}));
          await this.host.mutate(this.base,state=>{for(const entry of entries)state.annotations[this.annotationMetaKey(entry.key)]={sourceIDs:entry.sourceIDs,quote:note.text,side:'source',granularity:'selection',ranges:entry.ranges,position:entry.position,groupKey:id};delete state.localAnnotations[id];return state;});
        }catch(error){await this.host.mutate(this.base,state=>{const current=state.localAnnotations?.[id];if(current){current.status='failed';current.error=error.message||String(error);}return state;});this.message('已保存本地，PDF 未同步：'+(error.message||String(error)),true);}
        await this.refreshAnnotations();
      })();this.annotationOperations.set(id,operation);try{return await operation;}finally{this.annotationOperations.delete(id);}
    },
    async refreshAnnotations(){
      if(!this.native||!this.base||this.base.preview||this.closed)return;
      // A refresh requested while one is in flight must still run once the
      // current pass finishes; otherwise a native annotation created during
      // `readerAnnotations()` would never be highlighted until the next trigger.
      if(this.refreshingAnnotations){this.annotationsPending=true;return;}
      this.refreshingAnnotations=true;const epoch=this.epoch;
      try{
        const native=await this.native.readerAnnotations();if(this.closed||epoch!==this.epoch)return;
        const locals=Object.values(this.record?.state.localAnnotations||{}),prepared=new Set(locals.flatMap(n=>n.prepared||[]).map(n=>n.key)),notes=[],groups=new Map();
        for(const n of native){
          if(prepared.has(n.key))continue;
          let meta=this.record?.state.annotations[this.annotationMetaKey(n.key)];const group=meta?.groupKey;
          if(meta?.position&&JSON.stringify(meta.position)!==JSON.stringify(n.position)){
            const page=(n.position?.pageIndex??-2)+1,rects=n.position?.rects||[],blocks=this.reading.elements.filter(b=>b.anchors?.some(a=>a.page===page&&rects.some(r=>{const x=(r[0]+r[2])/2,y=(r[1]+r[3])/2;return x>=a.rect[0]&&x<=a.rect[2]&&y>=a.rect[1]&&y<=a.rect[3];})));
            const ranges=await this.native.readerAnnotationRanges(this.base,n,blocks);meta={...meta,ranges,position:n.position,sourceIDs:[...new Set(ranges.flatMap(r=>r.sourceIDs))]};
            await this.host.mutate(this.base,state=>{state.annotations[this.annotationMetaKey(n.key)]=meta;return state;});
          }
          if(group&&groups.has(group)){const item=groups.get(group);item.members.push(n);item.ranges.push(...(meta?.ranges||[]).map(r=>({...r,color:n.color,nativeKey:n.key})));if(n.comment&&!item.members.slice(0,-1).some(m=>m.comment===n.comment))item.comment=[item.comment,n.comment].filter(Boolean).join('<br>');continue;}
          const note={...n,members:[n],groupKey:group,ranges:(meta?.ranges||[]).map(r=>({...r,color:n.color,nativeKey:n.key}))};if(group&&meta.quote)note.text=meta.quote;
          if(!note.ranges.length&&['highlight','underline'].includes(n.type)){
            const key=JSON.stringify([n.key,n.position,n.text,this.reading.job?.readerRevision]);
            if(!this.rangeCache.has(key))this.rangeCache.set(key,await this.native.readerAnnotationRanges(this.base,n,this.associations(n)));
            note.ranges=this.rangeCache.get(key)||[];
          }
          if(group)groups.set(group,note);notes.push(note);
        }
        for(const n of notes)if(n.groupKey)n.text=n.members.map(m=>m.text).filter(Boolean).join(' ');
        for(const n of locals)notes.push({...n,members:[],pageLabel:String(this.reading.blocks.get(n.selection.id)?.page||1),position:{pageIndex:(this.reading.blocks.get(n.selection.id)?.page||1)-1}});
        const signature=JSON.stringify(notes);this.annotations=notes;if(signature!==this.annotationSignature){this.annotationSignature=signature;if(this.tab==='annotations')this.renderSidebar();}this.markAnnotations();
      }catch(error){this.fail(error);}finally{
        this.refreshingAnnotations=false;
        if(this.annotationsPending){this.annotationsPending=false;this.refreshAnnotations();}
      }
    },
    markAnnotations(){
      if(this.closed||this.editor)return;this.highlightObserver?.disconnect();
      try{
        for(const n of this.reading.rowsHost.querySelectorAll('.reader-highlight'))n.replaceWith(...n.childNodes);
        for(const source of this.reading.rowsHost.querySelectorAll('.source'))source.normalize();
        for(const note of this.annotations)for(const range of note.ranges||[]){
          const blocks=this.reading.elements.filter(b=>b.id===range.id||(b.sourceIDs||[b.id]).some(id=>range.sourceIDs?.includes(id)));
          for(const block of blocks){
            const row=this.reading.rows.get(block.id);if(!row||row.classList.contains('reader-deleted'))continue;
            const sources=range.cellIndex===undefined?row.querySelectorAll('.source'):row.querySelectorAll('.source[data-cell-index="'+range.cellIndex+'"]');
            for(const source of sources){const display=textOf(source),found=S.locate(range.sourceText,range.from,range.to,display);if(found.status==='matched')wrap(source,found.from,found.to,{...note,color:range.color||note.color},rect=>this.annotationDialog({note,rect}));}
          }
        }
      }finally{this.observeHighlights();}
    },
    renderAnnotations(){
      const controls=E('div','reader-note-controls'),search=E('input');search.type='search';search.placeholder='搜索引文或评论';search.value=this.annotationSearch||'';search.setAttribute('aria-label','搜索引文或评论');controls.append(search,E('span','reader-note-count',String(this.annotations.length)));
      const swatches=E('div','reader-note-colors');for(const color of colors){const b=button('',()=>{this.annotationColor=this.annotationColor===color?null:color;this.renderAnnotationsList();},'reader-swatch','筛选 '+color);b.style.background=color;swatches.append(b);}
      this.sidebarBody.append(controls,swatches);this.noteList=E('div','reader-note-list');this.sidebarBody.append(this.noteList);search.addEventListener('input',()=>{this.annotationSearch=search.value;this.renderAnnotationsList();});this.renderAnnotationsList();
    },
    renderAnnotationsList(){
      if(!this.noteList?.isConnected)return;this.noteList.replaceChildren();const query=(this.annotationSearch||'').toLocaleLowerCase();
      for(const note of this.annotations.filter(n=>(!this.annotationColor||n.color===this.annotationColor)&&((n.text||'')+' '+plain(n.comment)).toLocaleLowerCase().includes(query)).sort((a,b)=>String(a.sortIndex||'').localeCompare(String(b.sortIndex||'')))){
        const card=E('div','reader-note-card'),top=E('div','reader-note-meta'),dot=E('i','reader-note-dot');dot.style.background=M.color(note.color);top.append(dot,E('span','','第 '+(note.pageLabel||note.position.pageIndex+1)+' 页'));
        top.append(button('▤',()=>this.annotationDialog({note}),'icon-button','编辑评论'),button('↗',()=>this.original((note.position.pageIndex||0)+1,note.local?undefined:note.key),'icon-button','查看原文'));
        if(!note.readOnly)top.append(button('×',()=>this.run(()=>this.removeAnnotation(note)),'icon-button','删除注释'));card.append(top);
        card.append(button(note.text||'区域注释',()=>this.run(()=>this.locateAnnotation(note)),'reader-note-quote'));
        if(note.comment)card.append(E('p','reader-note-comment',plain(note.comment)));
        if(note.local){const status=E('div','reader-note-sync');status.append(E('span','','未同步'),button('重试',()=>this.run(()=>this.syncLocalAnnotation(note.key))));status.title=note.error||'等待 PDF 定位';card.append(status);}
        this.noteList.append(card);
      }
    },
    async locateAnnotation(note){
      const id=note.ranges?.[0]?.id||this.associations(note)[0]?.id;if(!id)return this.original(note.position.pageIndex+1,note.local?undefined:note.key);
      if(this.mode==='target')this.setMode('source');await this.reading.focusBlock(id,'annotation');
      const mark=[...this.reading.rowsHost.querySelectorAll('.reader-highlight')].find(n=>n.dataset.annotationKey===note.key);mark?.scrollIntoView({block:'center',behavior:'instant'});
    },
    async removeAnnotation(note){
      if(this.annotationOperations.has(note.key))return;
      for(const n of note.local?note.prepared||[]:note.members||[note])await this.native.readerAnnotationUpdate(n.key,{remove:true});
      await this.host.mutate(this.base,state=>{if(note.local)delete state.localAnnotations?.[note.key];for(const n of note.members||[note])delete state.annotations[this.annotationMetaKey(n.key)];return state;});this.noteDialog?.close();await this.refreshAnnotations();
    },
    async updateAnnotation(note,patch){
      if(note.local)await this.host.mutate(this.base,state=>{Object.assign(state.localAnnotations[note.key],patch);return state;});
      else for(const [i,n] of (note.members||[note]).entries())await this.native.readerAnnotationUpdate(n.key,{...patch,...(patch.comment!==undefined?{comment:i===0?patch.comment:''}:{})});
      await this.refreshAnnotations();
    },
    annotationDialog({selection,note,rect,draft}){
      if(this.noteDialog?.savePromise){const pending=this.noteDialog;this.run(async()=>{if(await pending.savePromise)this.annotationDialog({selection,note,rect,draft});});return;}
      this.closeSelectionPopup();this.noteDialog?.close();if(!note&&selection?.side!=='source')return;
      const panel=this.noteDialog=E('section','reader-comment-popup');panel.setAttribute('role','dialog');panel.setAttribute('aria-label','注释评论');let color=draft?.color||note?.color||this.lastColor||'#ffd400',saving=false;
      panel.anchorKey=note?.key;
      const draftID=draft?.id||('comment-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));
      const colorButton=button('',()=>{palette.hidden=!palette.hidden;},'reader-swatch','注释颜色');colorButton.style.background=color;
      const palette=E('div','reader-comment-colors');palette.hidden=true;for(const c of colors){const b=button('',()=>{color=c;colorButton.style.background=c;palette.hidden=true;},'reader-swatch','颜色 '+c);b.style.background=c;palette.append(b);}
      const quote=E('blockquote','reader-comment-quote',note?.text||selection.text),text=E('textarea');text.value=draft?.comment??plain(note?.comment);text.placeholder='添加评论…';text.setAttribute('aria-label','评论');text.rows=3;text.maxLength=16000;
      const feedback=E('p','reader-popup-feedback');feedback.setAttribute('role','status');feedback.hidden=true;
      const original=plain(note?.comment),originalColor=note?.color||color;panel.dirty=()=>!!draft||text.value!==original||color!==originalColor;
      panel.snapshot=()=>({id:draftID,attachmentKey:this.base.document.attachmentKey,libraryID:this.base.document.libraryID,noteKey:note?.key,selection:selection?M.copy(selection):undefined,comment:text.value,color});
      const clearDraft=async()=>{await this.host.mutate(this.base,state=>{if(state.annotationDraft?.id===draftID)delete state.annotationDraft;return state;});this.app.readerRecoveryComments?.delete(this.base.id);};
      panel.close=(saved=false)=>{if(saving)return;if(!saved&&this.record?.state.annotationDraft?.id===draftID)this.run(clearDraft);panel.remove();if(this.noteDialog===panel)this.noteDialog=null;};
      panel.save=()=>{
        if(panel.savePromise)return panel.savePromise;if(note?.readOnly)return Promise.resolve(false);saving=true;save.disabled=true;text.disabled=true;
        const comment=text.value,chosenColor=color;
        panel.savePromise=(async()=>{try{
          await this.host.mutate(this.base,state=>{state.annotationDraft={id:draftID,attachmentKey:this.base.document.attachmentKey,libraryID:this.base.document.libraryID,noteKey:note?.key,selection:selection?M.copy(selection):undefined,comment,color:chosenColor};return state;});
          if(note)await this.updateAnnotation(note,{comment:escaped(comment),color:chosenColor});else await this.createAnnotation(selection,comment,chosenColor);
          await clearDraft();saving=false;panel.close(true);return true;
        }catch(error){feedback.hidden=false;feedback.textContent=error.message||String(error);return false;}finally{saving=false;save.disabled=false;text.disabled=false;panel.savePromise=null;}})();return panel.savePromise;
      };
      const actions=E('div','reader-dialog-actions'),save=button('保存',()=>this.run(panel.save),'primary');actions.append(button('取消',()=>panel.close()),save);panel.append(colorButton,palette,quote,text,feedback,actions);
      if(note?.readOnly){save.hidden=true;colorButton.disabled=true;text.readOnly=true;}
      text.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&!e.isComposing){e.preventDefault();this.run(panel.save);}});
      document.body.append(panel);this.placePopup(panel,rect);text.focus();
    }
  });
  root.ParallelReaderDOM={textNodes,textOf,E,button,plain};
})(this);
