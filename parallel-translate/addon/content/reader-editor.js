/* A single block is corrected in place; PDF bytes and existing annotations stay native. */
(function(root){
  'use strict';
  const M=root.ParallelReaderModel,S=root.ParallelReaderSelection,{E,button}=root.ParallelReaderDOM;
  const select=options=>{const n=E('select');for(const [value,label] of options){const o=E('option','',label);o.value=value;n.append(o);}return n;};
  const iconed=(node,name)=>{root.ParallelIcons?.put(node,name);return node;};
  const label=(text,input)=>{const n=E('label','reader-field');n.append(E('span','',text),input);return n;};
  Object.assign(root.ParallelReaderTools.prototype,{
    edit(id,draft,cellIndex){
      const block=this.reading.blocks.get(id);
      if(cellIndex!==undefined||!M.editable(block))return;
      if(!this.record){this.fail(this.loadError||Error('校订数据尚未加载'));return;}
      if(this.base.status==='running'||this.base.preview||this.host.running.has(this.record.key)){this.message('请先暂停翻译，再校订英文',true);return;}
      if(this.editor){if(this.editor.id===id&&this.editor.cellIndex===cellIndex)return;this.confirmLeave(()=>this.edit(id,draft,cellIndex));return;}
      if(this.mode==='target')this.setMode('source',true);this.closeSelectionPopup();this.noteDialog?.close();window.getSelection()?.removeAllRanges();
      const row=this.reading.rows.get(id),source=row.querySelector('.source');if(!source)return;
      const initial=root.ParallelMath.withInline(block.source,block.inlineMath);
      const panel=E('section','reader-inline-editor');panel.setAttribute('aria-label','英文校订');source.hidden=true;source.after(panel);row.classList.add('reader-editing');
      const text=E('textarea');text.value=initial;text.maxLength=60000;text.setAttribute('aria-label','英文阅读文本');text.spellcheck=false;panel.append(text);
      const kind=select([['paragraph','正文'],['heading','标题'],['caption','题注'],['note','脚注'],['listitem','列表'],['preformatted','等宽']]);kind.value=draft?.kind||block.kind;
      const level=select([1,2,3,4,5,6].map(n=>[String(n),'H'+n]));level.value=String(draft?.level||block.level||2);
      const align=select([['left','左对齐'],['justify','两端对齐'],['center','居中']]),spacing=select([0,8,16,24].map(n=>[String(n),n+' px'])),bold=E('input'),italic=E('input');bold.type=italic.type='checkbox';
      const fmt=M.format(draft?.format||block.readerFormat);align.value=fmt.align;spacing.value=String(fmt.spacing);bold.checked=fmt.bold;italic.checked=fmt.italic;
      const format=E('div','reader-editor-format');for(const [title,input] of [['类型',kind],['级别',level],['对齐',align],['段距',spacing],['粗体',bold],['斜体',italic]])format.append(label(title,input));panel.append(format);level.parentElement.hidden=kind.value!=='heading';
      const feedback=E('p','reader-popup-feedback');feedback.hidden=true;feedback.setAttribute('role','status');const actions=E('div','reader-dialog-actions');
      const editor=this.editor={id,cellIndex,groupID:block.groupID||id,panel,text,source,dirty:!!draft,protected:[],lastText:initial,initial};
      // Keep exact source intervals for annotations; formatting never changes these anchors.
      for(const note of this.annotations)for(const [rangeIndex,r] of (note.ranges||[]).entries())if(r.id===id&&(r.cellIndex===undefined?cellIndex===undefined:r.cellIndex===cellIndex)){
        const found=S.locate(r.sourceText,r.from,r.to,initial);if(found.status==='matched')editor.protected.push({from:found.from,to:found.to,noteKey:note.key,rangeIndex});
      }
      for(const re of [/\\\([\s\S]*?\\\)/g,/\$\$[\s\S]*?\$\$/g,/\[[0-9][0-9,\s–-]*\]/g,/https?:\/\/[^\s<>]+/g])for(const match of initial.matchAll(re))editor.protected.push({from:match.index,to:match.index+match[0].length});
      const values=()=>({text:text.value,kind:kind.value||block.kind,level:Number(level.value),format:{bold:bold.checked,italic:italic.checked,align:align.value,spacing:Number(spacing.value),indent:fmt.indent},singleBlock:true,...(cellIndex!==undefined?{cellIndex}:{})});editor.values=values;
      const resize=()=>{text.style.height='auto';text.style.height=Math.max(72,text.scrollHeight+2)+'px';};
      const detach=()=>{root.ParallelSelects?.release(panel);panel.remove();source.hidden=false;row.classList.remove('reader-editing');if(this.editor===editor)this.editor=null;clearTimeout(this.draftTimer);};
      editor.discard=async()=>{await this.host.mutate(this.base,state=>{delete state.editDraft;return state;});this.app.readerRecoveryDrafts?.delete(this.base.id);detach();this.update();};
      const annotations=M.copy(this.annotations);editor.annotations=annotations;editor.sourceIDs=block.sourceIDs||[id];
      editor.commit=(state,input,protectedRanges)=>M.commitEdit(this.base,state,id,input,{cellIndex,annotations,sourceIDs:editor.sourceIDs,protectedRanges});
      editor.save=async(closing=false)=>{
        if(editor.saving)return editor.saving;const task=(async()=>{
          save.disabled=true;feedback.hidden=true;clearTimeout(this.draftTimer);
          try{
            if(!editor.dirty){detach();return true;}
            const input=values(),trimmed=input.text.trim(),protectedRanges=S.editRanges(editor.lastText,trimmed,editor.protected);
            if(!protectedRanges)throw Error('公式、引用和已有注释文字不能修改');input.text=trimmed;
            await this.host.mutate(this.base,state=>{
              return editor.commit(state,input,protectedRanges);
            });
            this.app.readerRecoveryDrafts?.delete(this.base.id);detach();if(!closing){this.update();if(trimmed!==initial)this.offerRetranslation(editor.groupID,id);}return true;
          }catch(error){feedback.hidden=false;feedback.textContent=error.message||String(error);this.fail(error);return false;}finally{editor.saving=null;save.disabled=false;}
        })();editor.saving=task;return task;
      };
      const save=button('保存',()=>editor.save(),'primary');actions.append(button('取消',()=>this.run(editor.discard)),save);
      if(block.edited)actions.prepend(iconed(button('恢复',()=>this.run(async()=>{
        const originals=M.sourceBlocks(this.base,block),ids=new Set(originals.map(b=>b.id));
        for(const note of this.annotations)for(const r of note.ranges||[])if(r.sourceIDs?.some(id=>ids.has(id))){
          const targets=originals.map(b=>r.cellIndex===undefined?root.ParallelMath.withInline(b.source,b.inlineMath):b.tableCells?.[r.cellIndex]?.source).filter(Boolean);
          if(!targets.some(value=>S.locate(r.sourceText,r.from,r.to,value).status==='matched'))throw Error('请先处理校订文字上的注释');
        }
        await this.host.mutate(this.base,state=>{delete state.editDraft;return M.restore(this.base,state,id);});this.app.readerRecoveryDrafts?.delete(this.base.id);detach();this.update();})),'undo'));
      if(cellIndex===undefined&&['paragraph','heading','caption','note','listitem','preformatted'].includes(block.kind)){
        const remove=iconed(button('删除',()=>this.run(async()=>{if(editor.protected.some(r=>r.noteKey))throw Error('请先移除此块上的注释');await this.host.mutate(this.base,state=>{const next=M.edit(this.base,state,id,{text:initial,kind:block.kind,level:block.level,format:block.readerFormat,singleBlock:true});next.groups[editor.groupID].deleted=true;delete next.editDraft;return next;});detach();this.update();})),'trash');actions.prepend(remove);
      }
      panel.append(feedback,actions);
      const changed=()=>{
        const next=S.editRanges(editor.lastText,text.value,editor.protected);
        if(!next){text.value=editor.lastText;feedback.textContent='公式、引用和已有注释文字已保护';feedback.hidden=false;resize();return;}
        editor.protected=next;editor.lastText=text.value;editor.dirty=true;level.closest('.reader-field').hidden=kind.value!=='heading'||cellIndex!==undefined;resize();clearTimeout(this.draftTimer);
        this.draftTimer=setTimeout(()=>this.run(()=>this.host.mutate(this.base,state=>{state.editDraft={id,input:values(),cellIndex};return state;})),250);
      };
      for(const input of [text,kind,level,align,spacing,bold,italic])input.addEventListener('input',changed);
      panel.addEventListener('keydown',event=>{if(event.isComposing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.run(editor.discard);}else if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();this.run(()=>editor.save());}});
      panel.addEventListener('click',event=>event.stopPropagation());text.addEventListener('compositionstart',()=>editor.composing=true);text.addEventListener('compositionend',()=>editor.composing=false);
      root.ParallelSelects?.enhanceAll(panel);if(draft){text.value=draft.text??initial;changed();}resize();text.focus();
    },
    offerRetranslation(groupID,id){
      const row=this.reading.rows.get(id);if(!row||row.querySelector('.reader-retranslate'))return;
      const bar=E('div','reader-retranslate'),update=button('重译此处',()=>this.run(async()=>{update.disabled=true;try{await this.host.translate(this.base,groupID);bar.remove();}finally{update.disabled=false;}}));bar.append(E('span','','待更新'),update,button('稍后',()=>bar.remove()));row.append(bar);
    },
    confirmLeave(action){
      if(this.noteDialog?.dirty()){if(action)this.run(async()=>{if(await this.noteDialog?.save()===false&&this.noteDialog)this.message('评论尚未保存，请先处理未保存的评论。',true);if(!this.noteDialog)action();});return false;}if(!this.editor)return true;const editor=this.editor;
      if(!editor.dirty){editor.discard().then(()=>action?.()).catch(e=>this.fail(e));return false;}
      if(action)this.run(async()=>{if(await editor.save())action();else this.message('校订尚未保存，请先处理未保存的修改。',true);});return false;
    },
    close(){
      if(this.closed)return this.closePromise;const editor=this.editor,popup=this.noteDialog;
      const snapshot={position:this.reading.translationAnchor(),editor:editor?.dirty?{id:editor.id,input:editor.values(),cellIndex:editor.cellIndex,lastText:editor.lastText,protectedRanges:M.copy(editor.protected),annotations:editor.annotations,sourceIDs:editor.sourceIDs}:null,comment:popup?.dirty()?popup.snapshot():null};
      this.closed=true;this.epoch++;if(editor)root.ParallelSelects?.release(editor.panel);this.figureObserver.disconnect();this.highlightObserver.disconnect();for(const key of ['selectionTimer','scrollTimer','annotationTimer','positionTimer','draftTimer','highlightTimer'])clearTimeout(this[key]);
      document.removeEventListener('pointerdown',this.outsidePopup);document.removeEventListener('keydown',this.popupKeys);document.removeEventListener('selectionchange',this.selectionChange);window.removeEventListener('resize',this.repositionPopups);this.closeSelectionPopup();
      this.closePromise=this.record?this.host.persistClose(this.base,snapshot):Promise.resolve();
      if(popup?.dirty())this.pendingComment=popup.save();this.host.cancel(this.record);return this.closePromise;
    }
  });
})(this);
