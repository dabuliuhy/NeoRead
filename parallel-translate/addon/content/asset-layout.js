/* Independent PDF graphics recovery and coordinate-based figure/caption pairing. */
(function (root) {
  "use strict";
  const area = r => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const intersection = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  function multiply(a, b) {
    return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
  }
  function transform(rect, matrix) {
    const points = [[rect[0],rect[1]],[rect[0],rect[3]],[rect[2],rect[1]],[rect[2],rect[3]]].map(([x,y]) => [matrix[0]*x+matrix[2]*y+matrix[4],matrix[1]*x+matrix[3]*y+matrix[5]]);
    return [Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
  }
  const array = value => Array.from({ length: 4 }, (_, i) => value[i]);
  function graphics(operatorList, OPS, view, rules = [], vectors) {
    const names = Object.fromEntries(Object.entries(OPS).map(([name, code]) => [code, name]));
    let state = { matrix: [1,0,0,1,0,0], clip: view }, stack = []; const regions = [];
    function save() { stack.push({ matrix: [...state.matrix], clip: [...state.clip] }); }
    function add(rect, kind) {
      const box = intersection(transform(rect, state.matrix), state.clip);
      if (box.every(Number.isFinite) && box[2] - box[0] >= 25 && box[3] - box[1] >= 18 && area(box) >= 900) regions.push({ rect: box, kind });
    }
    for (let i = 0; i < operatorList.fnArray.length; i++) {
      const name = names[operatorList.fnArray[i]], args = operatorList.argsArray[i] || [];
      if (name === "save") save();
      else if (name === "restore" || name === "paintFormXObjectEnd" || name === "endGroup") state = stack.pop() || state;
      else if (name === "transform") state.matrix = multiply(state.matrix, args);
      else if (name === "paintFormXObjectBegin") {
        save(); if (args[0]) state.matrix = multiply(state.matrix, args[0]);
        if (args[1]) { const rect = array(args[1]); add(rect, "form"); state.clip = intersection(state.clip, transform(rect, state.matrix)); }
      } else if (name === "beginGroup") {
        save(); const prior = state.matrix;
        if (args[0]?.matrix) state.matrix = multiply(state.matrix, args[0].matrix);
        if (args[0]?.bbox) { add(args[0].bbox, "group"); state.clip = intersection(state.clip, transform(args[0].bbox, state.matrix)); }
        // The group matrix positions its clipping box; content operators retain the
        // incoming transform (a subsequent form operator applies its own matrix).
        state.matrix = prior;
      } else if (name === 'constructPath' && args[2] && names[args[0]] !== 'endPath') {
        // Zotero 10's PDF.js DrawOPS: move, line, cubic, quadratic, close.
        // Keep vector rules as recognition evidence; they are never screenshots.
        const data=args[1]?.[0];let x=0,y=0,sx=0,sy=0;
        const addRule=r=>{if(r.every(Number.isFinite)&&r[2]-r[0]>=3&&r[3]-r[1]<=.8&&r[0]>=state.clip[0]-.5&&r[2]<=state.clip[2]+.5&&r[1]>=state.clip[1]-.5&&r[3]<=state.clip[3]+.5)rules.push(r);};
        // A rendered page may already have replaced DrawOPS with Path2D.
        // Its original vector bounding box remains usable for a thin rule.
        const box=transform(args[2],state.matrix);
        if(vectors){const r=intersection(box,state.clip);if(r.every(Number.isFinite)&&r[2]>=r[0]&&r[3]>=r[1]&&Math.max(r[2]-r[0],r[3]-r[1])>=2&&area(r)<area(view)*.8)vectors.push(r);}
        if(box[3]-box[1]<=.8){addRule(box);continue;}
        if(!data?.length)continue;
        const line=(nx,ny)=>{
          const r=transform([Math.min(x,nx),Math.min(y,ny),Math.max(x,nx),Math.max(y,ny)],state.matrix);
          addRule(r);
          x=nx;y=ny;
        };
        for(let p=0;p<data.length;){const op=data[p++];if(op===0){x=sx=data[p++];y=sy=data[p++];}else if(op===1)line(data[p++],data[p++]);else if(op===2){p+=4;x=data[p++];y=data[p++];}else if(op===3){p+=2;x=data[p++];y=data[p++];}else if(op===4)line(sx,sy);else break;}
      } else if (["paintImageXObject", "paintInlineImageXObject", "paintImageMaskXObject", "paintSolidColorImageMask"].includes(name)) add([0,0,1,1], "raster");
      else if (name === "paintImageXObjectRepeat") {
        for (let n = 0; n < args[3].length; n += 2) {
          const prior = state.matrix; state.matrix = multiply(prior, [args[1],0,0,args[2],args[3][n],args[3][n+1]]); add([0,0,1,1], "raster"); state.matrix = prior;
        }
      } else if (name === "paintInlineImageXObjectGroup") {
        for (const part of args[1] || []) {
          const prior=state.matrix; state.matrix=multiply(prior,part.transform); add([0,0,1,1],"raster"); state.matrix=prior;
        }
      }
    }
    return regions;
  }
  // Native structure can omit diagrams made solely from painted vector paths.
  // Recover only connected drawings beside an otherwise unpaired figure caption.
  // The reader keeps these as presentation metadata, outside correction identity.
  function vectorFigures(blocks,operators,OPS,view,page){
    const captions=blocks.filter(b=>b.page===page&&!b.assetID&&captionType(b)==='image');if(!captions.length)return [];
    const vectors=[];graphics(operators,OPS,view,[],vectors);const groups=[];
    for(const bounds of vectors){
      let rect=[bounds[0]-.75,bounds[1]-.75,bounds[2]+.75,bounds[3]+.75],count=1,joined;
      do{joined=false;for(let i=groups.length-1;i>=0;i--){const other=groups[i];if(rect[0]<=other.rect[2]+1&&rect[2]>=other.rect[0]-1&&rect[1]<=other.rect[3]+1&&rect[3]>=other.rect[1]-1){rect=union(rect,other.rect);count+=other.count;groups.splice(i,1);joined=true;}}}while(joined);
      groups.push({rect,count});
    }
    const obstacles=blocks.filter(b=>b.kind!=='caption').flatMap(b=>(b.anchors||[]).filter(a=>a.page===page).map(a=>a.rect));
    const candidates=groups.filter(g=>g.count>=3&&g.rect[2]-g.rect[0]>=25&&g.rect[3]-g.rect[1]>=18&&!obstacles.some(r=>area(intersection(g.rect,r))>area(r)*.25)),result=[],used=new Set();
    for(const caption of captions){
      const c=caption.anchors?.find(a=>a.page===page)?.rect;if(!c)continue;
      const choices=candidates.filter(g=>{const r=g.rect,gap=r[1]-c[3],overlap=Math.min(r[2],c[2])-Math.max(r[0],c[0]);if(gap<0||gap>65||overlap<Math.min(r[2]-r[0],c[2]-c[0])*.4)return false;
        const corridor=[Math.max(r[0],c[0]),c[3],Math.min(r[2],c[2]),r[1]];return !obstacles.some(b=>area(intersection(corridor,b))>area(b)*.25);});
      if(choices.length!==1||used.has(choices[0]))continue;used.add(choices[0]);
      result.push({id:'vf-'+caption.id,kind:'image',source:'',page,anchors:[{page,rect:intersection(choices[0].rect,view)}],captionIDs:[caption.id],captionPlacement:'after',figureLabel:caption.source.match(LABEL)?.[0]||''});
    }
    return result;
  }
  function mergeRasterRegions(regions,captionRects=[]){
    const groups=[];
    for(const region of regions.filter(r=>r.kind==='raster')){
      let rect=[...region.rect],count=1,joined,parts=[region];
      do{joined=false;for(let i=groups.length-1;i>=0;i--){const other=groups[i];if(rect[0]<=other.rect[2]+.5&&rect[2]>=other.rect[0]-.5&&rect[1]<=other.rect[3]+.5&&rect[3]>=other.rect[1]-.5){rect=union(rect,other.rect);count+=other.count;parts.push(...other.parts);groups.splice(i,1);joined=true;}}}while(joined);
      groups.push({kind:'raster',rect,count,parts});
    }
    return [...regions.filter(r=>r.kind!=='raster'),...groups.flatMap(g=>{
      const r=g.rect,owners=captionRects.filter(c=>{const overlap=Math.min(r[2],c[2])-Math.max(r[0],c[0]),below=r[1]-c[3],above=c[1]-r[3];return overlap>=Math.min(r[2]-r[0],c[2]-c[0])*.4&&(below>=-1&&below<65||above>=-1&&above<35);});
      return owners.length>1?g.parts.map(p=>({...p,count:1})):[{kind:g.kind,rect:g.rect,count:g.count}];
    })];
  }
  const NUMBER = "(?:[SA]?\\d+|[IVX]+)";
  const LABEL = new RegExp("^\\s*(Fig(?:ure)?s?\\.?|Tables?|Tabs?\\.?|图|表)\\s*(" + NUMBER + ")(?![\\w])", "i");
  function label(text) {
    const m = String(text || "").match(LABEL);
    if (!m) return null;
    const kind = /^(?:t|表)/i.test(m[1]) ? "table" : "image", number = m[2].toUpperCase();
    return { kind, number, key: kind + ":" + number, title: (kind === "table" ? "表 " : "图 ") + number };
  }
  function captionType(block) { return block.kind === "caption" ? label(block.source)?.kind || null : null; }
  // "Table 1. Continued" names a later page of an asset that is already indexed.
  const continued = text => /^\s*(?:Fig(?:ure)?s?\.?|Tables?|Tabs?\.?|图|表)\s*[SA]?\d+[.:]?\s*\(?(?:continued|cont(?:'d|\.))\)?\s*\.?\s*$|续/i.test(String(text || ""));
  // One parser serves both placement and clickable references. Never match 1 in 10,
  // a supplementary number as a main-paper number, or a decimal section number.
  function mentions(text) {
    text = String(text || "");
    const pattern = new RegExp("(?:\\b(Fig(?:ure)?s?\\.?|Tables?|Tabs?\\.?)|([图表]))\\s*(" + NUMBER + ")(?!\\d|\\.\\d)((?:\\s*(?:[,，、&]|and|及|和|[–—−-]|to|至)\\s*" + NUMBER + "(?!\\d|\\.\\d))*)", "gi"), result = [];
    for (const m of text.matchAll(pattern)) {
      const kind = /^(?:t|表)/i.test(m[1] || m[2]) ? "table" : "image";
      const numbers = [m[3].toUpperCase()], tail = new RegExp("([,，、&]|and|及|和|[–—−-]|to|至)\\s*(" + NUMBER + ")", "gi");
      for (const next of m[4].matchAll(tail)) {
        const number = next[2].toUpperCase(), a = numbers.at(-1).match(/^([SA]?)(\d+)$/), b = number.match(/^([SA]?)(\d+)$/);
        if (/^(?:[–—−-]|to|至)$/i.test(next[1]) && a && b && a[1] === b[1] && +b[2] > +a[2] && +b[2] - +a[2] <= 30) {
          for (let n = +a[2] + 1; n <= +b[2]; n++) numbers.push(a[1] + n);
        } else numbers.push(number);
      }
      result.push({ start: m.index, end: m.index + m[0].length, keys: [...new Set(numbers.map(n => kind + ":" + n))] });
    }
    return result;
  }
  function index(elements) {
    const byID = new Map(elements.map(e => [e.id, e])), result = new Map(), ambiguous = new Set();
    for (const asset of elements) {
      if (!["image", "table"].includes(asset.kind) || asset.tableMergedInto) continue;
      const kind = asset.tableImageVersion === 1 ? "table" : asset.kind;
      const captions = (asset.captionIDs || []).map(id => byID.get(id)).filter(c => c?.assetID === asset.id);
      const name = captions.map(c => label(c.source)).find(l => l?.kind === kind) || label(asset.figureLabel);
      if (!name || name.kind !== kind) continue;
      if (captions.length && captions.every(c => !label(c.source) || continued(c.source))) { if (!result.has(name.key)) result.set(name.key, { ...name, asset, captions, continued: true }); continue; }
      if (result.get(name.key)?.continued) result.set(name.key, { ...name, asset, captions });
      else if (result.has(name.key)) ambiguous.add(name.key);
      else result.set(name.key, { ...name, asset, captions });
    }
    for (const key of ambiguous) result.delete(key);
    return result;
  }
  // Landscape tables and figures are printed rotated by 90°: their title is a
  // tall, narrow strip beside the asset instead of a line above or below it.
  function pairRotated(blocks) {
    const tall = r => r[3] - r[1] > (r[2] - r[0]) * 3;
    const assets = blocks.filter(b => ["image", "table"].includes(b.kind) && !b.captionIDs?.length && b.anchors?.[0]);
    const free = blocks.filter(b => b.kind === "caption" && !b.assetID && b.anchors?.length === 1 && tall(b.anchors[0].rect));
    for (const caption of free.filter(c => captionType(c))) {
      if (caption.assetID) continue;
      const c = caption.anchors[0].rect, page = caption.anchors[0].page, choices = [];
      for (const asset of assets) {
        if (asset.captionIDs?.length || captionType(caption) !== asset.kind || asset.anchors[0].page !== page) continue;
        const r = asset.anchors[0].rect, overlap = Math.min(r[3], c[3]) - Math.max(r[1], c[1]);
        if (overlap < (c[3] - c[1]) * .8) continue;
        const left = r[0] - c[2], right = c[0] - r[2], gap = left >= -3 ? left : right >= -3 ? right : null;
        if (gap === null || gap > 25) continue;
        if (blocks.some(b => b !== asset && b !== caption && !(free.includes(b) && !captionType(b)) && b.anchors?.some(a => a.page === page && a.rect[0] >= Math.min(c[2], r[2]) - 1 && a.rect[2] <= Math.max(c[0], r[0]) + 1 && Math.min(a.rect[3], c[3]) - Math.max(a.rect[1], c[1]) > 0))) continue;
        choices.push({ asset, gap, side: left >= -3 ? 1 : -1 });
      }
      choices.sort((a, b) => a.gap - b.gap);
      const best = choices[0]; if (!best) continue;
      const asset = best.asset;
      asset.captionIDs = [caption.id]; asset.captionPlacement = "before"; asset.figureLabel = caption.source.match(LABEL)[0].trim(); caption.assetID = asset.id;
      // Title continuation lines follow in the reading direction, towards the asset.
      let last = caption;
      while (!/[.!?。！？]\s*$/.test(last.source)) {
        const a = last.anchors[0].rect;
        const next = free.find(n => !n.assetID && !captionType(n) && n.anchors[0].page === page && (best.side > 0 ? n.anchors[0].rect[0] - a[2] : a[0] - n.anchors[0].rect[2]) >= -2 && (best.side > 0 ? n.anchors[0].rect[0] - a[2] : a[0] - n.anchors[0].rect[2]) <= 8 && Math.abs((n.anchors[0].rect[1] + n.anchors[0].rect[3]) - (a[1] + a[3])) < 40);
        if (!next) break;
        next.assetID = asset.id; asset.captionIDs.push(next.id); last = next;
      }
    }
    return blocks;
  }
  // Resolve all captions together. Direction is learned from unambiguous nearby
  // pairs of the same type, while each page still allows titles on either side.
  function pairCaptions(blocks) {
    const assets = blocks.filter(b => ["image", "table"].includes(b.kind));
    const caps = blocks.filter(b => captionType(b)), edges = [], votes = { image: 0, table: 0 };
    for (const b of blocks) { delete b.assetID; if (assets.includes(b)) { b.captionIDs = []; delete b.captionPlacement; } }
    for (const caption of caps) {
      const choices = [];
      for (const asset of assets) {
        if (captionType(caption) !== asset.kind) continue;
        const a = asset.anchors?.[0], same = caption.anchors?.filter(c => c.page === a?.page);
        if (!a || !same?.length) continue;
        const r = a.rect, c = same.map(x => x.rect).reduce(union);
        const overlap = Math.min(r[2], c[2]) - Math.max(r[0], c[0]);
        if (overlap < Math.min(r[2] - r[0], c[2] - c[0]) * .45) continue;
        const below = r[1] - c[3], above = c[1] - r[3];
        if (below < -3 && above < -3) continue;
        const placement = below >= -3 ? "after" : "before", gap = Math.max(0, placement === "after" ? below : above);
        if (gap > 65) continue;
        const corridor = [Math.max(r[0], c[0]), placement === "after" ? c[3] : r[3], Math.min(r[2], c[2]), placement === "after" ? r[1] : c[1]];
        if (area(corridor) > 0 && blocks.some(b => b !== asset && b !== caption && b.anchors?.some(x => x.page === a.page && area(intersection(x.rect, corridor)) > area(x.rect) * .25))) continue;
        choices.push({ asset, caption, placement, gap, score: gap + Math.abs(r[0] - c[0]) * .04 });
      }
      choices.sort((a, b) => a.score - b.score);
      if (choices.length && (choices.length === 1 || choices[1].score - choices[0].score > 16)) votes[choices[0].asset.kind] += choices[0].placement === "after" ? 1 : -1;
      edges.push(...choices);
    }
    for (const edge of edges) if (votes[edge.asset.kind] && (votes[edge.asset.kind] > 0) !== (edge.placement === "after")) edge.score += 18;
    edges.sort((a, b) => a.score - b.score);
    const used = new Set();
    for (const { asset, caption, placement } of edges) {
      if (used.has(asset.id) || used.has(caption.id)) continue;
      used.add(asset.id); used.add(caption.id);
      asset.captionIDs = [caption.id]; asset.captionPlacement = placement; asset.figureLabel = caption.source.match(LABEL)[0].trim();
      caption.assetID = asset.id;
    }
    // An extractor may split a title into several caption lines. Only contiguous
    // lines in the same column can continue it; another numbered title is a stop.
    for (const caption of caps.filter(c => c.assetID)) {
      const asset = assets.find(a => a.id === caption.assetID); let last = caption;
      for (;;) {
        if (/[.!?。！？]\s*$/.test(last.source)) break;
        const a = last.anchors.at(-1);
        const next = blocks.filter(c => c.kind === "caption" && !c.assetID && !captionType(c) && c.anchors?.[0]?.page === a.page)
          .filter(c => { const r = c.anchors[0].rect; return a.rect[1] - r[3] >= -2 && a.rect[1] - r[3] <= 12 && Math.abs(a.rect[0] - r[0]) < 20; })
          .sort((x, y) => y.anchors[0].rect[3] - x.anchors[0].rect[3])[0];
        if (!next) break;
        next.assetID = asset.id; asset.captionIDs.push(next.id); last = next;
      }
    }
    return pairRotated(blocks);
  }
  function readingOrder(items, view) {
    if (items.length <= 1) return items;
    const mid = (view[0]+view[2])/2, width = view[2]-view[0];
    const wide = items.filter(x => x.rect[0] < mid - 20 && x.rect[2] > mid + 20 && x.rect[2]-x.rect[0] > width*.5).sort((a,b)=>b.rect[3]-a.rect[3]);
    const other = items.filter(x => !wide.includes(x)); const output = [];
    const columns = rows => rows.sort((a,b) => ((a.rect[0]+a.rect[2])/2 >= mid ? 1 : 0)-((b.rect[0]+b.rect[2])/2 >= mid ? 1 : 0) || b.rect[3]-a.rect[3] || a.rect[0]-b.rect[0]);
    for (const span of wide) {
      const above = other.filter(x => x.rect[3] > span.rect[3] + 3);
      output.push(...columns(above)); for (const x of above) other.splice(other.indexOf(x),1);
      output.push(span);
    }
    output.push(...columns(other)); return output;
  }
  function repair(elements, pageGraphics, views, layoutTransforms = []) {
    const blocks = elements.map(b => ({ ...b, anchors: b.anchors.map(a=>({page:a.page,rect:[...a.rect]})) }));
    // Native extraction sometimes puts first-page affiliations inside an image.
    // A complete PDF form plus text geometry can separate them without OCR or AI.
    const metadata = [];
    for (const image of blocks.filter(b => b.kind === "image" && b.page === 1 && b.textFragments?.length)) {
      const anchor = image.anchors[0], forms = (pageGraphics[0] || []).filter(g => ["form", "group"].includes(g.kind) && area(intersection(g.rect, anchor.rect)) / area(g.rect) > .98 && area(g.rect) / area(anchor.rect) > .45).sort((a,b) => area(b.rect)-area(a.rect));
      const form = forms[0]; if (!form || anchor.rect[3] - form.rect[3] < 15) continue;
      const outside = image.textFragments.filter(t => t.anchors.every(a => a.page === 1 && a.rect[1] > form.rect[3] + 3));
      const source = outside.map(t => t.source.trim()).join(" ");
      if (!/\b(?:university|institute|laboratory|school|department)\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(source)) continue;
      metadata.push({id:image.id+"-meta",kind:"note",source,page:1,anchors:outside.flatMap(t=>t.anchors.map(a=>({page:a.page,rect:[...a.rect]}))),frontMatter:true});
      anchor.rect = [...form.rect];
    }
    blocks.push(...metadata);
    // Some native table boxes swallow the next figure. Bound them by actual cell text,
    // with room for rules/padding, before using them as obstacles or cropping them.
    for (const table of blocks.filter(b=>b.kind==="table"&&b.textAnchors?.length)) {
      for (const anchor of table.anchors) {
        const runs=table.textAnchors.filter(a=>a.page===anchor.page); if (!runs.length) continue;
        const rect=runs.map(a=>a.rect).reduce(union);
        anchor.rect=intersection(anchor.rect,[rect[0]-7,rect[1]-4,rect[2]+7,rect[3]+4]);
      }
    }
    const candidates = [], originalImages = blocks.filter(b=>b.kind === "image");
    for (let page = 1; page <= views.length; page++) {
      const native = originalImages.filter(b=>b.page===page).map(b=>({rect:b.anchors[0]?.rect,kind:"native",original:b})).filter(b=>b.rect);
      const captionRects=blocks.filter(b=>captionType(b)==='image').flatMap(b=>(b.anchors||[]).filter(a=>a.page===page).map(a=>a.rect));
      const all = [...native,...mergeRasterRegions(pageGraphics[page-1]||[],captionRects)].map(c=>({...c,page}));
      const textRects = blocks.filter(b=>["paragraph","heading","listitem","table","math"].includes(b.kind)).flatMap(b=>b.anchors.filter(a=>a.page===page).map(a=>a.rect));
      const useful = all.filter(c=>c.kind === "native" || !textRects.some(r=>area(intersection(c.rect,r)) > area(r)*.25));
      useful.sort((a,b)=>area(b.rect)-area(a.rect));
      const kept = [];
      for (const c of useful) {
        const duplicate = kept.find(k=>area(intersection(c.rect,k.rect))/area(c.rect) > .96);
        if (duplicate) { if (c.original) { duplicate.original ||= c.original; (duplicate.contained ||= []).push(c.original.id); } continue; }
        kept.push(c);
      }
      candidates.push(...kept);
    }
    const captions = blocks.filter(b=>captionType(b)==="image"), edges = [];
    for (const caption of captions) for (const image of candidates) {
      const anchor = caption.anchors.find(a=>a.page===image.page); if (!anchor) continue;
      const c = anchor.rect, r = image.rect;
      const overlap = Math.max(0,Math.min(c[2],r[2])-Math.max(c[0],r[0]));
      if (overlap < Math.min(c[2]-c[0],r[2]-r[0])*.4) continue;
      const below = r[1]-c[3], above = c[1]-r[3];
      if (!(below >= -3 && below < 65) && !(above >= -3 && above < 35)) continue;
      const gap = below >= -3 ? Math.max(0,below) : Math.max(0,above)+40;
      const corridor = [Math.max(r[0],c[0]),Math.min(c[3],r[3]),Math.min(r[2],c[2]),Math.max(r[1],c[1])];
      if (area(corridor)>0 && blocks.some(b=>b.kind!=="caption"&&b.kind!=="image"&&b.anchors.some(a=>a.page===image.page&&area(intersection(a.rect,corridor))>area(a.rect)*.3))) continue;
      edges.push({caption,image,score:gap+Math.abs((r[0]+r[2]-c[0]-c[2])/2)*.03,placement:below>=-3?"after":"before"});
    }
    edges.sort((a,b)=>a.score-b.score);
    const usedCaptions=new Set(), usedImages=new Set(), replacements=new Map(), recovered=[], absorbed=new Set();
    for (const edge of edges) {
      if (usedCaptions.has(edge.caption)||usedImages.has(edge.image)) continue;
      usedCaptions.add(edge.caption); usedImages.add(edge.image);
      const asset = edge.image.original || { id:"f"+String(recovered.length+1).padStart(5,"0"),kind:"image",source:"",page:edge.image.page,anchors:[{page:edge.image.page,rect:edge.image.rect}] };
      asset.anchors[0].rect = [...edge.image.rect];
      for (const id of edge.image.contained || []) if (id !== asset.id) absorbed.add(id);
      asset.captionIDs=[edge.caption.id]; asset.captionPlacement=edge.placement; asset.figureLabel=edge.caption.source.match(/^(?:Fig(?:ure)?\.?\s*\d+[a-z]?|图\s*\d+)/i)?.[0] || "";
      edge.caption.assetID=asset.id;
      if (edge.image.original) replacements.set(asset.id,asset); else recovered.push(asset);
    }
    const combined = [...blocks.filter(b=>!absorbed.has(b.id)).map(b=>replacements.get(b.id)||b),...recovered];
    pairCaptions(combined);
    const byID = new Map(combined.map(b=>[b.id,b])), groups=[];
    for (const block of combined) {
      if (block.assetID) continue;
      const caps=(block.captionIDs||[]).map(id=>byID.get(id)).filter(Boolean), a=block.anchors[0];
      const content=block.captionPlacement==="before"?[...caps,block]:[block,...caps];
      const rect=a?caps.flatMap(c=>c.anchors.filter(x=>x.page===a.page)).reduce((r,c)=>union(r,c.rect),a.rect):[0,0,0,0];
      const matrix = layoutTransforms[block.page-1];
      groups.push({content,page:block.page,rect:matrix ? transform(rect,matrix) : rect});
    }
    const output=[];
    for (let page=1;page<=views.length;page++) {
      const pageGroups = groups.filter(g=>g.page===page), matrix = layoutTransforms[page-1];
      const ordered = pageGroups.some(g=>g.content.length>1) ? readingOrder(pageGroups,matrix?transform(views[page-1],matrix):views[page-1]) : pageGroups;
      output.push(...ordered.flatMap(g=>g.content));
    }
    return { elements:output, report:{originalImages:originalImages.length,recoveredImages:recovered.length,figures:captions.length,pairedFigures:usedCaptions.size,unmatchedCaptions:captions.filter(c=>!usedCaptions.has(c)).map(c=>({id:c.id,page:c.page,label:c.source.slice(0,80)}))} };
  }
  const api={graphics,vectorFigures,mergeRasterRegions,repair,readingOrder,transform,label,mentions,index,pairCaptions,pairRotated};
  if(typeof module!=="undefined")module.exports=api;
  root.ParallelAssetLayout=api;
})(typeof module!=="undefined"&&module.exports?globalThis:this);
