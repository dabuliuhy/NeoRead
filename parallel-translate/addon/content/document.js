/* Independent adapter from Zotero's structured text to a continuous reading document. */
(function (root) {
  "use strict";
  const TYPES = new Set(["heading", "paragraph", "caption", "image", "math", "table", "note", "listitem", "preformatted"]);
  const visual = kind => ["image", "math", "table"].includes(kind);
  const textOf = node => typeof node?.text === "string" ? node.text : (node?.content || []).map(textOf).join("");
  const normalized = text => text.normalize('NFKC').replace(/\u00ad/g,'').replace(/\s+/g,' ').trim();
  const frontSection = source => /^(?:(?:key\s*words?|index\s+terms|abstract|highlights|graphical\s+abstract|article\s+(?:info(?:rmation)?|history))\s*(?:[:：]|$)|(?:1[.\s]*)?introduction\b|摘要|引言|关键词|关键字)/i.test(normalized(source));
  const citation = source => source.length < 260 && /\p{L}.*\s\d+(?:\s*\(\d+\))?\s*\((?:19|20)\d{2}[a-z]?\)\s*[eE]?\d+(?:\s*[-–—]\s*\d+)?\.?$/u.test(normalized(source));
  function marginal(row,pages) {
    return row.anchors.length && row.anchors.every(a=>{const v=pages[a.page-1].viewRect,h=v[3]-v[1];return a.rect[3]-a.rect[1]<h*.045&&(a.rect[1]>=v[1]+h*.9||a.rect[3]<=v[1]+h*.1);});
  }
  function firstPageMetadata(source, anchors, pages) {
    const view=pages[0]?.viewRect;
    if(!view || !anchors.length || anchors.some(a=>a.page!==1))return false;
    const h=view[3]-view[1],text=normalized(source);
    // Some PDF fonts map the copyright glyph to an accented O; require its words too.
    if(text.length<350 && /\b(?:19|20)\d{2}\b.*\ball rights reserved\b/i.test(text) && anchors.every(a=>a.rect[3]<view[1]+h*.4))return true;
    if(anchors.some(a=>a.rect[3]>view[1]+h*.25))return false;
    return /^(?:[\s*†‡⇑↟⁎∗\d.,-]*)(?:corresponding\s+author|correspondence\s+(?:to|address)|e[‐‑−-]?mail\s*(?:address(?:es)?)?\s*:|https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:|received\s+(?:\d|in\s+revised\s+form)|accepted\s+\d|available\s+online\s+\d|published\s+online\s+\d|copyright\b|©|\d{4}-[\dXx]{4}\s*\/\s*©)/i.test(text);
  }
  function classifyMetadata(rows,pages) {
    const marginRows=rows.filter(r=>!visual(r.kind)&&marginal(r,pages));
    const key=r=>normalized(r.source).replace(/^\d+\s+|\s+\d+$/g,'').toLowerCase();
    const repeated=new Map();
    for(const row of marginRows){const k=key(row);if(k.length<12)continue;if(!repeated.has(k))repeated.set(k,new Set());for(const a of row.anchors)repeated.get(k).add(a.page);}
    const publication=rows.filter(r=>citation(r.source)&&marginal(r,pages));
    const journalName=source=>publication.some(r=>normalized(r.source).toLowerCase().includes(normalized(source).toLowerCase()));
    const title=rows.find(r=>r.kind==='heading'&&r.node.flowClass!=='excluded'&&r.anchors.length===1&&r.anchors[0].page===1&&!frontSection(r.source)&&!citation(r.source)&&!journalName(r.source));
    for(const row of rows){
      if(visual(row.kind)||!row.source)continue;
      const first=row.anchors.length&&row.anchors.every(a=>a.page===1),view=pages[0]?.viewRect;
      // Native SDT can append a first-page masthead after the introduction. Geometry,
      // not native flow order or a bare word such as "journal", identifies that area.
      const masthead=title&&first&&row.anchors.every(a=>a.rect[1]>title.anchors[0].rect[3]+2&&a.rect[1]>view[1]+(view[3]-view[1])*.65);
      const headerEvidence=['excluded','auxiliary'].includes(row.node.flowClass)||/\bet al\.|\b[A-Z]\.\s*\p{L}/u.test(row.source)||normalized(row.source)===normalized(title?.source||'');
      const running=marginal(row,pages)&&(citation(row.source)||(row.kind==='paragraph'&&headerEvidence&&(repeated.get(key(row))?.size||0)>=2));
      if(masthead||running||firstPageMetadata(row.source,row.anchors,pages)){
        row.frontMatter=true;
        if(masthead||running)row.metadataKey=key(row);
      }
    }
  }
  function readingOrder(elements) {
    const metadata=elements.filter(b=>b.frontMatter);
    if(!metadata.length)return elements;
    const body=elements.filter(b=>!b.frontMatter);
    const at=body.findIndex(b=>b.page===1 && frontSection(b.source));
    if(at<0)return elements; // Do not guess placement in documents without a recognizable front section.
    metadata.sort((a,b)=>a.page-b.page||(b.anchors[0]?.rect[3]||0)-(a.anchors[0]?.rect[3]||0));
    return [...body.slice(0,at),...metadata,...body.slice(at)];
  }
  function joinText(left, right) {
    left = left.trimEnd(); right = right.trimStart();
    if (!left || !right) return left + right;
    if (/[\p{L}][\-\u00ad]$/u.test(left) && /^[a-z]/.test(right)) return left.slice(0, -1) + right;
    if (/[\u3400-\u9fff]$/.test(left) && /^[\u3400-\u9fff]/.test(right)) return left + right;
    return left + " " + right;
  }
  function anchorsOf(node, pages) {
    return (node.anchor?.pageRects || []).flatMap(value => {
      const [index, ...rect] = value;
      if (!Number.isInteger(index) || !pages[index] || rect.length !== 4 || !rect.every(Number.isFinite)) return [];
      const view = pages[index].viewRect;
      const box = [Math.max(view[0], rect[0]), Math.max(view[1], rect[1]), Math.min(view[2], rect[2]), Math.min(view[3], rect[3])];
      return box[2] > box[0] && box[3] > box[1] ? [{ page: index + 1, rect: box }] : [];
    });
  }
  function tableTextAnchors(node, pages) {
    const result = [];
    function visit(value) {
      if (typeof value.anchor?.textMap === "string") {
        try {
          for (const run of JSON.parse(value.anchor.textMap)) {
            if (Array.isArray(run) && run.length >= 6 && Number.isInteger(run[1]) && pages[run[1]] && run.slice(2,6).every(Number.isFinite)) result.push({page:run[1]+1,rect:run.slice(2,6)});
          }
        } catch (_) { /* Retain the native bounds when no reliable text geometry exists. */ }
      }
      for (const child of value.content || []) visit(child);
    }
    visit(node); return result;
  }
  function imageTextFragments(node, pages) {
    if (typeof node.text === "string" && node.text.trim()) return [{ source: node.text, anchors: tableTextAnchors(node, pages) }].filter(x => x.anchors.length);
    return (node.content || []).flatMap(child => imageTextFragments(child, pages));
  }
  function canContinue(left, right, pages, edgeBlocks, columns) {
    if(left.frontMatter || right.frontMatter)return false;
    if (left.kind !== "paragraph" || right.kind !== "paragraph") return false;
    const a = left.anchors.at(-1), b = right.anchors[0];
    if (!a || !b || b.page !== a.page + 1) return false;
    if (edgeBlocks.get(a.page)?.last !== left || edgeBlocks.get(b.page)?.first !== right) return false;
    const av = pages[a.page - 1].viewRect, bv = pages[b.page - 1].viewRect;
    if (a.rect[1] > av[1] + (av[3] - av[1]) * .23 || b.rect[3] < bv[3] - (bv[3] - bv[1]) * .23) return false;
    if (Math.abs((a.rect[0] - av[0]) - (b.rect[0] - bv[0])) > 12) {
      const ac = columns.get(a.page) || [], bc = columns.get(b.page) || [];
      const last = ac.at(-1), first = bc[0];
      // A two-column paper continues from the final column to the first column of the next page.
      if (ac.length < 2 || bc.length < 2 || Math.abs(a.rect[0] - last.x) > 8 || Math.abs(b.rect[0] - first.x) > 8 || Math.abs(last.width / first.width - 1) > .25) return false;
    }
    // Do not guess across a sentence ending, a heading, an indented new paragraph or a list marker.
    const end = left.source.trim().replace(/[\])}”’"']+$/u, "");
    return !/[.!?。！？:：;；]$/.test(end) && /^[a-z\u3400-\u9fff]/.test(right.source.trim());
  }
  function fromStructured(structure, logicalText, mathRules = []) {
    const pages = structure.catalog?.pages || [], raw = [], byRef = new Map();
    function visit(nodes, prefix = []) {
      (nodes || []).forEach((node, index) => {
        const ref = [...prefix, index];
        const anchors = anchorsOf(node, pages), source = textOf(node).trim();
        if (!TYPES.has(node.type)) { if (node.content&&node.flowClass!=='excluded') visit(node.content, ref); return; }
        if (!source && !visual(node.type)) return;
        const entry = { kind: node.type, source, anchors, ref, node, frontMatter:false };
        raw.push(entry); byRef.set(JSON.stringify(ref), entry);
      });
    }
    visit(structure.content);
    classifyMetadata(raw,pages);
    // Keep one copy of repeated marginal publication information with all source anchors.
    const seenMetadata=new Map();
    for(let i=raw.length-1;i>=0;i--)if(raw[i].node.flowClass==='excluded'&&!raw[i].frontMatter){byRef.delete(JSON.stringify(raw[i].ref));raw.splice(i,1);}
    for(let i=0;i<raw.length;i++){
      const row=raw[i],prior=row.metadataKey&&seenMetadata.get(row.metadataKey);
      if(prior){prior.anchors.push(...row.anchors);byRef.delete(JSON.stringify(row.ref));raw.splice(i--,1);}
      else if(row.metadataKey)seenMetadata.set(row.metadataKey,row);
    }
    // A union of explicit continuation links is cycle-safe and handles nested list-item refs.
    const parent = new Map(raw.map(row => [row, row]));
    function rootOf(row) { while (parent.get(row) !== row) row = parent.get(row); return row; }
    for (const row of raw) for (const ref of [row.node.previousPart, row.node.nextPart]) {
      const other = byRef.get(JSON.stringify(ref));
      if (other && other.kind === row.kind && !visual(row.kind) && other.frontMatter===row.frontMatter) parent.set(rootOf(other), rootOf(row));
    }
    const groups = new Map();
    for (const row of raw) { const root = rootOf(row); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(row); }
    const blocks = [...groups.values()].map(parts => ({
      kind: parts[0].kind, source: parts.length > 1 && logicalText ? logicalText(structure, parts[0].ref) : parts.map(p => p.source).reduce(joinText, ""),
      anchors: parts.flatMap(p => p.anchors), joinedBy: parts.length > 1 ? "parser" : undefined,
      ...(parts[0].frontMatter ? {frontMatter:true} : {}),
      ...(parts[0].kind === "table" ? {textAnchors:parts.flatMap(p=>tableTextAnchors(p.node,pages))} : {}),
      ...(parts[0].kind === "image" && parts[0].anchors[0]?.page === 1 ? {textFragments:parts.flatMap(p=>imageTextFragments(p.node,pages))} : {}),
      ...(parts[0].kind === "math" ? {formula:(root.ParallelMath || (typeof require==="function"?require("./math.js"):null))?.recognize({content:parts.map(p=>p.node)}, {rules:mathRules[(parts[0].anchors[0]?.page||1)-1]||[]})} : {}),
      inlineMath:parts.flatMap(p=>(root.ParallelMath || (typeof require==='function'?require('./math.js'):null))?.inline(p.node)||[]),
      level: parts[0].kind === "heading" ? (parts[0] === raw[0] ? 1 : 2) : undefined
    }));
    const edges = new Map(), columns = new Map();
    for (const block of blocks) if (!block.frontMatter && (block.kind === "paragraph" || block.kind === "heading" || block.kind === "listitem")) {
      for (const page of new Set(block.anchors.map(a => a.page))) {
        const edge = edges.get(page) || { first: block }; edge.last = block; edges.set(page, edge);
      }
      if (block.kind === "paragraph") for (const anchor of block.anchors) {
        const groups = columns.get(anchor.page) || [], width = anchor.rect[2] - anchor.rect[0];
        const group = groups.find(c => Math.abs(c.x - anchor.rect[0]) <= 8);
        if (group) group.width = Math.max(group.width, width); else groups.push({ x: anchor.rect[0], width });
        columns.set(anchor.page, groups.sort((a, b) => a.x - b.x));
      }
    }
    const merged = [], consumed = new Set();
    for (const block of blocks) {
      if (consumed.has(block)) continue;
      const result = { ...block, anchors: [...block.anchors] }; let tail = block;
      while (true) {
        const next = edges.get(tail.anchors.at(-1)?.page + 1)?.first;
        if (!next || consumed.has(next) || !canContinue(tail, next, pages, edges, columns)) break;
        consumed.add(next); result.source = joinText(result.source, next.source); result.anchors.push(...next.anchors);
        result.inlineMath=[...(result.inlineMath||[]),...(next.inlineMath||[])];
        result.joinedBy = result.joinedBy === "parser" ? "parser+boundary" : "boundary"; tail = next;
      }
      merged.push(result);
    }
    return merged.map((block, index) => ({ ...block, source: block.source.replace(/\u00ad/g, ""), id: "p" + String(index + 1).padStart(5, "0"), page: block.anchors[0]?.page || 1 }));
  }
  function elements(job) {
    if (Number.isInteger(job.readerRevision) && Array.isArray(job.structure)) return job.structure;
    return readingOrder(job.structure || job.blocks.map(block => ({ ...block, kind: "paragraph", partIDs: [block.id] })));
  }
  function presentation(element, parts) {
    const blocks = (element.partIDs || []).map(id => parts.get(id)).filter(Boolean);
    // A translatable element that produced no translation parts must still show
    // its source text, never a blank target line. Only visual blocks (figures,
    // tables, formulas) legitimately render nothing in the text column.
    if (!blocks.length) {
      const fallback = element.noTranslate || !visual(element.kind) ? element.source || "" : "";
      return { status: "complete", text: fallback, error: "", original: Boolean(element.noTranslate) };
    }
    return {
      status: blocks.every(b => b.status === "complete") ? "complete" : blocks.some(b => b.status === "failed") ? "failed" : blocks.some(b => b.status === "running") ? "running" : "pending",
      text: blocks.map(b => b.target || b.source).reduce(joinText, ""),
      error: blocks.find(b => b.error)?.error || ""
    };
  }
  // Figure/table cards use the canonical pairs resolved by asset-layout.
  function figureGroups(list) {
    const groups = new Map(), byID = new Map(list.map(e => [e.id, e]));
    for (const e of list) if (e.captionIDs?.length) { groups.set(e.id, e.id); for (const id of e.captionIDs) if (byID.has(id)) groups.set(id, e.id); }
    for (const e of list) if (e.assetID && byID.has(e.assetID)) groups.set(e.id, e.assetID);
    // Pairing is resolved once from source geometry before reflow. Adjacency in
    // the translated flow is not evidence: its neighbours may be on other pages.
    return groups;
  }
  const api = { fromStructured, elements, presentation, joinText, visual, readingOrder, figureGroups,textOf };
  if (typeof module !== "undefined") module.exports = api;
  root.ParallelDocument = api;
})(typeof module !== "undefined" && module.exports ? globalThis : this);
