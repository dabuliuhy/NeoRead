/* Verified source ranges become native Zotero annotations. */
(function(root){
  'use strict';
  const G=root.ParallelPDFLayout,M=root.ParallelReaderModel,S=root.ParallelReaderSelection;
  Object.assign(root.ParallelNativeSession.prototype,{
    setExpanded(value){this.expanded=!!value;this.positionPanel();this.reading?.tools?.expandedChanged();},
    async readerOutline(){await this.sourceReady;return this.closed?[]:JSON.parse(JSON.stringify(this.internal._state?.outline||[]));},
    async showOriginal(page,annotationKey){
      this.setExpanded(false);await this.internal._setReadingMode(true,false);if(this.closed)return;
      this.internal._primaryView.navigate(this.clone(annotationKey?{annotationID:annotationKey}:{pageIndex:Math.max(0,page-1)}));
    },
    async readerAnnotations(){
      const attachment=await Zotero.Items.getAsync(this.reader.itemID);if(!attachment)return [];
      return attachment.getAnnotations().map(item=>{const json=Zotero.Annotations.toJSONSync(item);return {...json,readOnly:json.readOnly||!item.isEditable()||item.annotationIsExternal};});
    },
    async readerAnnotationUpdate(key,patch){
      const attachment=await Zotero.Items.getAsync(this.reader.itemID),item=Zotero.Items.getByLibraryAndKey(attachment.libraryID,key);
      if(patch.remove&&!item)return;
      if(!item?.isAnnotation()||item.parentID!==attachment.id||!item.isEditable()||Zotero.Annotations.toJSONSync(item).readOnly||item.annotationIsExternal)throw Error('该注释不存在或为只读');
      if(patch.remove){await item.eraseTx();return;}
      if(patch.comment!==undefined)item.annotationComment=String(patch.comment||'');
      if(patch.color!==undefined)item.annotationColor=M.color(patch.color);
      await item.saveTx();
    },
    async readerCharacters(originals,pageCache){
      const pdf=await this.borrowPDF(),anchors=originals.flatMap(b=>b.anchors||[]),chars=[];
      for(const page of [...new Set(anchors.map(a=>a.page))].sort((a,b)=>a-b)){
        // Table recovery reads several blocks from one page; fetch its glyphs once.
        let data=pageCache?.get(page);
        if(!data){data=this.unwrap(await pdf.getPageData(this.clone({pageIndex:page-1})));pageCache?.set(page,data);}
        const bounds=anchors.filter(a=>a.page===page).map(a=>a.rect);
        for(const [offset,c] of Array.from(data?.chars||[]).entries()){
          const rect=Array.from(c.rect||[]);if(!G.validRect(rect))continue;
          const x=(rect[0]+rect[2])/2,y=(rect[1]+rect[3])/2;
          if(!bounds.some(r=>x>=r[0]-.5&&x<=r[2]+.5&&y>=r[1]-.5&&y<=r[3]+.5))continue;
          chars.push({c:c.c,rect,page,offset,rotation:c.rotation,ignorable:c.ignorable,spaceAfter:c.spaceAfter,lineBreakAfter:c.lineBreakAfter,paragraphBreakAfter:c.paragraphBreakAfter});
        }
      }
      return chars;
    },
    async readerVectorMetadata(job){
      const A=root.ParallelAssetLayout;if(!A?.vectorFigures||job.readerVectorVersion===2)return false;
      const blocks=root.ParallelDocument.elements(job),captions=blocks.filter(b=>b.kind==='caption'&&!b.assetID&&A.label(b.source)?.kind==='image');
      // f-prefixed IDs are graphics recovered by AssetLayout, whose raster
      // bounds may have represented just one tile and excluded PDF text labels.
      const recovered=blocks.filter(b=>b.kind==='image'&&/^f\d+$/.test(b.id)&&!b.tableImageVersion&&b.captionIDs?.length);
      if(!captions.length&&!recovered.length)return false;
      const pdf=await this.borrowPDF();if(this.closed)return false;
      const runtime=await this.app.importPDFRuntime();if(this.closed)return false;
      const figures=[],pageCache=new Map();
      const union=(a,b)=>[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])];
      for(const number of new Set([...captions,...recovered].map(c=>c.page))){
        const page=this.unwrap(await pdf.getPage(number));if(this.closed)return false;
        const operators=this.unwrap(await page.getOperatorList(this.clone({annotationMode:runtime.AnnotationMode.DISABLE})));if(this.closed)return false;
        figures.push(...A.vectorFigures(blocks,operators,runtime.OPS,Array.from(page.view),number));
        const captionRects=blocks.filter(b=>b.kind==='caption'&&A.label(b.source)?.kind==='image').flatMap(b=>(b.anchors||[]).filter(a=>a.page===number).map(a=>a.rect));
        const vectors=[],view=Array.from(page.view),regions=A.mergeRasterRegions(A.graphics(operators,runtime.OPS,view,[],vectors),captionRects);
        for(const image of recovered.filter(b=>b.page===number&&b.anchors?.length===1)){
          const original=image.anchors[0].rect,contains=(a,b)=>a[0]<=b[0]+.5&&a[1]<=b[1]+.5&&a[2]>=b[2]-.5&&a[3]>=b[3]-.5;
          const region=regions.filter(r=>r.kind==='raster'&&contains(r.rect,original)).sort((a,b)=>(a.rect[2]-a.rect[0])*(a.rect[3]-a.rect[1])-(b.rect[2]-b.rect[0])*(b.rect[3]-b.rect[1]))[0];
          let rect=region?[...region.rect]:[...original];
          const obstacles=blocks.filter(b=>b!==image).flatMap(b=>(b.anchors||[]).filter(a=>a.page===number).map(a=>a.rect));
          if(obstacles.some(r=>Math.min(rect[2],r[2])-Math.max(rect[0],r[0])>1&&Math.min(rect[3],r[3])-Math.max(rect[1],r[1])>1))continue;
          const chars=await this.readerCharacters([{anchors:[{page:number,rect}]}],pageCache);if(this.closed)return false;
          const sizes=chars.map(c=>c.rect[3]-c.rect[1]).filter(n=>n>0).sort((a,b)=>a-b),pad=(sizes[Math.floor(sizes.length/2)]||8)+2,bounds=[rect[0]-pad,rect[1]-pad,rect[2]+pad,rect[3]+pad];
          const edge=await this.readerCharacters([{anchors:[{page:number,rect:bounds}]}],pageCache);if(this.closed)return false;
          for(const c of edge){const x=(c.rect[0]+c.rect[2])/2,y=(c.rect[1]+c.rect[3])/2;if(x<bounds[0]||x>bounds[2]||y<bounds[1]||y>bounds[3]||obstacles.some(r=>x>=r[0]&&x<=r[2]&&y>=r[1]&&y<=r[3]))continue;rect=union(rect,c.rect);}
          // Labels exported as painted outlines have no PDF text-layer glyphs.
          // Include nearby complete paths, with antialiasing space, only where
          // the enlarged crop stays clear of captions and other document blocks.
          for(const r of vectors){
            if(r[0]<bounds[0]||r[1]<bounds[1]||r[2]>bounds[2]||r[3]>bounds[3])continue;
            const next=union(rect,[Math.max(view[0],r[0]-.75),Math.max(view[1],r[1]-.75),Math.min(view[2],r[2]+.75),Math.min(view[3],r[3]+.75)]);
            if(!obstacles.some(b=>Math.min(next[2],b[2])>Math.max(next[0],b[0])&&Math.min(next[3],b[3])>Math.max(next[1],b[1])))rect=next;
          }
          if(rect.some((v,i)=>Math.abs(v-original[i])>.01))image.imageCropAnchors=[{page:number,rect}];
        }
      }
      if(this.closed)return false;
      const previous=new Set((job.readerVectorFigures||[]).map(f=>f.id)),added=figures.filter(f=>!previous.has(f.id)).length;
      job.readerVectorFigures=figures;job.readerVectorVersion=2;
      if(figures.length&&job.layoutReport){const ids=new Set(figures.flatMap(f=>f.captionIDs));job.layoutReport={...job.layoutReport,recoveredImages:(job.layoutReport.recoveredImages||0)+added,pairedFigures:(job.layoutReport.pairedFigures||0)+added,unmatchedCaptions:(job.layoutReport.unmatchedCaptions||[]).filter(c=>!ids.has(c.id))};}
      // Persist the completion marker even if an existing crop was already right.
      return true;
    },
    async readerMetadata(job){
      const figuresChanged=await this.readerVectorMetadata(job);if(this.closed)return false;
      const D=root.ParallelDocument,A=root.ParallelAssetLayout,all=D.elements(job),paired=all.filter(block=>block.assetID).length;
      A?.pairRotated?.(all);
      const byID=new Map(all.map(block=>[block.id,block])),labelled=text=>/^\s*(?:Table|Tab\.|表)\s*\d/i.test(text||'');
      const tables=all.filter(block=>block.kind==='table'||block.kind==='image'&&(labelled(block.source)||labelled(block.figureLabel)||(block.captionIDs||[]).some(id=>labelled(byID.get(id)?.source))));
      const blocks=tables.filter(block=>block.tableImageVersion!==1||block.tableCropVersion!==2);
      if(!blocks.length)return figuresChanged||paired!==all.filter(block=>block.assetID).length;
      const pages=new Map();
      for(const block of blocks){
        const crops=[];
        for(const anchor of block.anchors||[]){
          const chars=await this.readerCharacters([{anchors:[anchor]}],pages);
          let direction=chars;
          if(!direction.length)direction=await this.readerCharacters((block.captionIDs||[]).map(id=>byID.get(id)).filter(Boolean),pages);
          if(this.closed)return;
          const rotation=direction.length?S.tableRotation(direction):[0,90,180,270].includes(block.tableRotation)?block.tableRotation:0;
          let rect=[...anchor.rect];
          const area=r=>Math.max(0,r[2]-r[0])*Math.max(0,r[3]-r[1]);
          const union=(a,b)=>[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])];
          const axis=[90,270].includes(rotation)?0:1;
          const sizes=chars.map(c=>c.rect[axis+2]-c.rect[axis]).filter(n=>n>0).sort((a,b)=>a-b),reach=2*(sizes[Math.floor(sizes.length/2)]||8);
          // Native extraction can split the last cell into a paragraph while its
          // table box ends at the previous line. Only recover fragments whose
          // area is mostly inside this table and extend by at most two glyph
          // heights. Captions and adjacent body paragraphs remain separate.
          for(const fragment of all){
            if(!['paragraph','note','listitem'].includes(fragment.kind)||!fragment.anchors?.length||fragment.anchors.some(a=>a.page!==anchor.page))continue;
            const runs=fragment.anchors.map(a=>a.rect),total=runs.reduce((n,r)=>n+area(r),0);
            const covered=runs.reduce((n,r)=>n+area([Math.max(r[0],anchor.rect[0]),Math.max(r[1],anchor.rect[1]),Math.min(r[2],anchor.rect[2]),Math.min(r[3],anchor.rect[3])]),0);
            if(!total||covered/total<.6)continue;
            const expanded=runs.reduce(union,[...anchor.rect]);
            if(expanded.some((n,i)=>Math.abs(n-anchor.rect[i])>reach))continue;
            rect=union(rect,expanded);
          }
          const glyphs=rect.some((n,i)=>n!==anchor.rect[i])?await this.readerCharacters([{anchors:[{page:anchor.page,rect}]}],pages):chars;
          for(const char of glyphs)rect=union(rect,char.rect);
          if(this.closed)return;
          crops.push({...anchor,rect,rotation});
        }
        delete block.tableMergedInto;
        block.tableCropAnchors=crops;block.tableRotation=crops[0]?.rotation||0;block.tableImageVersion=1;block.tableCropVersion=2;
      }
      for(const fragment of tables){
        if(fragment.tableMergedInto||fragment.captionIDs?.length||fragment.tableCropAnchors?.length!==1)continue;
        const crop=fragment.tableCropAnchors[0],rect=crop.rect,axis=[90,270].includes(crop.rotation)?0:1,across=1-axis;
        const candidates=tables.filter(table=>{
          if(table===fragment||table.tableMergedInto||table.tableCropAnchors?.length!==1)return false;
          const main=table.tableCropAnchors[0],bounds=main.rect;
          if(main.page!==crop.page||main.rotation!==crop.rotation)return false;
          const depth=bounds[axis+2]-bounds[axis],span=bounds[across+2]-bounds[across];
          const overlap=Math.min(rect[across+2],bounds[across+2])-Math.max(rect[across],bounds[across]);
          const gap=[90,180].includes(crop.rotation)?rect[axis]-bounds[axis+2]:bounds[axis]-rect[axis+2];
          return rect[axis+2]-rect[axis]<=depth*.3&&overlap>=span*.8&&rect[across+2]-rect[across]<=span*1.1&&gap>=-2&&gap<=12;
        });
        if(candidates.length!==1)continue;
        const primary=candidates[0],main=primary.tableCropAnchors[0],bounds=main.rect;
        const union=[Math.min(bounds[0],rect[0]),Math.min(bounds[1],rect[1]),Math.max(bounds[2],rect[2]),Math.max(bounds[3],rect[3])];
        const excluded=new Set([primary.id,fragment.id,...(primary.captionIDs||[])]);
        if(all.some(block=>!excluded.has(block.id)&&block.anchors?.some(anchor=>{
          if(anchor.page!==crop.page)return false;
          const centerX=(anchor.rect[0]+anchor.rect[2])/2,centerY=(anchor.rect[1]+anchor.rect[3])/2;
          return centerX>union[0]&&centerX<union[2]&&centerY>union[1]&&centerY<union[3];
        })))continue;
        main.rect=union;fragment.tableMergedInto=primary.id;
      }
      return true;
    },
    async readerAnnotationRanges(baseJob,note,blocks){
      const ranges=[];
      for(const block of blocks){
        const originals=M.sourceBlocks(baseJob,block),chars=await this.readerCharacters(originals),p=S.pdfText(chars),rects=note.position?.rects||[];
        const selected=new Set();
        // Native rects come from Zotero's own text layer whose glyph boxes can
        // differ from the reader character dump by well over a point; a .1 pt
        // tolerance silently dropped most chars of otherwise valid annotations.
        for(const [i,c] of chars.entries())if(c.page===note.position.pageIndex+1&&rects.some(r=>{const x=(c.rect[0]+c.rect[2])/2,y=(c.rect[1]+c.rect[3])/2;return x>=r[0]-.75&&x<=r[2]+.75&&y>=r[1]-.75&&y<=r[3]+.75;}))selected.add(i);
        const offsets=p.owners.map((owner,i)=>selected.has(owner)?i:-1).filter(i=>i>=0);if(!offsets.length)continue;
        const sourceText=root.ParallelMath.withInline(block.source,block.inlineMath),match=S.locate(p.text,offsets[0],offsets.at(-1)+1,sourceText);
        if(match.status==='matched')ranges.push({id:block.id,sourceIDs:block.sourceIDs||[block.id],sourceText,from:match.from,to:match.to,text:match.text});
      }
      return ranges;
    },
    async readerAnnotationCreate(baseJob,block,selection,comment,color,prepared,beforeSave){
      if(selection.side!=='source')throw Error('请在原文中添加注释');
      const attachment=await this.app.checkSource(baseJob);
      if(attachment.id!==this.reader.itemID||!attachment.isEditable())throw Error('当前附件不可编辑');
      const ranges=selection.ranges?.length?selection.ranges:(()=>{
        const r=S.quoteRange(block.source,selection.text);return r?[{id:block.id,sourceIDs:block.sourceIDs||[block.id],sourceText:block.source,...r,text:selection.text}]:[];
      })();
      if(!ranges.length)throw Error('选区位置不明确，请重新选择原文');
      let entries=prepared;
      if(!entries){
        const pages=new Map();
        for(const range of ranges){
          const ids=new Set(range.sourceIDs||[range.id]);let originals=root.ParallelDocument.elements(baseJob).filter(b=>ids.has(b.id));
          if(range.cellIndex!==undefined)originals=originals.map(b=>({...b,anchors:b.tableCells?.[range.cellIndex]?.anchors?.length?b.tableCells[range.cellIndex].anchors:b.anchors}));
          if(!originals.length||!originals.some(b=>b.anchors?.length))throw Error('原文来源不可用');
          const chars=await this.readerCharacters(originals),match=S.locatePDF(range,chars);
          if(match.status!=='matched')throw Error(match.reason);
          for(const page of [...new Set(match.chars.map(c=>c.page))]){
            const selected=match.chars.filter(c=>c.page===page),rects=G.lineRects(selected);
            if(!rects.length)throw Error('选区缺少 PDF 坐标');
            let entry=pages.get(page);if(!entry){entry={page,rects:[],texts:[],sourceIDs:[],ranges:[]};pages.set(page,entry);}
            const full=S.pdfText(chars),chosen=new Set(selected),offsets=full.owners.map((owner,i)=>chosen.has(chars[owner])?i:-1).filter(i=>i>=0);
            const clipped=S.locate(full.text,offsets[0],offsets.at(-1)+1,range.sourceText);
            if(clipped.status!=='matched')throw Error('无法核验跨页文字范围');
            entry.rects.push(...rects);entry.texts.push(S.pdfText(selected).text.trim());entry.sourceIDs.push(...ids);entry.ranges.push({...range,from:clipped.from,to:clipped.to,text:clipped.text});
          }
        }
        entries=[];
        for(const entry of pages.values()){
          const rects=entry.rects.filter((r,i,all)=>all.findIndex(v=>v.every((x,k)=>Math.abs(x-r[k])<.01))===i);
          if(rects.length>512)throw Error('选区过于复杂，请缩小范围');
          const position={pageIndex:entry.page-1,rects};let meta=this.internal._getSourceAnnotationMeta?.(this.clone(position));
          // Older or differently patched readers may not expose the private
          // meta helper; synthesize the same page|y|x sort key it produces.
          if(!meta?.sortIndex){
            const r=rects[0],fallback={pageIndex:entry.page-1,rects:[r]};
            meta={pageLabel:String(entry.page),sortIndex:[String(entry.page-1).padStart(5,'0'),String(Math.max(0,Math.round(r[1]))).padStart(6,'0'),String(Math.max(0,Math.round(r[0]))).padStart(6,'0')].join('|'),position:fallback};
          }
          entries.push({key:Zotero.DataObjectUtilities.generateKey(),type:'highlight',text:entry.texts.join(' '),comment:String(comment||''),color:M.color(color),pageLabel:meta.pageLabel||String(entry.page),sortIndex:meta.sortIndex,position,granularity:'selection',sourceIDs:[...new Set(entry.sourceIDs)],ranges:entry.ranges});
        }
        if(!entries.length)throw Error('未找到可标注的原文');
      }
      selection.prepared=entries;
      // Save keys to the sidecar first: retrying a partial write cannot duplicate annotations.
      for(const entry of entries){
        if(!/^[A-Z0-9]{8}$/.test(entry.key)||entry.type!=='highlight'||!Number.isInteger(entry.position?.pageIndex)||entry.position.pageIndex<0||!entry.position.rects?.length||entry.position.rects.some(r=>!G.validRect(r)))throw Error('注释位置无效');
        const existing=Zotero.Items.getByLibraryAndKey(attachment.libraryID,entry.key);
        if(existing&&(!existing.isAnnotation()||existing.parentID!==attachment.id||!existing.isEditable()||existing.annotationIsExternal))throw Error('原生注释不可更新');
      }
      if(beforeSave)await beforeSave(entries);
      for(let i=0;i<entries.length;i++)await Zotero.Annotations.saveFromJSON(attachment,{...entries[i],comment:i===0?String(comment||''):'',color:M.color(color)});
      return entries;
    }
  });
})(this);

