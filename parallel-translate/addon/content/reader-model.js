/* Local reading corrections. The generation-2 source checkpoint is immutable. */
(function(root){
  'use strict';
  const D=root.ParallelDocument||(typeof require==='function'?require('./document.js'):null);
  const math=root.ParallelMath||(typeof require==='function'?require('./math.js'):null);
  const expanded=(text,block)=>math?math.withInline(text,block.inlineMath):text;
  const copy=value=>JSON.parse(JSON.stringify(value));
  const editable=b=>b&&!b.reference&&['paragraph','heading','caption','note','listitem','preformatted'].includes(b.kind);
  const color=value=>/^#[\da-f]{6}$/i.test(value||'')?value.toLowerCase():'#f19837';
  function empty(signature){return {version:1,signature,revision:0,sequence:0,groups:{},order:[],annotations:{},position:null};}
  function format(value={}){return {bold:!!value.bold,italic:!!value.italic,align:['left','justify','center'].includes(value.align)?value.align:'justify',indent:!!value.indent,spacing:[0,8,16,24].includes(Number(value.spacing))?Number(value.spacing):8};}
  function validate(state,signature,job){
    if(state?.version!==1||state.signature!==signature||!state.groups||Array.isArray(state.groups)||!Array.isArray(state.order)||!state.annotations||!Number.isInteger(state.revision)||state.revision<0||!Number.isInteger(state.sequence)||state.sequence<0)throw Error('阅读校订文件格式或原文标识不一致');
    const known=new Set(D.elements(job).map(b=>b.id)),owned=new Set(),ids=new Set();
    for(const [key,g] of Object.entries(state.groups)){
      if(!known.has(key)||!Array.isArray(g.sourceIDs)||g.sourceIDs[0]!==key||!g.sourceIDs.length||!Array.isArray(g.segments)||!g.segments.length)throw Error('阅读校订的来源段落无效');
      for(const id of g.sourceIDs){if(!known.has(id)||owned.has(id))throw Error('阅读校订来源重复或缺失');owned.add(id);}
      for(const s of g.segments){if(typeof s.id!=='string'||ids.has(s.id)||typeof s.source!=='string'||!s.source.trim()||typeof s.target!=='string'||!['pending','complete','failed'].includes(s.status))throw Error('阅读校订内容无效');ids.add(s.id);s.format=format(s.format);}
    }
    return state;
  }
  function effective(job,state){
    if(!state)return {...layoutKeywords(job),readerRevision:0};
    const base=D.elements(job),byID=new Map(base.map(b=>[b.id,b])),parts=new Map(job.blocks.map(b=>[b.id,b]));
    const hidden=new Set(Object.values(state.groups).filter(g=>!g.table).flatMap(g=>g.sourceIDs.slice(1))),elements=[],blocks=[];
    for(const b of base){
      if(hidden.has(b.id))continue;
      const g=state.groups[b.id];
      if(!g||g.table){elements.push({...b,sourceIDs:[b.id],groupID:b.id});for(const id of b.partIDs||[]){if(parts.has(id))blocks.push(parts.get(id));}continue;}
      const anchors=g.sourceIDs.flatMap(id=>byID.get(id)?.anchors||[]);
      for(const s of g.segments){
        elements.push({...b,id:s.id,source:s.source,kind:s.kind,level:s.level,inlineMath:[],partIDs:[s.id+'.edited'],noTranslate:false,sourceIDs:g.sourceIDs,groupID:b.id,anchors,readerFormat:s.format,readerDeleted:!!g.deleted,edited:true});
        blocks.push({id:s.id+'.edited',paragraphID:s.id,source:s.source,target:s.target||s.previousTarget||'',status:s.status,error:s.error||'',kind:s.kind,page:b.page});
      }
    }
    const rank=new Map(state.order.map((id,i)=>[id,i]));
    if(rank.size)elements.sort((a,b)=>(rank.get(a.groupID)??1e9)-(rank.get(b.groupID)??1e9));
    return layoutKeywords({...job,structure:elements,blocks,readerRevision:state.revision,readerPending:Object.values(state.groups).some(g=>!g.table&&!g.deleted&&g.segments.some(s=>s.status!=='complete'))});
  }
  function layoutKeywords(job){
    const source=D.elements(job),structure=[],blocks=[...job.blocks],parts=new Map(blocks.map(b=>[b.id,b]));
    for(let i=0;i<source.length;i++){
      const b=source[i];
      if(D.visual(b.kind)){const image={...b};if(b.kind==='image'&&b.imageCropAnchors?.length)image.anchors=b.imageCropAnchors;delete image.tableCells;delete image.tableParser;delete image.tableHeader;delete image.readerTableEdited;structure.push(image);continue;}
      if(!/^(?:key\s*words?|index\s+terms|关键词|关键字)\s*[:：]\s*$/i.test(b.source)){structure.push(b);continue;}
      const items=[b];for(let j=i+1;j<source.length&&items.length<25;j++){
        const n=source[j];if(n.kind!=='paragraph'||n.edited||n.source.length>180||n.page!==b.page||/[.!?。]$/.test(n.source.trim()))break;
        const a=b.anchors?.[0],z=n.anchors?.[0];if(a&&z&&(Math.abs(a.rect[0]-z.rect[0])>30||Math.abs(a.rect[1]-z.rect[1])>240))break;items.push(n);
      }
      if(items.length===1){structure.push({...b,keywords:true,kind:'paragraph'});continue;}
      let text='';const keywordParts=[];for(const [k,item] of items.entries()){if(k>0)text+=k===1?' ':'; ';const from=text.length;text+=item.source;keywordParts.push({id:item.id,source:item.source,from,to:text.length});}
      const values=items.map(item=>D.presentation(item,parts)),status=values.every(v=>v.status==='complete')?'complete':values.some(v=>v.status==='failed')?'failed':'pending',partID=b.id+'.keywords';
      blocks.push({id:partID,paragraphID:b.id,source:text,target:values[0].text+' '+values.slice(1).map(v=>v.text).join('；'),status});
      structure.push({...b,kind:'paragraph',level:undefined,source:text,keywords:true,keywordParts,inlineMath:[],partIDs:[partID],sourceIDs:items.map(x=>x.id),groupID:b.id,anchors:items.flatMap(x=>x.anchors||[])});i+=items.length-1;
    }
    if(!job.readerVectorFigures?.length)return {...job,structure,blocks};
    const recovered=new Map(job.readerVectorFigures.map(image=>[image.captionIDs[0],image])),added=new Set(),presented=[];
    for(const b of structure){
      const key=b.groupID||b.id,image=recovered.get(key);
      if(image&&!b.readerDeleted){
        if(!added.has(key)){added.add(key);presented.push({...image,captionIDs:structure.filter(c=>(c.groupID||c.id)===key&&!c.readerDeleted).map(c=>c.id),sourceIDs:[key]});}
        presented.push({...b,assetID:image.id});
      }else presented.push(b);
    }
    return {...job,structure:presented,blocks};
  }
  function edit(job,state,id,input){
    const next=copy(state),view=effective(job,state),list=D.elements(view),block=list.find(b=>b.id===id);
    if(!editable(block))throw Error('请选择可编辑的英文正文、标题或题注。');
    const raw=String(input.text||'').replace(/\r\n?/g,'\n');
    const texts=(input.singleBlock?[raw]:raw.split(/\n\s*\n/)).map(t=>t.trim()).filter(Boolean);
    if(!texts.length||texts.join('').length>60000||texts.length>60)throw Error('请输入正文；每次最多 60 段、60,000 字符。');
    const key=block.groupID,previous=state.groups[key],sourceIDs=[...block.sourceIDs];
    const previousParts=new Map(view.blocks.map(b=>[b.id,b])),reuse=new Map();
    for(const b of list.filter(b=>b.groupID===key)){const p=D.presentation(b,previousParts);if(p.status==='complete')reuse.set(expanded(b.source,b),expanded(p.text,b));}
    let previousTarget=list.filter(b=>b.groupID===key).map(b=>expanded(D.presentation(b,previousParts).text,b)).join('\n\n');
    if(input.mergeNext){
      const at=list.findLastIndex(b=>b.groupID===key),other=list[at+1];
      if(!other||block.kind!=='paragraph'||other.kind!=='paragraph'||other.reference||other.frontMatter!==block.frontMatter)throw Error('只能合并相邻的正文段落。');
      sourceIDs.push(...other.sourceIDs);delete next.groups[other.groupID];
      for(const b of list.filter(b=>b.groupID===other.groupID)){const p=D.presentation(b,previousParts);if(p.status==='complete')reuse.set(expanded(b.source,b),expanded(p.text,b));previousTarget+='\n\n'+expanded(p.text,b);}
      next.order=next.order.filter(k=>k!==other.groupID);
    }
    const kind=['paragraph','heading','caption','note','listitem','preformatted'].includes(input.kind)?input.kind:block.kind;
    const level=kind==='heading'?Math.max(1,Math.min(6,Number(input.level)||2)):undefined;
    const assigned=new Set([key]);
    const segments=texts.map((source,index)=>{
      const old=previous?.segments.find(s=>s.source===source&&!assigned.has(s.id)),target=reuse.get(source)||'';
      const segmentID=index===0?key:old?.id||key+'~'+(++next.sequence);assigned.add(segmentID);
      return {id:segmentID,source,kind,level,format:format(input.format),target,status:target?'complete':'pending',previousTarget:target?'':index===0?previousTarget:'',revision:next.revision+1};
    });
    if(input.singleBlock&&previous?.segments.length>1){const at=previous.segments.findIndex(s=>s.id===id);segments[0].id=id;const kept=copy(previous.segments);kept.splice(at,1,segments[0]);next.groups[key]={sourceIDs:[...new Set(sourceIDs)],segments:kept};}
    else next.groups[key]={sourceIDs:[...new Set(sourceIDs)],segments};next.revision++;
    return next;
  }
  function restore(job,state,id){const b=D.elements(effective(job,state)).find(b=>b.id===id);if(!b)throw Error('段落已不存在');const next=copy(state);delete next.groups[b.groupID];next.order=next.order.flatMap(key=>key===b.groupID?b.sourceIDs:key);next.revision++;return next;}
  function move(job,state,id,direction){
    const list=D.elements(effective(job,state)),b=list.find(b=>b.id===id);if(!editable(b)||b.assetID)throw Error('该内容不能单独移动');
    const order=[...new Set(list.map(b=>b.groupID))],i=order.indexOf(b.groupID),j=i+(direction<0?-1:1);
    if(j<0||j>=order.length)return state;
    const adjacent=list.find(b=>b.groupID===order[j]);if(!editable(adjacent)||adjacent.assetID)throw Error('图表与题注应保持关联，请在正文范围内调整顺序。');
    [order[i],order[j]]=[order[j],order[i]];const next=copy(state);next.order=order;next.revision++;return next;
  }
  function sourceBlocks(job,block){const ids=new Set(block.sourceIDs||[block.id]);return D.elements(job).filter(b=>ids.has(b.id));}
  function commitEdit(job,state,id,input,options={}){
    if(options.cellIndex!==undefined)throw Error('表格现以原图显示，不再支持单元格校订。');
    const next=edit(job,state,id,input);
    for(const note of options.annotations||[]){
      const changed=(options.protectedRanges||[]).filter(r=>r.noteKey===note.key);if(!changed.length)continue;
      const ranges=copy(note.ranges);for(const r of changed)ranges[r.rangeIndex]={...ranges[r.rangeIndex],sourceText:input.text,from:r.from,to:r.to,text:input.text.slice(r.from,r.to)};
      if(note.local&&next.localAnnotations?.[note.key]){next.localAnnotations[note.key].ranges=ranges;next.localAnnotations[note.key].selection.ranges=ranges;}
      else for(const member of note.members||[note]){const key=job.document.libraryID+':'+job.document.attachmentKey+':'+member.key;next.annotations[key]={...(next.annotations[key]||{}),sourceIDs:options.sourceIDs||[id],ranges:ranges.filter(r=>!r.nativeKey||r.nativeKey===member.key),granularity:'selection',side:'source'};}
    }
    delete next.editDraft;return next;
  }
  const api={empty,validate,effective,edit,commitEdit,layoutKeywords,restore,move,sourceBlocks,editable,color,format,copy};
  if(typeof module==='object'&&module.exports)module.exports=api;root.ParallelReaderModel=api;
})(this);
