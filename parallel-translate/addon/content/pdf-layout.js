/* Pure geometry/text matching. Keep numbers and punctuation when locating source text. */
(function (root) {
  "use strict";
  function canonical(text) { return String(text).normalize("NFKC").replace(/[\s\u00ad]/gu, ""); }
  function validRect(rect) { return Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1]; }
  function union(rects) { return [Math.min(...rects.map(r => r[0])), Math.min(...rects.map(r => r[1])), Math.max(...rects.map(r => r[2])), Math.max(...rects.map(r => r[3]))]; }
  function clamp(rect, bounds, padding = 0) {
    const r = [Math.max(bounds[0], rect[0] - padding), Math.max(bounds[1], rect[1] - padding), Math.min(bounds[2], rect[2] + padding), Math.min(bounds[3], rect[3] + padding)];
    return validRect(r) ? r : null;
  }
  function lineRects(chars) {
    const lines = []; let current = [];
    const flush = () => { if (current.length) lines.push(union(current)); current = []; };
    for (const char of chars) {
      if (!char.ignorable && validRect(char.rect)) {
        if (current.length) {
          const last = current[current.length - 1], height = Math.max(last[3] - last[1], char.rect[3] - char.rect[1]);
          if (Math.abs((last[1] + last[3] - char.rect[1] - char.rect[3]) / 2) > height * 0.7 || char.rect[0] - last[2] > height * 5) flush();
        }
        current.push(char.rect);
      }
      if (char.lineBreakAfter || char.paragraphBreakAfter) flush();
    }
    flush(); return lines;
  }
  function clusters(lines) {
    const groups = [];
    for (const line of lines) {
      const prev = groups[groups.length - 1];
      if (prev) {
        const overlap = Math.min(prev[2], line[2]) - Math.max(prev[0], line[0]);
        const narrow = Math.min(prev[2] - prev[0], line[2] - line[0]);
        const gap = Math.max(prev[1] - line[3], line[1] - prev[3], 0);
        if (overlap > narrow * 0.2 && gap < Math.max(28, (line[3] - line[1]) * 3)) { groups[groups.length - 1] = union([prev, line]); continue; }
      }
      groups.push([...line]);
    }
    return groups;
  }
  function locateBlocks(blocks, chars, viewBox) {
    if (!validRect(viewBox) || !Array.isArray(chars)) throw new Error("PDF 页面缺少有效坐标");
    let text = ""; const owners = [];
    chars.forEach((char, index) => {
      if (char.ignorable) return;
      const normalized = canonical(char.c || "");
      text += normalized;
      // JavaScript indexOf indexes UTF-16 code units, including surrogate pairs.
      for (let n = 0; n < normalized.length; n++) owners.push(index);
    });
    let cursor = 0; const result = new Map(), occupied = [];
    for (const block of blocks) {
      const needle = canonical(block.source);
      if (!needle) { result.set(block.id, { status: "unmatched", reason: "原文为空" }); continue; }
      let start = text.indexOf(needle, cursor);
      if (start < 0) {
        const anywhere = text.indexOf(needle);
        if (anywhere >= 0 && text.indexOf(needle, anywhere + 1) < 0) start = anywhere;
      }
      if (start < 0) { result.set(block.id, { status: "unmatched", reason: "未能可靠匹配 PDF 文字，请查看整页或原文文本" }); continue; }
      if (occupied.some(([a, b]) => start < b && start + needle.length > a)) {
        result.set(block.id, { status: "unmatched", reason: "文字与另一段位置重复，未自动定位" }); continue;
      }
      const from = owners[start], to = owners[start + needle.length - 1];
      const matched = chars.slice(from, to + 1);
      const visible = matched.filter(c => !c.ignorable && canonical(c.c || ""));
      if (visible.some(c => !validRect(c.rect))) { result.set(block.id, { status: "unmatched", reason: "部分文字缺少有效坐标" }); continue; }
      const lines = lineRects(matched);
      const rects = clusters(lines).map(rect => clamp(rect, viewBox, 4)).filter(Boolean);
      if (!rects.length) { result.set(block.id, { status: "unmatched", reason: "没有可显示的 PDF 区域" }); continue; }
      result.set(block.id, { status: "matched", rects, lines, charStart: from, charEnd: to + 1 });
      occupied.push([start, start + needle.length]); cursor = Math.max(cursor, start + needle.length);
    }
    return result;
  }
  // PDF.js applies page rotation, crop-box origins and UserUnit through this transform.
  function viewportRect(rect, viewport) {
    const r = viewport.convertToViewportRectangle(rect);
    return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  }
  const api = { canonical, validRect, union, clamp, lineRects, clusters, locateBlocks, viewportRect };
  if (typeof module !== "undefined") module.exports = api;
  root.ParallelPDFLayout = api;
})(typeof module !== "undefined" && module.exports ? globalThis : this);
