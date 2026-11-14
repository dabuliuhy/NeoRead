/* Host-owned, serial, atomic reader sidecars and explicit local retranslation. */
(function(root){
  'use strict';
  const C=root.ParallelCore,M=root.ParallelReaderModel,D=root.ParallelDocument;
  class ReaderHost{
    constructor(app){this.app=app;this.records=new Map();this.loading=new Map();this.queues=new Map();this.running=new Map();this.operations=new Set();this.closed=false;}
    async load(job){
      const signature=await C.digest(JSON.stringify([job.settings.language,job.settings.instructions,D.elements(job).map(b=>[b.id,b.kind,b.source,b.anchors])]));
      const key=job.document.fileHash+':'+signature;
      if(this.records.has(key))return this.records.get(key);
      if(this.loading.has(key))return this.loading.get(key);
      const promise=(async()=>{
        const location=await this.app.cacheStore().location(job.document),file=PathUtils.join(location.directory,'reader-'+signature.slice(0,16)+'.json');
        let state,error;
        for(const name of [file,file+'.bak']){
          try{if(!await IOUtils.exists(name))continue;const raw=await IOUtils.readUTF8(name);if(raw.length>24e6)throw Error('阅读校订文件过大');state=M.validate(JSON.parse(raw),signature,job);break;}catch(e){error=e;}
        }
        if(!state&&error)throw Error('无法读取英文校订，已停止编辑以保护原记录：'+error.message);
        const record={key,file,directory:location.directory,state:state||M.empty(signature),pendingTargets:new Map()};this.records.set(key,record);return record;
      })();
      this.loading.set(key,promise);try{return await promise;}finally{this.loading.delete(key);}
    }
    mutate(job,change){const operation=this._mutate(job,change);this.operations.add(operation);return operation.finally(()=>this.operations.delete(operation));}
    async _mutate(job,change){
      if(this.closed)throw Error('阅读器已关闭');
      const record=await this.load(job),prior=this.queues.get(record.key)||Promise.resolve();
      const promise=prior.catch(()=>{}).then(async()=>{
        if(this.closed)throw Error('插件已关闭');
        const next=change(M.copy(record.state));M.validate(next,record.state.signature,job);
        await IOUtils.makeDirectory(record.directory,{createAncestors:true,ignoreExisting:true});
        const json=JSON.stringify(next);if(json.length>24e6)throw Error('校订数据超过 24 MB，请缩小修改范围。');
        await this.app.writeCheckpoint(record.file,json,true);record.state=next;this.app.emit();return next;
      });
      this.queues.set(record.key,promise);try{return await promise;}finally{if(this.queues.get(record.key)===promise)this.queues.delete(record.key);}
    }
    async persistClose(job,snapshot){
      // This promise and its continuations belong to the host, not the closing iframe.
      const data=M.copy(snapshot);
      try{const saved=await this.mutate(job,state=>{
        const draft=data.editor;let next=state;
        if(draft){try{const input={...draft.input,text:draft.input.text.trim()},ranges=root.ParallelReaderSelection.editRanges(draft.lastText,input.text,draft.protectedRanges);if(!ranges)throw Error('受保护的文字被修改');next=M.commitEdit(job,next,draft.id,input,{...draft,protectedRanges:ranges});}catch(error){next.editDraft={id:draft.id,input:draft.input,cellIndex:draft.cellIndex};this.app.warnings?.push('校订已保留为草稿：'+error.message);}}
        if(data.position)next.position=data.position;if(data.comment)next.annotationDraft=data.comment;return next;
      });if(data.editor)this.app.readerRecoveryDrafts?.delete(job.id);if(data.comment)this.app.readerRecoveryComments?.delete(job.id);return saved;}catch(error){if(data.editor)(this.app.readerRecoveryDrafts||=new Map()).set(job.id,data.editor);if(data.comment)(this.app.readerRecoveryComments||=new Map()).set(job.id,data.comment);this.app.warnings?.push('阅读修改未能落盘，恢复内容已保留：'+error.message);throw error;}
    }
    async edit(job,id,input){
      const record=await this.load(job);if(this.running.has(record.key))throw Error('请等待当前局部重译完成，或先取消重译。');
      return this.mutate(job,state=>M.edit(job,state,id,input));
    }
    async translate(job,groupID){
      const record=await this.load(job);if(this.running.has(record.key))return this.running.get(record.key).promise;
      const control={aborted:false},run={control};this.running.set(record.key,run);
      run.promise=(async()=>{
        const settings=C.config({...this.app.getSettings(),language:job.settings.language,instructions:job.settings.instructions});
        const group=record.state.groups[groupID];if(!group||group.deleted||group.table)return;
        for(const segment of group.segments){
          if(segment.status==='complete'||control.aborted)continue;
          const revision=segment.revision,source=segment.source;
          const pseudo=await C.createJob({...job.document,structure:[{id:segment.id,source,kind:segment.kind,page:1,anchors:[]}]},settings);
          const targets=[],cached=record.pendingTargets.get(segment.id);
          try{
            if(cached?.revision===revision&&cached.source===source)targets.push(cached.target);
            else for(const part of pseudo.blocks){
              if(control.aborted)break;
              const response=await this.app.request(settings,this.app.keyFor(settings.endpoint),C.payload(pseudo,[part]),control);
              if(control.aborted)break;
              const result=C.parseCompletion(response,[part],settings);if(!result.has(part.id))throw Error('模型未返回完整译文，请重试。');targets.push(result.get(part.id));
            }
            if(control.aborted)break;
            record.pendingTargets.set(segment.id,{revision,source,target:targets.reduce(D.joinText,'')});
            await this.mutate(job,state=>{
              const current=state.groups[groupID]?.segments.find(s=>s.id===segment.id);
              if(current?.revision===revision&&current.source===source){current.target=targets.reduce(D.joinText,'');current.status='complete';current.error='';current.previousTarget='';state.revision++;}return state;
            });
            record.pendingTargets.delete(segment.id);
          }catch(error){
            if(control.aborted)break;
            const message=error.safeMessage||error.message||(error.status?'接口请求失败（'+error.status+'），请检查设置后重试。':'局部翻译失败，请检查连接后重试。');
            if(!record.pendingTargets.has(segment.id))await this.mutate(job,state=>{const s=state.groups[groupID]?.segments.find(s=>s.id===segment.id);if(s?.revision===revision){s.status='failed';s.error=message;state.revision++;}return state;});
            throw Error(record.pendingTargets.has(segment.id)?'新译文暂未保存；请保持 Zotero 打开，重试更新会先保存现有结果。'+message:message);
          }
        }
      })().finally(()=>{if(this.running.get(record.key)===run)this.running.delete(record.key);this.app.emit();});
      this.app.emit();return run.promise;
    }
    cancel(record){const run=this.running.get(record?.key);if(run){run.control.aborted=true;run.control.cancel?.();}}
    async close(){for(const record of this.records.values())this.cancel(record);await Promise.allSettled([...this.running.values()].map(r=>r.promise));while(this.operations.size)await Promise.allSettled([...this.operations]);this.closed=true;}
  }
  root.ParallelReaderHost=ReaderHost;
})(this);
