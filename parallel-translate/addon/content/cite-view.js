/* Inline citation links and the hover reference card in the translation pane. */
(function (root) {
  "use strict";
  const R = root.ParallelReferences;
  const A = root.ParallelAssetLayout;
  const SKIP = ".katex,.inline-formula,.display-formula,.cite,.formula";
  function el(tag, cls, text) {
    const node = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  class CitationCards {
    constructor(view) {
      this.view = view; this.app = view.app; this.pane = view.translationPane; this.index = new Map();
      this.events = new window.AbortController(); this.sizes = {};
      const on = (node, type, fn, options = {}) => node.addEventListener(type, fn, { ...options, signal: this.events.signal });
      this.native = this.app.nativeSession;
      this.surfaceWindow = this.native?.frame?.ownerDocument.defaultView || window;
      this.surfaceDocument = this.surfaceWindow.document;
      let parent = document.body;
      if (this.surfaceWindow !== window) {
        // A chrome-window shadow tree escapes the translation browser's clipping
        // while keeping our styles out of Zotero and its other plugins.
        this.layer = this.surfaceDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
        this.layer.setAttribute("data-paralleltranslate-popup", "");
        this.layer.style.cssText = "position:fixed;inset:0;z-index:2147483645;pointer-events:none;display:block";
        parent = this.layer.attachShadow({ mode: "open" });
        for (const href of ["reading.css", "vendor/katex/katex.min.css"]) {
          const link = el("link"); link.rel = "stylesheet"; link.href = "chrome://paralleltranslate/content/" + href;
          on(link, "load", () => { if (!this.card?.hidden && this.active !== false) this.place(); }); parent.append(link);
        }
        this.surfaceDocument.documentElement.append(this.layer);
        this.themeObserver = new window.MutationObserver(() => this.syncTheme());
        this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
        on(window.matchMedia("(prefers-color-scheme: dark)"), "change", () => this.syncTheme());
      }
      this.card = el("div", "cite-card"); this.card.hidden = true; this.card.setAttribute("role", "dialog"); this.card.setAttribute("aria-live", "polite");
      parent.append(this.card); this.syncTheme(); this.setActive(this.native ? this.native.isActive() : true);
      const host = view.rowsHost;
      on(host, "mouseover", event => { const cite = event.target.closest?.(".cite"); if (cite) this.schedule(cite); });
      on(host, "mouseout", event => { const cite = event.target.closest?.(".cite"); if (cite && !cite.contains(event.relatedTarget)) this.scheduleHide(); });
      on(host, "focusin", event => { const cite = event.target.closest?.(".cite"); if (cite && !this.returningFocus) this.show(cite); });
      on(host, "click", event => {
        const cite = event.target.closest?.(".cite"); if (!cite) return;
        if (cite.classList.contains("reference-entry") && window.getSelection()?.toString()) return;
        event.stopPropagation(); event.preventDefault(); this.show(cite, true);
      }, { capture: true });
      on(host, "keydown", event => {
        const cite = event.target.closest?.(".cite");
        if (cite && ["Enter", " "].includes(event.key)) { event.stopPropagation(); event.preventDefault(); this.show(cite, true); }
      }, { capture: true });
      on(this.card, "mouseenter", () => clearTimeout(this.hideTimer));
      on(this.card, "mouseleave", () => this.scheduleHide());
      for (const doc of new Set([document, this.surfaceDocument])) {
        on(doc, "keydown", event => this.handleKey(event), { capture: true });
        on(doc, "pointerdown", event => this.outsidePointer(event));
      }
      on(this.pane, "scroll", () => { if (!this.card.hidden && !this.pinned) { if (this.held && this.anchor?.isConnected) this.place(); else this.hide(); } }, { passive: true });
      on(this.card, "pointerdown", event => this.beginInteraction(event));
      on(this.surfaceDocument, "pointermove", event => this.moveInteraction(event));
      on(this.surfaceDocument, "pointerup", event => { if (event.pointerId === this.interaction?.id) this.endInteraction(); });
      on(this.surfaceDocument, "pointercancel", () => this.endInteraction());
      on(this.card, "lostpointercapture", () => this.endInteraction());
      on(this.surfaceWindow, "blur", () => this.endInteraction());
      for (const win of new Set([window, this.surfaceWindow])) on(win, "resize", () => { if (!this.card.hidden && this.active !== false) this.place(); });
    }
    syncTheme() {
      if (!this.layer) return;
      const style = window.getComputedStyle(this.pane);
      for (const key of ["--reading-size", "--caption-size", "--reading-font", "--reading-accent", "--reading-accent-soft", "--reading-ink", "--reading-muted", "--reading-hover", "--paper", "--line", "--red", "--ease"]) this.layer.style.setProperty(key, style.getPropertyValue(key));
      this.layer.style.colorScheme = style.colorScheme;
    }
    setActive(active) {
      if (this.active === active) return; this.active = active;
      if (this.layer) { this.layer.hidden = !active; this.layer.style.display = active ? "block" : "none"; }
      if (!active) { this.endInteraction(); if (!this.pinned) this.hide(); }
      else if (!this.card.hidden) this.place();
    }
    outsidePointer(event) {
      if (this.active === false || this.card.hidden || this.pinned) return;
      // Shadow-DOM events are retargeted to the layer outside its tree.
      if (!event.composedPath?.().includes(this.card) && !this.card.contains(event.target) && !event.target.closest?.(".cite")) this.hide();
    }
    handleKey(event) {
      if (event.key !== "Escape" || this.card.hidden || this.active === false) return;
      event.preventDefault(); event.stopPropagation();
      const anchor = this.anchor; this.hide(); this.returningFocus = true;
      try { anchor?.focus({ preventScroll: true }); } finally { this.returningFocus = false; }
    }
    surfaceRect(node) {
      const rect = node.getBoundingClientRect();
      if (!this.layer) return rect;
      const frame = this.native.frame.getBoundingClientRect(), sx = frame.width / Math.max(1, window.innerWidth), sy = frame.height / Math.max(1, window.innerHeight);
      const left = frame.left + rect.left * sx, top = frame.top + rect.top * sy, width = rect.width * sx, height = rect.height * sy;
      return { left, top, width, height, right: left + width, bottom: top + height };
    }
    setJob(job, elements) {
      this.job = job; this.hide(); this.detailStates = new Map(); this.abstractState = null;
      this.index = R.buildIndex(elements);
      for (const [key, entry] of this.index) entry.reference.key = key;
      this.assetIndex = A.index(elements);
      for (const [key, entry] of this.assetIndex) this.index.set("asset:" + key, entry);
      this.referenceKeys = new Map([...this.index].filter(([, e]) => e.reference).map(([key, e]) => [e.id, key]));
    }
    decorateReference(row, block) {
      const key = this.referenceKeys.get(block.id); if (!key) return;
      row.classList.add("cite", "reference-entry"); row.dataset.refs = key;
      row.setAttribute("role", "button"); row.setAttribute("aria-haspopup", "dialog");
      row.setAttribute("aria-label", "打开参考文献：" + (block.reference?.title || block.source));
    }
    decorate(target) {
      if (!this.index.size || !target) return;
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT), nodes = [];
      while (walker.nextNode()) { const node = walker.currentNode; if (!node.parentElement?.closest(SKIP) && /[\[(（［【\d图表]/.test(node.data)) nodes.push(node); }
      for (const node of nodes) {
        const spans = [...R.citations(node.data, this.index), ...A.mentions(node.data).map(s => ({ ...s, keys: s.keys.filter(k => this.assetIndex.has(k)).map(k => "asset:" + k) }))].filter(s => s.keys.length).sort((a, b) => a.start - b.start);
        if (!spans.length) continue;
        const fragment = document.createDocumentFragment(); let at = 0;
        for (const span of spans) {
          if (span.start < at) continue;
          fragment.append(node.data.slice(at, span.start));
          const asset = span.keys[0].startsWith("asset:"), cite = el("span", "cite" + (asset ? " asset-cite" : ""), node.data.slice(span.start, span.end));
          cite.dataset.refs = span.keys.join(","); cite.tabIndex = 0; cite.setAttribute("role", "button");
          cite.setAttribute("aria-label", asset ? span.keys.map(k => this.index.get(k).title).join("、") : "参考文献 " + span.keys.join("、"));
          fragment.append(cite); at = span.end;
        }
        fragment.append(node.data.slice(at));
        node.replaceWith(fragment);
      }
    }
    schedule(cite) {
      clearTimeout(this.hideTimer); clearTimeout(this.showTimer);
      if ((this.pinned || this.held) && !this.card.hidden) return;
      if (this.anchor === cite && !this.card.hidden) return;
      this.showTimer = setTimeout(() => this.show(cite), this.card.hidden ? 160 : 60);
    }
    scheduleHide() { clearTimeout(this.showTimer); if (this.pinned || this.held) return; clearTimeout(this.hideTimer); this.hideTimer = setTimeout(() => this.hide(), 260); }
    hide() {
      clearTimeout(this.showTimer); clearTimeout(this.hideTimer); this.endInteraction();
      this.paintToken = (this.paintToken || 0) + 1; this.card.hidden = true; this.card.classList.remove("open", "pinned");
      this.anchor?.classList.remove("active"); this.anchor = null; this.pinned = this.held = false; this.activeKey = null; this.geometry = null;
    }
    close() { this.destroyed = true; this.hide(); this.events.abort(); this.themeObserver?.disconnect(); this.card.remove(); this.layer?.remove(); }
    show(cite, held = false) {
      clearTimeout(this.hideTimer); clearTimeout(this.showTimer);
      if (this.active === false) return;
      if (!held && !this.card.hidden && (this.pinned || this.held)) return;
      const keys = (cite.dataset.refs || "").split(",").filter(k => this.index.has(k)); if (!keys.length) return;
      if (this.anchor === cite && !this.card.hidden) { this.held ||= held; if (held) this.loadReference(this.activeKey); return; }
      this.anchor?.classList.remove("active");
      if (!this.pinned) this.geometry = null;
      this.anchor = cite; cite.classList.add("active"); this.held = held; this.keys = keys;
      this.syncTheme(); this.open(keys.includes(this.activeKey) ? this.activeKey : keys[0]);
      this.card.hidden = false; this.place();
      requestAnimationFrame(() => this.card.classList.add("open"));
    }
    place() {
      if (!this.anchor || this.active === false) return;
      const anchor = this.surfaceRect(this.anchor), pane = this.surfaceRect(this.pane), win = this.surfaceWindow;
      if (this.geometry) { this.applyGeometry(this.geometry); return; }
      const preferred = this.sizes[this.card.classList.contains("asset-card") ? "asset" : "reference"];
      const width = Math.max(1, Math.min(preferred?.width || 560, this.layer ? win.innerWidth - 24 : pane.width - 24, win.innerWidth - 16));
      this.card.style.width = width + "px";
      this.card.style.height = "auto"; this.card.style.maxHeight = Math.max(1, win.innerHeight - 24) + "px";
      const body = this.card.querySelector(".cite-body");
      const wanted = preferred?.height || this.card.scrollHeight + (body ? body.scrollHeight - body.clientHeight : 0) + 2 || 260;
      const below = Math.max(0, win.innerHeight - anchor.bottom - 20), above = Math.max(0, anchor.top - 20);
      const useBelow = below >= Math.min(wanted, 320) || below >= above;
      const maxHeight = Math.max(1, Math.min(win.innerHeight - 24, Math.max(120, useBelow ? below : above)));
      this.card.style.maxHeight = Math.max(1, maxHeight) + "px";
      if (preferred) this.card.style.height = Math.min(preferred.height, maxHeight) + "px";
      const height = Math.min(wanted, maxHeight), top = Math.max(12, Math.min(win.innerHeight - height - 12, useBelow ? anchor.bottom + 8 : anchor.top - 8 - height));
      const left = this.layer ? Math.min(win.innerWidth - width - 12, Math.max(12, anchor.left + anchor.width / 2 - width / 2)) : Math.min(Math.max(pane.left + 12, anchor.left + anchor.width / 2 - width / 2), pane.right - width - 12);
      this.card.style.top = Math.round(top) + "px"; this.card.style.left = Math.round(Math.max(8, left)) + "px";
      this.card.classList.toggle("above", top < anchor.top);
    }
    applyGeometry(rect) {
      const win = this.surfaceWindow, maxWidth = Math.max(1, win.innerWidth - 16), maxHeight = Math.max(1, win.innerHeight - 16);
      const width = Math.max(Math.min(220, maxWidth), Math.min(rect.width, maxWidth));
      const height = Math.max(Math.min(180, maxHeight), Math.min(rect.height, maxHeight));
      const left = Math.max(8, Math.min(rect.left, win.innerWidth - width - 8));
      const top = Math.max(8, Math.min(rect.top, win.innerHeight - height - 8));
      this.geometry = { left, top, width, height };
      Object.assign(this.card.style, { left: left + "px", top: top + "px", width: width + "px", height: height + "px", maxHeight: maxHeight + "px" });
    }
    setPinned(value) {
      this.pinned = value; this.held = true; clearTimeout(this.showTimer); clearTimeout(this.hideTimer);
      this.updatePin();
      if (value && !this.geometry) { this.card.classList.add("open"); this.applyGeometry(this.card.getBoundingClientRect()); }
    }
    updatePin() {
      const value = Boolean(this.pinned); this.card.classList.toggle("pinned", value);
      const pin = this.card.querySelector(".cite-pin");
      if (pin) { pin.title = value ? "取消钉住" : "钉住，滚动或点击正文时保持显示"; pin.setAttribute("aria-label", value ? "取消钉住" : "钉住弹窗"); pin.setAttribute("aria-pressed", String(value)); }
    }
    beginInteraction(event) {
      if (event.button !== 0 || this.card.hidden) return;
      const resize = event.target.closest?.(".cite-resize");
      if (!resize && (!event.target.closest?.(".cite-head") || event.target.closest?.("button,a"))) return;
      event.preventDefault(); this.setPinned(true); this.card.classList.add("interacting");
      this.interaction = { id: event.pointerId, x: event.clientX, y: event.clientY, rect: { ...this.geometry }, resize: Boolean(resize) };
      if (this.layer) {
        this.dragShield = el("div"); this.dragShield.setAttribute("data-popup-drag-shield", "");
        this.dragShield.style.cssText = "position:fixed;inset:0;z-index:59;pointer-events:auto;touch-action:none;cursor:" + (resize ? "nwse-resize" : "move");
        this.card.before(this.dragShield);
      }
      try { this.card.setPointerCapture(event.pointerId); } catch (_) {}
    }
    moveInteraction(event) {
      const action = this.interaction; if (!action || action.id !== event.pointerId) return;
      event.preventDefault();
      const dx = event.clientX - action.x, dy = event.clientY - action.y, rect = { ...action.rect };
      if (action.resize) { rect.width = Math.min(rect.width + dx, this.surfaceWindow.innerWidth - rect.left - 8); rect.height = Math.min(rect.height + dy, this.surfaceWindow.innerHeight - rect.top - 8); }
      else { rect.left += dx; rect.top += dy; }
      this.applyGeometry(rect);
    }
    endInteraction() {
      const action = this.interaction; if (!action) return; this.interaction = null;
      if (action.resize) this.rememberSize();
      try { this.card.releasePointerCapture(action.id); } catch (_) {}
      this.dragShield?.remove(); this.dragShield = null;
      this.card.classList.remove("interacting");
    }
    rememberSize() { const { width, height } = this.geometry; this.sizes[this.card.classList.contains("asset-card") ? "asset" : "reference"] = { width, height }; }
    finishCard() {
      const head = this.card.querySelector(".cite-head"), foot = this.card.querySelector(".cite-foot"), body = el("div", "cite-body");
      for (const node of [...this.card.children]) if (node !== head && node !== foot) body.append(node);
      head.after(body); head.title = "拖动标题栏移动弹窗";
      const pin = el("button", "cite-pin"), close = head.querySelector(".cite-close");
      pin.append(root.ParallelIcons.svg("pin")); if (close) root.ParallelIcons.set(close, "close");
      pin.type = "button"; pin.addEventListener("click", () => this.setPinned(!this.pinned)); close.before(pin);
      close.setAttribute("aria-label", "关闭弹窗");
      const resize = el("button", "cite-resize"); resize.type = "button"; resize.title = "拖动调整大小；方向键微调，Shift 加速"; resize.setAttribute("aria-label", "调整弹窗大小");
      resize.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); this.setPinned(true);
        const rect = { ...this.geometry }, step = event.shiftKey ? 40 : 10;
        if (event.key === "ArrowLeft") rect.width -= step; if (event.key === "ArrowRight") rect.width += step;
        if (event.key === "ArrowUp") rect.height -= step; if (event.key === "ArrowDown") rect.height += step;
        rect.width = Math.min(rect.width, this.surfaceWindow.innerWidth - rect.left - 8); rect.height = Math.min(rect.height, this.surfaceWindow.innerHeight - rect.top - 8);
        this.applyGeometry(rect); this.rememberSize();
      });
      this.card.append(resize);
      // Async content updates must not reset geometry or cancel a pending hide.
      this.updatePin();
    }
    store() { try { return this.app.referenceStore(this.job); } catch (_) { return { meta: {}, titles: {}, abstracts: {} }; } }
    open(key) {
      this.activeKey = key;
      const entry = this.index.get(key);
      this.card.classList.toggle("asset-card", Boolean(entry.asset));
      if (entry.asset) { this.renderAsset(entry); return; }
      this.paintToken = (this.paintToken || 0) + 1; this.render();
      if (this.held) this.loadReference(key);
    }
    loadReference(key, retry = false) {
      const ref = this.index.get(key)?.reference; if (!ref || this.detailStates.get(key)?.loading) return;
      const job = this.job, cached = this.store().details?.[key];
      if (!retry && cached?.complete && cached.raw === ref.raw) return;
      const render = () => { if (!this.destroyed && this.job === job && this.activeKey === key) this.render(); };
      this.detailStates.set(key, { loading: true, status: "parsing" }); render();
      Promise.resolve(this.app.referenceDetails(job, ref, status => {
        if (this.job !== job || this.destroyed) return;
        this.detailStates.set(key, { loading: true, status }); render();
      }, { retry })).then(result => {
        if (this.job === job) this.detailStates.set(key, { loading: false, error: result.parseError || result.titleError || "" });
      }).catch(error => {
        if (this.job === job) this.detailStates.set(key, { loading: false, error: error.safeMessage || error.message || "参考文献读取失败" });
      }).finally(render);
    }
    title(ref) { const store = this.store(); return store.meta[ref.key]?.title || store.parsed?.[ref.key]?.title || ref.title || ""; }
    titleZh(ref) { const titles = this.store().titles; return titles[this.title(ref)] || ""; }
    abstract(ref) {
      const job = this.job, current = () => this.job === job && !this.destroyed;
      this.abstractState = { key: ref.key, status: "searching" }; this.render();
      return Promise.resolve(this.app.referenceAbstract(job, ref, found => { if (current() && this.activeKey === ref.key) { this.abstractState = { key: ref.key, status: "translating", found }; this.render(); } }))
        .then(found => { if (current()) this.abstractState = { key: ref.key, status: found ? "done" : "missing", found }; })
        .catch(error => { if (!current()) return; const cached = this.store().abstracts[ref.key]; this.abstractState = { key: ref.key, status: "error", found: cached, error: String(error?.safeMessage || error?.message || "翻译失败") }; })
        .then(() => { if (current() && this.activeKey === ref.key) this.render(); });
    }
    section(name, ...children) { const node = el("section", "cite-section"); node.append(el("h4", "", name), ...children); return node; }
    async renderAsset(entry) {
      const token = this.paintToken = (this.paintToken || 0) + 1, session = this.view.session, epoch = this.view.epoch;
      const card = this.card, head = el("header", "cite-head"), close = el("button", "cite-close", "×");
      card.replaceChildren(); card.setAttribute("aria-label", entry.title);
      head.append(el("span", "cite-badge", entry.number), el("strong", "", entry.kind === "table" ? "表格" : "图片"));
      if (this.keys.length > 1) {
        const tabs = el("span", "cite-tabs");
        for (const key of this.keys) {
          const b = el("button", "cite-tab" + (key === this.activeKey ? " current" : ""), this.index.get(key).title); b.type = "button";
          b.addEventListener("click", () => { this.held = true; this.open(key); this.place(); }); tabs.append(b);
        }
        head.append(tabs);
      }
      close.type = "button"; close.title = "关闭"; close.addEventListener("click", () => this.hide()); head.append(close); card.append(head);
      const caption = el("div", "asset-card-caption"), picture = el("div", "asset-card-picture"), pending = el("p", "cite-zh loading", "正在加载原图…");
      for (const c of entry.captions) {
        const p = el("p", ""); root.ParallelMath.renderText(document, p, root.ParallelDocument.presentation(c, this.view.parts).text, c.inlineMath); caption.append(p);
      }
      picture.append(pending);
      card.append(...(entry.asset.captionPlacement === "before" ? [caption, picture] : [picture, caption]));
      const foot = el("footer", "cite-foot"), locate = el("button", "cite-link", "定位译文图表"), source = el("button", "cite-link", "查看原文");
      locate.type = source.type = "button";
      locate.addEventListener("click", () => { this.hide(); this.view.focusBlock(entry.asset.id, "cite"); });
      source.addEventListener("click", () => { this.hide(); this.view.focusBlock(entry.asset.id, "translation"); });
      foot.append(locate, source); card.append(foot); this.finishCard();
      const current = () => token === this.paintToken && epoch === this.view.epoch && session === this.view.session;
      try {
        const existing = this.view.assets.get(entry.asset.id)?.querySelectorAll(".document-asset");
        const anchors = entry.asset.tableCropAnchors || entry.asset.anchors;
        for (let i = 0; i < anchors.length; i++) {
          if (!current()) return;
          let canvas = el("canvas", "document-asset"); canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", entry.title);
          if (existing?.[i]?.width) {
            canvas.width = existing[i].width; canvas.height = existing[i].height; canvas.getContext("2d").drawImage(existing[i], 0, 0);
          } else {
            const anchor = anchors[i], { page } = await session.page(anchor.page);
            if (!current()) return;
            const {rotation,paintWidth} = this.view.assetGeometry(entry.asset,anchor,page,Math.min(1200,Math.max(560,this.surfaceWindow.innerWidth-52)));
            await session.paint(page, anchor.rect, canvas, paintWidth);
            canvas = this.view.rotateCanvas(canvas,rotation);
          }
          if (!current()) { canvas.width = canvas.height = 0; return; }
          pending.remove(); picture.append(canvas); this.place();
        }
      } catch (_) { if (current()) { pending.classList.remove("loading"); pending.textContent = "原图加载失败，可点击「查看原文」。"; picture.append(pending); } }
    }
    render() {
      const key = this.activeKey, entry = this.index.get(key); if (!entry) return;
      if (!entry.reference) return;
      this.card.setAttribute("aria-label", "参考文献");
      const ref = entry.reference, store = this.store(), parsed = store.parsed?.[key], meta = store.meta[key] || parsed || null, title = this.title(ref);
      const card = this.card; card.replaceChildren();
      const head = el("header", "cite-head");
      const badge = el("span", "cite-badge", ref.number != null ? String(ref.number) : "§");
      head.append(badge, el("strong", "", "参考文献"));
      if (this.keys.length > 1) {
        const tabs = el("span", "cite-tabs");
        for (const k of this.keys) { const b = el("button", "cite-tab" + (k === key ? " current" : ""), this.index.get(k).reference.number ?? k.split("|")[0]); b.type = "button"; b.addEventListener("click", () => { this.held = true; this.open(k); this.place(); }); tabs.append(b); }
        head.append(tabs);
      }
      const close = el("button", "cite-close", "×"); close.type = "button"; close.title = "关闭"; close.addEventListener("click", () => this.hide()); head.append(close);
      card.append(head, el("div", "cite-raw", ref.raw));
      const details = this.detailStates.get(key) || {}, saved = store.details?.[key], zh = this.titleZh(ref);
      const titleZh = el("p", "cite-zh" + (zh ? "" : " loading"), zh || (details.loading ? "正在解析并核对文献信息…" : saved?.titleError || ""));
      titleZh.hidden = !titleZh.textContent;
      card.append(this.section("标题", el("p", "cite-en", title || "未能从条目中识别标题"), titleZh));
      const authors = meta?.authors?.length ? meta.authors : parsed?.authors?.length ? parsed.authors : ref.authors || [];
      card.append(this.section("作者", el("p", "cite-authors", authors.length ? (authors.length > 12 ? authors.slice(0, 12).join("，") + " 等 " + authors.length + " 位" : authors.join("，")) : "未识别")));
      const facts = el("p", "cite-facts"), year = meta?.year || parsed?.year || ref.year, venue = meta?.venue || ref.venue, doi = meta?.doi || ref.doi;
      facts.append(el("span", "", year || "年份未识别"));
      if (venue) facts.append(el("span", "", venue));
      if (doi) { const link = el("a", "cite-doi", "DOI " + doi); link.href = "https://doi.org/" + doi; link.addEventListener("click", event => { event.preventDefault(); this.app.openURL?.(link.href); }); facts.append(link); }
      if (!doi) facts.append(el("span", "", "未找到 DOI"));
      const status = el("span", "cite-source" + (store.meta[key] ? " verified" : ""), details.loading ? ({parsing:"模型解析中…", searching:"检索公开数据库…", title:"翻译标题…"}[details.status] || "正在读取…") : store.meta[key] ? "已核对 · " + store.meta[key].source : store.parsed?.[key] ? "AI 解析 · 引用原文" : "本地解析");
      facts.append(status);
      card.append(facts);
      const state = this.abstractState?.key === key ? this.abstractState : (store.abstracts[key] ? { status: store.abstracts[key].zh ? "done" : "found", found: store.abstracts[key] } : saved?.abstractMissing ? { status: "missing" } : null);
      const box = el("div", "cite-abstract");
      if (!state || state.status === "error" && !state.found) {
        const button = el("button", "cite-action", details.error || saved?.parseError ? "重试解析与检索" : "解析并检索摘要"); button.type = "button";
        button.addEventListener("click", () => { this.held = true; this.loadReference(key, true); });
        if (details.loading) box.append(el("p", "cite-zh loading", "正在检索公开摘要…"));
        else box.append(button, el("small", "", details.error || state?.error || "检索公开数据库中的摘要"));
      } else if (state.status === "searching") box.append(el("p", "cite-zh loading", "正在检索公开摘要…"));
      else if (state.status === "missing") {
        box.append(el("p", "cite-missing", "暂未获取到公开摘要，可能未收录或来源暂不可访问。"));
        const retry = el("button", "cite-action quiet", "重新检索"); retry.type = "button"; retry.addEventListener("click", () => this.loadReference(key, true)); box.append(retry);
      }
      else {
        const found = state.found || {};
        box.append(el("p", "cite-en", found.en || ""));
        const translated = el("p", "cite-zh" + (found.zh ? "" : " loading"), found.zh || (state.status === "translating" ? "摘要翻译中…" : state.status === "error" ? "摘要翻译失败：" + (state.error || "") : ""));
        if (state.status === "error" && !found.zh) { translated.classList.add("error"); }
        translated.hidden = !translated.textContent;
        const source = el("small", "", "摘要来源：" + (found.source || "公开数据库"));
        if (/^https:\/\//i.test(found.url || "")) { const link = el("a", "cite-link", "查看来源"); link.href = found.url; link.addEventListener("click", event => { event.preventDefault(); this.app.openURL?.(link.href); }); source.append(" · ", link); }
        box.append(translated, source);
        if (state.status === "found" || (state.status === "error" && !found.zh)) { const retry = el("button", "cite-action quiet", "翻译摘要"); retry.type = "button"; retry.addEventListener("click", () => this.abstract(ref)); box.append(retry); }
      }
      if (details.error || saved?.parseError) {
        const error = el("small", "cite-error", details.error || saved.parseError), retry = el("button", "cite-action quiet", "重试解析"); retry.type = "button"; retry.addEventListener("click", () => this.loadReference(key, true)); card.append(error, retry);
      }
      card.append(this.section("摘要", box));
      const foot = el("footer", "cite-foot"), locate = el("button", "cite-link", "定位到参考文献列表"); locate.type = "button";
      locate.addEventListener("click", () => {
        this.hide(); this.view.focusBlock(entry.id, "cite");
        const row = this.view.rows?.get(entry.id); if (!row) return;
        row.classList.remove("cite-target"); void row.offsetWidth; row.classList.add("cite-target");
        setTimeout(() => row.classList.remove("cite-target"), 1800);
      });
      foot.append(locate); card.append(foot); this.finishCard();
      if (!card.hidden) this.place();
    }
  }
  root.ParallelCitationCards = CitationCards;
})(this);
