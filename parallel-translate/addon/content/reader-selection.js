/* Exact text anchors shared by the privileged PDF adapter and the reading view. */
(function(root){
  'use strict';
  const normalizedUnit=s=>s.normalize('NFKC').replace(/[\u2010-\u2014\u2212]/g,'-').replace(/[‘’]/g,"'").replace(/[“”]/g,'"');
  function index(text){
    text=String(text||'');let value='';const starts=[],ends=[];
    for(let p=0;p<text.length;){
      const cp=String.fromCodePoint(text.codePointAt(p)),end=p+cp.length;
      const joined=cp==='-'&&/^[\t ]*\r?\n\s*[a-z]/.test(text.slice(end));
      for(const c of normalizedUnit(cp))if(!/[\s\u00ad]/u.test(c)&&!joined){value+=c;for(let n=0;n<c.length;n++){starts.push(p);ends.push(end);}}
      p=end;
    }
    return {text,value,starts,ends};
  }
  function occurrences(text,needle){const out=[];if(!needle)return out;let at=-1;while((at=text.indexOf(needle,at+1))!==-1){out.push(at);if(out.length>5000)break;}return out;}
  function commonEnd(a,b){let n=0;while(n<a.length&&n<b.length&&a[a.length-1-n]===b[b.length-1-n])n++;return n;}
  function commonStart(a,b){let n=0;while(n<a.length&&n<b.length&&a[n]===b[n])n++;return n;}
  function locate(source,from,to,target){
    if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<=from||to>source.length)return {status:'failed',reason:'选区范围无效'};
    const s=index(source),t=typeof target==='string'?index(target):target;
    const first=s.ends.findIndex(p=>p>from);let last=first;while(last<s.starts.length&&s.starts[last]<to)last++;
    const needle=s.value.slice(first,last);if(!needle)return {status:'failed',reason:'选区没有可定位的文字'};
    const whole=occurrences(t.value,s.value);let found;
    if(whole.length===1)found=whole[0]+first;
    else{
      const left=s.value.slice(Math.max(0,first-64),first),right=s.value.slice(last,last+64);
      const candidates=occurrences(t.value,needle).map(at=>({at,left:commonEnd(left,t.value.slice(Math.max(0,at-64),at)),right:commonStart(right,t.value.slice(at+needle.length,at+needle.length+64))}));
      const reliable=candidates.filter(c=>{
        if(!left&&!right)return true;
        const available=left.length+right.length,score=c.left+c.right;
        return score>=Math.min(20,available)&&(c.left>=Math.min(12,left.length)||c.right>=Math.min(12,right.length));
      }).sort((a,b)=>(b.left+b.right)-(a.left+a.right));
      if(reliable.length===1)found=reliable[0].at;
      else if(reliable.length>1&&reliable[0].left+reliable[0].right>reliable[1].left+reliable[1].right+12)found=reliable[0].at;
      else return {status:'failed',reason:candidates.length?'文字位置不唯一':'未找到对应原文'};
    }
    const start=t.starts[found],end=t.ends[found+needle.length-1];
    return Number.isInteger(start)&&Number.isInteger(end)?{status:'matched',from:start,to:end,text:t.text.slice(start,end)}:{status:'failed',reason:'文字坐标不完整'};
  }
  function quoteRange(text,quote){
    const s=index(text),needle=index(quote).value,matches=occurrences(s.value,needle);
    if(matches.length!==1)return null;const p=matches[0];return {from:s.starts[p],to:s.ends[p+needle.length-1]};
  }
  function pdfText(chars){
    let text='';const owners=[];
    for(let i=0;i<chars.length;i++){
      const c=chars[i];if(c.ignorable)continue;
      const value=String(c.c||'');text+=value;for(let n=0;n<value.length;n++)owners.push(i);
      const space=c.paragraphBreakAfter?'\n\n':c.lineBreakAfter?'\n':c.spaceAfter?' ':'';
      text+=space;for(let n=0;n<space.length;n++)owners.push(null);
    }
    return {text,owners};
  }
  function locatePDF(range,chars){
    const p=pdfText(chars),result=locate(range.sourceText,range.from,range.to,p.text);
    if(result.status!=='matched')return result;
    const ids=[...new Set(p.owners.slice(result.from,result.to).filter(Number.isInteger))];
    if(!ids.length||ids.some(i=>!Array.isArray(chars[i].rect)||chars[i].rect.length!==4||!chars[i].rect.every(Number.isFinite)))return {status:'failed',reason:'选中文字缺少可靠坐标'};
    return {status:'matched',chars:ids.map(i=>chars[i]),text:result.text.trim()};
  }
  function reanchor(range,text){
    const found=locate(range.sourceText,range.from,range.to,text);return found.status==='matched'?{...range,from:found.from,to:found.to,text:found.text,sourceText:text}:null;
  }
  function protectedChange(before,after,ranges){
    for(const r of ranges)if(!reanchor({...r,sourceText:before},after))return false;
    return true;
  }
  function editRanges(before,after,ranges){
    let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
    let tail=0;while(tail<before.length-start&&tail<after.length-start&&before[before.length-1-tail]===after[after.length-1-tail])tail++;
    const end=before.length-tail,delta=after.length-before.length;
    if(ranges.some(r=>start===end?start>r.from&&start<r.to:start<r.to&&end>r.from))return null;
    return ranges.map(r=>({...r,from:r.from>=end?r.from+delta:r.from,to:r.from>=end?r.to+delta:r.to}));
  }
  function keywords(text,items){
    text=String(text||'');const match=text.match(/^(\s*(?:key\s*words?|index\s+terms|关键词|关键字)\s*[:：]?)[\s\n]*/i);
    if(!match&&!items?.length)return null;
    const chinese=/[\u3400-\u9fff]/.test(match?.[1]||''),body=text.slice(match?.[0].length||0);
    const terms=items?.length?items:body.split(/[;；]+/);
    const clean=terms.map(x=>String(x).replace(/\s+/g,' ').trim()).filter(Boolean);
    return {label:chinese?'关键词：':'Keywords: ',items:clean,text:(chinese?'关键词：':'Keywords: ')+clean.join(chinese?'；':'; ')};
  }
  const median=values=>{const v=values.filter(Number.isFinite).sort((a,b)=>a-b);return v.length?v[Math.floor(v.length/2)]:0;};
  function tableRotation(chars){
    chars=chars.filter(char=>!char.ignorable&&String(char.c||'').trim()&&char.rect?.length===4&&char.rect.every(Number.isFinite));
    let horizontal=0,vertical=0,up=0,left=0;
    for(let i=1;i<chars.length;i++){
      const a=chars[i-1],b=chars[i];if(a.page!==b.page||a.lineBreakAfter||a.paragraphBreakAfter)continue;
      const dx=(b.rect[0]+b.rect[2]-a.rect[0]-a.rect[2])/2,dy=(b.rect[1]+b.rect[3]-a.rect[1]-a.rect[3])/2,size=Math.max(a.rect[2]-a.rect[0],a.rect[3]-a.rect[1],1);
      if(Math.hypot(dx,dy)>size*2.5)continue;
      if(Math.abs(dy)>Math.abs(dx)*2){vertical++;up+=dy>0?1:-1;}else if(Math.abs(dx)>Math.abs(dy)*2){horizontal++;left+=dx<0?1:-1;}
    }
    const declared=median(chars.map(c=>Number(c.rotation)).filter(r=>[0,90,180,270].includes(r)));
    if(vertical>horizontal*1.5&&vertical>=3)return up>=0?90:270;
    if(horizontal>=3)return left>0?180:0;
    return declared||0;
  }
  const api={index,locate,occurrences,quoteRange,pdfText,locatePDF,reanchor,protectedChange,editRanges,keywords,tableRotation};
  if(typeof module==='object'&&module.exports)module.exports=api;root.ParallelReaderSelection=api;
})(typeof module==='object'&&module.exports?globalThis:this);
