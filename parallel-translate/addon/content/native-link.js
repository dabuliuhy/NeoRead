/* Independent links between our logical paragraphs and Zotero's unmodified SDT DOM. */
(function (root) {
  "use strict";
  const kinds = new Set(["heading", "paragraph", "caption", "image", "math", "table", "note", "listitem", "preformatted"]);
  function index(structure) {
    const entries = [];
    function visit(nodes, prefix = []) {
      (nodes || []).forEach((node, i) => {
        if (node.flowClass === "excluded") return;
        const ref = [...prefix, i];
        if (kinds.has(node.type)) entries.push({ ref:ref.join("."), kind:node.type, anchors:(node.anchor?.pageRects || []).map(([page, ...rect]) => ({page:page+1,rect})) });
        else visit(node.content, ref);
      });
    }
    visit(structure.content); return entries;
  }
  function overlap(a, b) {
    const area = r => Math.max(0,r[2]-r[0]) * Math.max(0,r[3]-r[1]);
    const intersection = area([Math.max(a[0],b[0]),Math.max(a[1],b[1]),Math.min(a[2],b[2]),Math.min(a[3],b[3])]);
    return intersection / Math.max(1, Math.min(area(a),area(b)));
  }
  function link(elements, structure) {
    const entries = index(structure), links = new Map();
    const candidates = new Map();
    for (const entry of entries) for (const anchor of entry.anchors) {
      const key=entry.kind+":"+anchor.page;
      if(!candidates.has(key))candidates.set(key,[]);
      candidates.get(key).push({entry,source:anchor});
    }
    for (const block of elements) {
      const matches = [];
      for (const anchor of block.anchors || []) {
        let best, score = 0;
        for (const {entry,source} of candidates.get(block.kind+":"+anchor.page)||[]) {
            const ratio = overlap(anchor.rect, source.rect);
            if (ratio > .55 && ratio > score) { score = ratio; best = {ref:entry.ref,page:anchor.page,rect:source.rect}; }
        }
        if (best && !matches.some(m => m.ref === best.ref)) matches.push(best);
      }
      links.set(block.id, matches);
    }
    // Recovered figures absent from native Reading Mode link to their actual captions.
    for (const block of elements) if (!links.get(block.id).length) {
      const related = block.captionIDs || (block.assetID ? [block.assetID] : []);
      const target = related.flatMap(id => links.get(id) || []);
      if (target.length) links.set(block.id, target.map(t => ({...t,captionFallback:true})));
    }
    return links;
  }
  // Rows must be in vertical DOM order, with no overlapping siblings. Locate the
  // viewport centre without forcing geometry reads for every paragraph on every frame.
  function nearest(nodes,top,bottom){
    const center=(top+bottom)/2;let low=0,high=nodes.length;
    const rects=new Map(),rect=i=>{if(!rects.has(i))rects.set(i,nodes[i].getBoundingClientRect());return rects.get(i);};
    while(low<high){const mid=(low+high)>>1;if(rect(mid).bottom<center)low=mid+1;else high=mid;}
    let best,distance=Infinity;
    for(let i=Math.max(0,low-1);i<Math.min(nodes.length,low+2);i++){
      const r=rect(i);if(!r.height||r.bottom<top||r.top>bottom)continue;
      const d=Math.abs((r.top+r.bottom)/2-center);
      if(d<distance){distance=d;best={node:nodes[i],fraction:Math.max(0,Math.min(1,(center-r.top)/r.height))};}
    }
    return best;
  }
  const api = {index,link,nearest};
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ParallelNativeLink = api;
})(this);
