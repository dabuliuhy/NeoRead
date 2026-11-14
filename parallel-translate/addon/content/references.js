/* Reference-list parsing, inline citation matching and public-metadata normalization. Pure functions only. */
(function (root) {
  "use strict";
  const plain = value => String(value || "").replace(/[\u00ad]/g, "").replace(/\s+/g, " ").trim();
  const PARTICLES = new Set(["and", "et", "al", "al.", "van", "von", "der", "den", "de", "del", "della", "da", "di", "du", "dos", "das", "le", "la", "y", "zu", "ten", "ter", "&"]);
  const INITIALS = /^\p{Lu}(?:[.\-‐]{0,2}\s?\p{Lu}){0,3}$/u;
  function label(text) {
    const value = plain(text);
    let m = value.match(/^\[(\d{1,4})\]\s*/);
    if (m) return { number: Number(m[1]), style: "bracket", body: value.slice(m[0].length) };
    m = value.match(/^(\d{1,4})\.\s+(?=\S)/);
    if (m) return { number: Number(m[1]), style: "dot", body: value.slice(m[0].length) };
    m = value.match(/^\((\d{1,4})\)\s+/);
    if (m) return { number: Number(m[1]), style: "paren", body: value.slice(m[0].length) };
    return { number: null, style: "", body: value };
  }
  // One PDF block can hold several entries; split only at markers that keep a sequence.
  function split(text) {
    const value = plain(text), first = label(value);
    if (first.style === "bracket") {
      const parts = value.split(/\s+(?=\[\d{1,4}\]\s)/);
      return parts.length > 1 ? parts : [value];
    }
    if (first.style === "dot") {
      const out = []; let start = 0, expected = first.number + 1;
      const re = /\s(\d{1,4})\.\s+(?=\p{Lu})/gu; let m;
      while ((m = re.exec(value))) {
        if (Number(m[1]) !== expected) continue;
        out.push(value.slice(start, m.index).trim()); start = m.index + 1; expected++;
      }
      out.push(value.slice(start).trim());
      return out.filter(Boolean);
    }
    return [value];
  }
  function separator(word) {
    if (/^\((?:19|20)\d{2}[a-z]?\)[.,:]?$/.test(word)) return true;
    if (/^(?:19|20)\d{2}[a-z]?[.:]$/.test(word)) return true;
    if (/^al\.[,:]?$/.test(word)) return true;
    const core = word.replace(/,$/, "");
    if (!/[.:]$/.test(core)) return false;
    return INITIALS.test(core.replace(/[.:]+$/, ""));
  }
  function doiOf(text) {
    const value = String(text || "").replace(/(10\.\d{4,9})\s*\/\s*/g, "$1/");
    const m = value.match(/\b10\.\d{4,9}\/[^\s"<>〉〈\]]+/i);
    if (!m) return "";
    let doi = m[0].replace(/[.,;]+$/, "");
    while (doi.endsWith(")") && (doi.match(/\)/g) || []).length > (doi.match(/\(/g) || []).length) doi = doi.slice(0, -1).replace(/[.,;]+$/, "");
    return doi.toLowerCase();
  }
  function arxivID(text) {
    return (String(text || "").match(/(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/|10\.48550\/arxiv\.)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?)/i) || [])[1]?.replace(/v\d+$/i, "").toLowerCase() || "";
  }
  const evidenceText = value => plain(value).normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  function modelFields(text, ref) {
    let value;
    try { value = JSON.parse(String(text).replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "")); }
    catch (_) { throw new Error("参考文献解析未返回有效 JSON，请重试。"); }
    if (!value || Array.isArray(value) || (value.title != null && typeof value.title !== "string") || !Array.isArray(value.authors) || value.authors.some(a => typeof a !== "string")) throw new Error("参考文献解析格式不正确，请重试。");
    const raw = evidenceText(ref.raw), supported = value => value && raw.includes(evidenceText(value));
    const title = plain(value.title).slice(0, 1000), year = String(value.year || "");
    return { title: title.length > 2 && supported(title) ? title : "", authors: value.authors.map(plain).filter(a => a.length < 200 && supported(a)).slice(0, 100),
      year: /^(?:18|19|20|21)\d{2}$/.test(year) && new RegExp("\\b" + year + "[a-z]?\\b").test(ref.raw) ? year : "" };
  }
  function names(text) {
    let value = plain(text).replace(/\(\s*(?:19|20)\d{2}[a-z]?\s*\)[.,]?\s*$/, "").replace(/[.,:;\s]+$/, "");
    const etal = /\bet\s*al\.?$/i.test(value);
    value = value.replace(/,?\s*\bet\s*al\.?$/i, "");
    const parts = value.split(/\s*(?:;|,\s*(?:and|&)\s+|\s+and\s+|\s*&\s*|,)\s*/).map(s => s.trim()).filter(Boolean);
    const out = [];
    for (const part of parts) {
      if (out.length && INITIALS.test(part.replace(/[.\s]+/g, "")) && !/\s/.test(out[out.length - 1])) out[out.length - 1] += " " + part;
      else out.push(part);
    }
    if (etal) out.push("et al.");
    return out.slice(0, 40);
  }
  function surname(name) {
    const tokens = plain(name).split(/[\s,]+/).filter(Boolean), words = tokens.filter(t => !INITIALS.test(t.replace(/\./g, "")) && !PARTICLES.has(t.toLowerCase()));
    if (!words.length) return "";
    const surnameFirst = !INITIALS.test(tokens[0].replace(/\./g, "")) && tokens.some(t => INITIALS.test(t.replace(/\./g, "")));
    return (surnameFirst ? words[0] : words[words.length - 1]).replace(/[^\p{L}'’\-]/gu, "");
  }
  function parse(raw) {
    const { number, body } = label(raw);
    const text = plain(body), doi = doiOf(text);
    const url = (text.match(/https?:\/\/[^\s<>〉]+/i) || [""])[0].replace(/[.,;]+$/, "");
    let authors = "", title = "", rest = "";
    const quoted = text.match(/[“"]([^”"]{6,}?)[,.]?[”"]/);
    if (quoted) { authors = text.slice(0, quoted.index); title = quoted[1]; rest = text.slice(quoted.index + quoted[0].length); }
    else {
      const words = []; const re = /\S+/g; let m;
      while ((m = re.exec(text))) words.push({ w: m[0], at: m.index, end: m.index + m[0].length });
      let first = -1;
      for (let i = 0; i < words.length; i++) {
        const w = words[i].w.replace(/^[(\[“"'‘]+/, "");
        if (/^\p{Ll}/u.test(w) && !PARTICLES.has(w.replace(/[.,;:]+$/, ""))) { first = i; break; }
      }
      let start = -1;
      for (let i = first - 1; i >= 0; i--) if (separator(words[i].w)) { start = i + 1; break; }
      if (first >= 0 && start > 0) {
        authors = text.slice(0, words[start].at);
        let end = words.length - 1;
        for (let k = Math.max(start, first); k < words.length; k++) {
          const w = words[k].w;
          if (/[.?!]$/.test(w) && !/^(?:e\.g|i\.e|vs|al|Fig|Eq|no|vol|pp)\.$/i.test(w) && !INITIALS.test(w.replace(/\.$/, ""))) { end = k; break; }
        }
        title = text.slice(words[start].at, words[end].end); rest = text.slice(words[end].end);
      } else if (/[\u3400-\u9fff]/.test(text)) {
        const segments = text.split(/[.．。]\s*/);
        authors = segments[0] || ""; title = segments[1] || ""; rest = segments.slice(2).join(". ");
      } else rest = text;
    }
    title = plain(title).replace(/\[[A-Z/]{1,4}\]/g, "").replace(/[.,;:\s]+$/, "").slice(0, 400);
    const year = ((text.match(/\(((?:19|20)\d{2})[a-z]?\)/) || rest.match(/\b((?:19|20)\d{2})[a-z]?\b/) || text.match(/\b((?:19|20)\d{2})[a-z]?\b/) || [])[1]) || "";
    const venue = plain(rest.replace(/^[\s.,;:]+/, "").split(/(?:\b(?:19|20)\d{2}\b|\s\d+\s*[,:(;]|[,;]?\s*pp?\.\s*\d|https?:|doi)/i)[0]).replace(/[.,;:(\s]+$/, "").slice(0, 160);
    const people = names(authors);
    return { number, raw: plain(raw), authors: people, title, year, venue, doi, url, surname: surname(people[0] || "") };
  }
  function expand(inner) {
    const numbers = [];
    for (const piece of inner.trim().split(/\s*[,，、;；]\s*/)) {
      const range = piece.match(/^(\d{1,4})\s*[-–—−~～]\s*(\d{1,4})$/);
      if (range) { const a = Number(range[1]), b = Number(range[2]); if (b >= a && b - a <= 60) for (let n = a; n <= b; n++) numbers.push(n); }
      else if (/^\d{1,4}$/.test(piece)) numbers.push(Number(piece));
    }
    return numbers;
  }
  // Returns citation spans in display text. `index` has numbered entries or surname|year keys.
  function citations(text, index) {
    const out = [];
    if (!index || !index.size || !text) return out;
    let m;
    if (index.numbered) {
      const numeric = /[\[［【](\s*\d{1,4}(?:\s*(?:[-–—−~～]|[,，、;；])\s*\d{1,4})*\s*)[\]］】]/g;
      while ((m = numeric.exec(text))) {
        const keys = expand(m[1]).filter(n => index.has(String(n))).map(String);
        if (keys.length) out.push({ start: m.index, end: m.index + m[0].length, keys });
      }
      return out;
    }
    const authorYear = /(\p{Lu}[\p{L}'’\-]+)(?:\s*(?:et\s+al\.?|等人?|and\s+\p{Lu}[\p{L}'’\-]+|&\s*\p{Lu}[\p{L}'’\-]+|和\s*\p{Lu}[\p{L}'’\-]+))?\s*[,，]?\s*[（(]?((?:19|20)\d{2})[a-z]?/gu;
    while ((m = authorYear.exec(text))) {
      const key = m[1].toLowerCase() + "|" + m[2];
      if (index.has(key)) out.push({ start: m.index, end: m.index + m[0].length, keys: [key] });
    }
    return out;
  }
  function buildIndex(entries) {
    const index = new Map(), refs = entries.filter(e => e.reference);
    const numbered = refs.filter(e => e.reference.number != null).length;
    index.numbered = refs.length > 0 && numbered >= refs.length * .6;
    for (const e of refs) {
      const ref = e.reference;
      const key = index.numbered ? (ref.number != null ? String(ref.number) : null) : (ref.surname && ref.year ? ref.surname.toLowerCase() + "|" + ref.year : null);
      // Every bibliography row needs an anchor, including entries whose author
      // or year the local parser cannot recognize and duplicate author-years.
      index.set(key && !index.has(key) ? key : "ref:" + e.id, e);
    }
    return index;
  }
  const words = value => plain(value).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9\u3400-\u9fff]+/).filter(w => w.length > 1);
  function similarity(a, b) {
    const x = new Set(words(a)), y = new Set(words(b));
    if (!x.size || !y.size) return 0;
    let both = 0; for (const w of x) if (y.has(w)) both++;
    return 2 * both / (x.size + y.size);
  }
  function invertedText(index) {
    if (!index || typeof index !== "object") return "";
    const slots = [];
    for (const [word, positions] of Object.entries(index)) for (const p of positions || []) if (Number.isInteger(p) && p >= 0 && p < 20000) slots[p] = word;
    return slots.filter(w => w !== undefined).join(" ");
  }
  const stripTags = value => plain(String(value || "").replace(/<jats:title>[^<]*<\/jats:title>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&"));
  function fromOpenAlex(work) {
    if (!work || !work.display_name) return null;
    return { title: stripTags(work.display_name), authors: (work.authorships || []).map(a => plain(a.author?.display_name)).filter(Boolean).slice(0, 40), year: work.publication_year ? String(work.publication_year) : "",
      venue: plain(work.primary_location?.source?.display_name || ""), doi: doiOf(work.doi), abstract: invertedText(work.abstract_inverted_index), source: "OpenAlex", url: work.id || "", publisher: plain(work.primary_location?.source?.host_organization_name) };
  }
  function fromCrossref(item) {
    if (!item || !item.title?.[0]) return null;
    return { title: stripTags(item.title[0]), authors: (item.author || []).map(a => plain([a.given, a.family].filter(Boolean).join(" ") || a.name)).filter(Boolean).slice(0, 40),
      year: String(item.issued?.["date-parts"]?.[0]?.[0] || item.published?.["date-parts"]?.[0]?.[0] || ""), venue: stripTags(item["container-title"]?.[0] || ""), doi: doiOf(item.DOI), abstract: stripTags(item.abstract || ""), source: "Crossref", url: item.DOI ? "https://doi.org/" + item.DOI : "", publisher: plain(item.publisher) };
  }
  function fromSemanticScholar(paper) {
    if (!paper || !paper.title) return null;
    return { title: plain(paper.title), authors: (paper.authors || []).map(a => plain(a.name)).filter(Boolean), year: paper.year ? String(paper.year) : "", doi: doiOf(paper.externalIds?.DOI), abstract: plain(paper.abstract || ""), source: "Semantic Scholar", url: paper.url || (paper.paperId ? "https://www.semanticscholar.org/paper/" + paper.paperId : "") };
  }
  function fromArxiv(xml) {
    const entry = String(xml || "").match(/<entry\b[^>]*>([\s\S]*?)<\/entry>/); if (!entry) return null;
    const tag = name => stripTags((entry[1].match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">")) || [])[1] || "");
    const title = tag("title");
    const url = tag("id").replace(/^http:/, "https:");
    return title ? { title, abstract: tag("summary"), year: tag("published").slice(0, 4), doi: doiOf(tag("arxiv:doi")), arxivID: arxivID(url), url, authors: [...entry[1].matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => stripTags(m[1])), source: "arXiv" } : null;
  }
  function arxivResults(xml) { return [...String(xml).matchAll(/<entry\b[^>]*>[\s\S]*?<\/entry>/g)].map(m => fromArxiv(m[0])).filter(Boolean); }
  function fromScienceDirect(doc, url) {
    const get = key => doc.querySelector('meta[name="' + key + '"]')?.getAttribute("content") || "";
    const region = doc.querySelector(".abstract.author, #abstracts .abstract, [id^='abs'] .abstract, div.abstract:not(.abstractHighlights)");
    const abstract = get("citation_abstract") || (region ? [...region.querySelectorAll("p")].map(p => p.textContent).join(" ") : "");
    return { title: plain(get("citation_title")), authors: [...doc.querySelectorAll('meta[name="citation_author"]')].map(n => plain(n.getAttribute("content"))),
      year: get("citation_publication_date").slice(0, 4), doi: doiOf(get("citation_doi")), abstract: plain(abstract), source: "Elsevier / ScienceDirect", url };
  }
  // A public record replaces the local parse only when identity is evident.
  function verify(ref, meta) {
    if (!meta || !meta.title) return false;
    const arxiv = arxivID(ref.raw || ref.url);
    if (arxiv && meta.arxivID === arxiv) return true;
    if (ref.doi && meta.doi) return ref.doi.toLowerCase() === meta.doi.toLowerCase();
    if (ref.year && meta.year && Math.abs(Number(ref.year) - Number(meta.year)) > 1) return false;
    if (ref.authors?.length && meta.authors?.length) {
      const first = evidenceText(surname(ref.authors[0]));
      if (first && !meta.authors.some(author => evidenceText(surname(author)) === first)) return false;
    }
    if (ref.title) return similarity(ref.title, meta.title) >= .82;
    return evidenceText(meta.title).length > 12 && evidenceText(ref.raw).includes(evidenceText(meta.title));
  }
  const api = { label, split, parse, names, surname, doiOf, arxivID, modelFields, citations, buildIndex, expand, similarity, invertedText, fromOpenAlex, fromCrossref, fromSemanticScholar, fromArxiv, arxivResults, fromScienceDirect, verify, stripTags, plain };
  if (typeof module !== "undefined") module.exports = api;
  root.ParallelReferences = api;
})(typeof module !== "undefined" && module.exports ? globalThis : this);
