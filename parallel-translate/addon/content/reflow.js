/* Text-flow reconstruction after structure extraction and figure pairing.
   Joins sentences broken by columns, pages and floats; anchors floats near their first mention;
   marks reference lists, statements, footnotes and publication metadata as untranslated. */
(function (root) {
  "use strict";
  const R = root.ParallelReferences || (typeof require === "function" ? require("./references.js") : null);
  const D = root.ParallelDocument || (typeof require === "function" ? require("./document.js") : null);
  const A = root.ParallelAssetLayout || (typeof require === "function" ? require("./asset-layout.js") : null);
  const plain = value => String(value || "").replace(/\s+/g, " ").trim();
  const TEXT = new Set(["paragraph", "listitem"]);
  const FLOAT = new Set(["image", "table", "caption"]);
  const REF_HEAD = /^(?:[\dIVX]+\.?\s*)?(?:references?(?:\s+and\s+notes)?|bibliography|literature\s+cited|works\s+cited|cited\s+literature|参考文献|引用文献)\s*[:：]?$/i;
  const END_HEAD = /^(?:(?:[A-Z]|\d+)[.:]?\s+)?(?:appendix|appendices|supplementary|supporting\s+information|附录)/i;
  const SKIP_HEAD = /^(?:\d+\.?\s*)?(?:credit\s+authorship\s+contribution\s+statement|authors?['’]?\s*contributions?|author\s+contributions?(?:\s+statement)?|declaration\s+of\s+(?:competing|conflicting)\s+interests?|competing\s+interests?|conflicts?\s+of\s+interests?|declaration\s+of\s+interests?|data\s+availability(?:\s+statement)?|availability\s+of\s+data(?:\s+and\s+materials?)?|code\s+availability|declaration\s+of\s+generative\s+ai.*|ethics\s+declarations?|consent\s+for\s+publication|ethical\s+approval.*|ethics\s+approval.*)\s*[:：]?$/i;
  const firstAnchor = e => e.anchors?.[0], lastAnchor = e => e.anchors?.[e.anchors.length - 1];
  const passive = e => e.frontMatter || e.footnote;
  function columnBreak(left, right) {
    const a = lastAnchor(left), b = firstAnchor(right);
    if (!a || !b) return false;
    if (a.page !== b.page) return true;
    return Math.abs(a.rect[0] - b.rect[0]) > 60 || b.rect[3] > a.rect[3] + 4;
  }
  function continues(left, right, crossed) {
    if (!TEXT.has(left.kind) || right.kind !== "paragraph" || left.noTranslate || right.noTranslate || left.reference || right.reference || passive(left) || passive(right)) return false;
    const end = plain(left.source).replace(/[\])}”’"'\s]+$/u, ""), start = plain(right.source);
    if (!end || !start || /[.!?。！？:：;；]$/.test(end)) return false;
    const cjk = /[\u3400-\u9fff]$/.test(end) && /^[\u3400-\u9fff]/.test(start);
    const dangling = /\b(?:a|an|the|of|in|on|at|to|for|with|by|from|and|or|nor|among|between|into|onto|over|under|that|which|whose|as|via|than|is|are|was|were|be|been|this|these|those|its|their|our|such|both|either|using|named|called)$/i.test(end);
    if (!cjk && !/^\p{Ll}/u.test(start) && !(dangling && /^[\p{Lu}\d]/u.test(start))) return false;
    // First-page affiliations start with a lowercase superscript marker: "a Institute of …".
    if (right.page === 1 && /^[a-z](?:,[a-z])*\s+(?:\p{Lu}|\d)/u.test(start)) return false;
    if (crossed || columnBreak(left, right)) return true;
    const a = lastAnchor(left), b = firstAnchor(right), gap = a && b ? a.rect[1] - b.rect[3] : Infinity;
    return gap >= -4 && gap <= 40;
  }
  function viewOf(views, page) { return views?.[page - 1] || [0, 0, 595, 842]; }
  function footnote(e, views) {
    if (!TEXT.has(e.kind) || e.frontMatter || !e.anchors?.length) return false;
    const text = plain(e.source);
    if (text.length > 500) return false;
    const low = e.anchors.every(a => { const v = viewOf(views, a.page); return a.rect[3] < v[1] + (v[3] - v[1]) * .11; });
    return low && /^(?:[*†‡§¶#]|\d{1,2}\s*(?=\p{Lu})|[a-z]\s+(?=\p{Lu}))/u.test(text) && /(?:https?:\/\/|www\.|e-?mail|@\w|present\s+address|contributed\s+equally|equal\s+contribution|corresponding|available\s+(?:at|online)|github\.com|accessed)/i.test(text);
  }
  function heading(e) { return e.kind === "heading" || (e.kind === "paragraph" && plain(e.source).length < 40 && REF_HEAD.test(plain(e.source))); }
  function references(elements, report) {
    const at = elements.findIndex(e => heading(e) && REF_HEAD.test(plain(e.source)));
    if (at < 0) return elements;
    let end = at + 1;
    while (end < elements.length && !(elements[end].kind === "heading" && !/^\[\d+\]/.test(plain(elements[end].source)) && (END_HEAD.test(plain(elements[end].source)) || !R.parse(elements[end].source).year))) end++;
    const region = elements.slice(at + 1, end), texts = region.filter(e => TEXT.has(e.kind) || e.kind === "note" || e.kind === "heading"), others = region.filter(e => !texts.includes(e));
    const pieces = [];
    for (const e of texts) R.split(e.source).forEach((source, k) => pieces.push({ base: e, source, k }));
    const numbered = pieces.filter(p => R.label(p.source).number != null).length >= pieces.length * .6;
    const entries = [];
    for (const p of pieces) {
      const prev = entries[entries.length - 1], number = R.label(p.source).number;
      const tail = prev && (numbered ? number == null : /^\p{Ll}/u.test(p.source) && !/\.$/.test(prev.source));
      if (tail) { prev.source = D.joinText(prev.source, p.source); for (const a of p.base.anchors || []) if (!prev.anchors.some(b => JSON.stringify(b) === JSON.stringify(a))) prev.anchors.push(a); continue; }
      const entry = { ...p.base, id: p.k ? p.base.id + "r" + p.k : p.base.id, kind: "reference", source: p.source, anchors: [...(p.base.anchors || [])], inlineMath: [], noTranslate: true, skipReason: "reference" };
      delete entry.level; delete entry.frontMatter; entries.push(entry);
    }
    for (const e of entries) e.reference = R.parse(e.source);
    elements[at].section = "references";
    report.references = entries.length;
    return [...elements.slice(0, at + 1), ...entries, ...others, ...elements.slice(end)];
  }
  function statements(elements, report) {
    let skip = false;
    for (const e of elements) {
      if (e.kind === "heading") { skip = SKIP_HEAD.test(plain(e.source)); continue; }
      if (skip && (TEXT.has(e.kind) || e.kind === "note")) { e.noTranslate = true; e.skipReason = "statement"; report.skipped++; }
    }
  }
  // Sub-figure labels ("(b) Cross-modal self-attention module") are printed inside
  // a figure, not as body text. They never get translated on their own: a short
  // label joins the caption of its figure card, a bare "(a)" is dropped.
  const SUB_LABEL = /^\s*(?:\(\s*[a-hA-H]\s*\)|[a-hA-H]\s*[).])(?:\s+\S.*)?$/;
  const prose = text => plain(text).split(" ").length > 14 || /[.。!?！？;；]$/.test(plain(text));
  // A label whose centre lies inside an image box is part of the rendered picture.
  function insideImage(e, byID, elements) {
    const a = firstAnchor(e);
    if (!a) return null;
    const x = (a.rect[0] + a.rect[2]) / 2, y = (a.rect[1] + a.rect[3]) / 2;
    return elements.find(n => n.kind === "image" && n !== e && (n.anchors || []).some(b => b.page === a.page && x >= b.rect[0] - 6 && x <= b.rect[2] + 6 && y >= b.rect[1] - 6 && y <= b.rect[3] + 6)) || null;
  }
  function subLabels(elements, report) {
    const byID = new Map(elements.map(e => [e.id, e]));
    const label = e => (TEXT.has(e.kind) || e.kind === "caption") && plain(e.source).length <= 120 && SUB_LABEL.test(plain(e.source)) && !prose(e.source);
    const drop = new Set();
    for (let i = 0; i < elements.length; i++) {
      const e = elements[i];
      if (SUB_LABEL.test(plain(e.source)) && insideImage(e, byID, elements)) { drop.add(e.id); report.labels++; continue; }
      if (!label(e)) continue;
      const bare = plain(e.source).length < 12;
      if (!bare && (e.kind === "caption" || e.assetID)) {
        const asset = byID.get(e.assetID);
        const titled = asset && (asset.captionIDs || []).some(id => id !== e.id && /^(?:Fig(?:ure)?\.?|图)\s*\d/i.test(plain(byID.get(id)?.source)));
        if (titled && insideImage(e, byID, elements)) { drop.add(e.id); report.labels = (report.labels || 0) + 1; }
        continue;
      }
      if (insideImage(e, byID, elements)) { drop.add(e.id); report.labels = (report.labels || 0) + 1; continue; }
      const neighbour = elements.slice(Math.max(0, i - 2), i + 3).find(n => n !== e && n.kind === "caption" && n.assetID && SUB_LABEL.test(plain(n.source)));
      if (bare) { elements[i] = { ...e, noTranslate: true, skipReason: "label", source: plain(e.source) }; report.labels = (report.labels || 0) + 1; continue; }
      if (neighbour) {
        const asset = byID.get(neighbour.assetID);
        const merged = { ...e, kind: "caption", assetID: neighbour.assetID, noTranslate: false, skipReason: undefined };
        delete merged.skipReason;
        elements[i] = merged;
        if (asset) asset.captionIDs = [...new Set([...(asset.captionIDs || []), e.id])];
        report.merged++;
        continue;
      }
      elements[i] = { ...e, noTranslate: true, skipReason: "label" };
      report.labels = (report.labels || 0) + 1;
    }
    if (drop.size) {
      for (const e of elements) if (e.captionIDs?.length) e.captionIDs = e.captionIDs.filter(id => !drop.has(id));
      return elements.filter(e => !drop.has(e.id));
    }
    return elements;
  }

  function reflow(input, views = []) {
    const report = { merged: 0, movedFloats: 0, references: 0, skipped: 0, footnotes: 0, metadata: 0, labels: 0 };
    let elements = (input || []).map(e => ({ ...e, anchors: (e.anchors || []).map(a => ({ ...a, rect: [...a.rect] })) }));
    let bodyTail = null;
    for (const e of elements) {
      if (e.kind === "caption" && !A.label(e.source) && !SUB_LABEL.test(plain(e.source)) && bodyTail && /[-‐‑]\s*$/.test(bodyTail.source) && /^\p{Ll}/u.test(plain(e.source))) {
        e.kind = "paragraph"; delete e.assetID;
        for (const asset of elements) if (asset.captionIDs?.includes(e.id)) asset.captionIDs = asset.captionIDs.filter(id => id !== e.id);
      }
      if (TEXT.has(e.kind)) bodyTail = e;
      else if (!FLOAT.has(e.kind)) bodyTail = null;
    }
    for (const e of elements) {
      if (e.frontMatter && e.kind !== "heading") { e.noTranslate = true; e.skipReason = "metadata"; report.metadata++; }
      else if (footnote(e, views)) { e.footnote = true; e.kind = "note"; e.noTranslate = true; e.skipReason = "footnote"; report.footnotes++; }
    }
    elements = references(elements, report);
    elements = subLabels(elements, report);
    statements(elements, report);
    const units = [], groups = new Map();
    for (const e of elements) {
      if (FLOAT.has(e.kind)) {
        const key = e.assetID || e.id;
        let unit = groups.get(key);
        if (!unit) { unit = { float: true, items: [] }; groups.set(key, unit); units.push(unit); }
        unit.items.push(e); continue;
      }
      units.push({ float: false, items: [e] });
    }
    const flow = [], floats = [];
    let previous = null, crossed = false;
    for (const unit of units) {
      if (unit.float) { unit.after = previous; floats.push(unit); crossed = true; continue; }
      unit.floatBefore = crossed; crossed = false; previous = unit; flow.push(unit);
    }
    for (let i = 0; i < flow.length; i++) {
      const left = flow[i].items[0];
      let j = i + 1, floatBetween = false;
      while (j < flow.length && passive(flow[j].items[0])) { floatBetween ||= flow[j].floatBefore; j++; }
      if (j >= flow.length) continue;
      const right = flow[j].items[0];
      floatBetween ||= flow[j].floatBefore;
      if (!continues(left, right, floatBetween)) continue;
      left.source = D.joinText(left.source, right.source);
      left.anchors = [...left.anchors, ...right.anchors];
      left.inlineMath = [...(left.inlineMath || []), ...(right.inlineMath || [])];
      left.joinedBy = left.joinedBy ? left.joinedBy + "+reflow" : "reflow";
      for (const unit of floats) if (unit.after === flow[j]) unit.after = flow[i];
      flow.splice(j, 1); report.merged++; i--;
    }
    const firstMentions = new Map(), assets = A.index(elements);
    for (const unit of flow) {
      const e = unit.items[0];
      if (!TEXT.has(e.kind) || e.noTranslate || passive(e)) continue;
      for (const span of A.mentions(e.source)) for (const key of span.keys) if (!firstMentions.has(key)) firstMentions.set(key, unit);
    }
    const assetKeys = new Map([...assets].map(([key, entry]) => [entry.asset.id, key]));
    for (const unit of floats) {
      const asset = unit.items.find(e => assetKeys.has(e.id)), target = asset && firstMentions.get(assetKeys.get(asset.id));
      if (asset) {
        const captions = unit.items.filter(e => e !== asset);
        unit.items = asset.captionPlacement === "before" ? [...captions, asset] : [asset, ...captions];
      }
      if (target) { asset.mentionID = target.items[0].id; if (target !== unit.after) { unit.after = target; report.movedFloats++; } }
    }
    const output = [], placed = new Map();
    for (const unit of floats) { const key = unit.after || null; if (!placed.has(key)) placed.set(key, []); placed.get(key).push(unit); }
    for (const unit of placed.get(null) || []) output.push(...unit.items);
    for (const unit of flow) { output.push(...unit.items); for (const f of placed.get(unit) || []) output.push(...f.items); }
    for (const e of output) e.page = firstAnchor(e)?.page || e.page;
    return { elements: output, report };
  }
  const api = { reflow, continues, footnote, subLabels };
  if (typeof module !== "undefined") module.exports = api;
  root.ParallelReflow = api;
})(typeof module !== "undefined" && module.exports ? globalThis : this);
