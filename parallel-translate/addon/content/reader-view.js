/* Independent, continuous PDF + translation reader. A block id is the navigation anchor. */
(function (root) {
  "use strict";
  const G = root.ParallelPDFLayout;
  const D = root.ParallelDocument;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  // List markers are drawn once by CSS; extracted and translated text often
  // repeats the PDF bullet glyph, which showed as a second (black) dot.
  const BULLET = /^\s*[•●◦▪◾·∙‣■□○◆◇–—-](?=\s)\s*|^\s*[•●◦▪◾·∙‣■□○◆◇]+\s*/;
  const NUMBERED = /^\s*(?:\(?\d{1,3}[.)]|\(?[a-z][.)]\s|\([ivx]{1,5}\)|[ivx]{1,5}\.\s)/i;
  const listText = (block, text) => block.kind === "listitem" ? String(text || "").replace(BULLET, "") : text;
  // Landscape tables are painted upright: rotate the crop by a quarter turn.
  function rotateCanvas(canvas, rotation) {
    if (![90,180,270].includes(rotation)) return canvas;
    const out = el("canvas", canvas.className); out.width = rotation === 180 ? canvas.width : canvas.height; out.height = rotation === 180 ? canvas.height : canvas.width;
    const context = out.getContext("2d");
    if (rotation === 90) { context.translate(out.width, 0); context.rotate(Math.PI / 2); }
    else if (rotation === 270) { context.translate(0, out.height); context.rotate(-Math.PI / 2); }
    else { context.translate(out.width, out.height); context.rotate(Math.PI); }
    context.drawImage(canvas, 0, 0); canvas.width = canvas.height = 0;
    for (const name of canvas.getAttributeNames()) if (name !== "class" && name !== "width" && name !== "height") out.setAttribute(name, canvas.getAttribute(name));
    return out;
  }
  function el(tag, cls, text) {
    const node = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  class ReadingView {
    constructor(app, { message, pageChanged }) {
      Object.assign(this, { app, message, pageChanged });
      this.native = app.nativeSession;
      this.pdfPane = document.getElementById("pdf-pane");
      this.translationPane = document.getElementById("translation-pane");
      this.pagesHost = document.getElementById("pdf-pages");
      this.rowsHost = document.getElementById("rows");
      this.frames = new Map(); this.rows = new Map(); this.dimensions = new Map();
      this.rendered = new Map(); this.loads = new Map(); this.visibleRows = new Set();
      this.assets = new Map(); this.assetLoads = new Map(); this.assetQueue=new Set(); this.activeAssets=0;
      this.citations = root.ParallelCitationCards ? new root.ParallelCitationCards(this) : null;
      // Delegate row interactions once; rebuilding a long paper no longer
      // allocates four closures and listeners for every paragraph.
      this.rowsHost.addEventListener("click", event => {
        const row = event.target.closest?.("[data-block-id]");
        if (row && !event.target.closest(".reader-inline-editor,.reader-highlight,button,a,input,textarea") && !window.getSelection()?.toString()) this.focusBlock(row.dataset.blockId, "translation");
      });
      this.rowsHost.addEventListener("keydown", event => {
        if (event.target.dataset?.blockId && ["Enter", " "].includes(event.key)) { event.preventDefault(); this.focusBlock(event.target.dataset.blockId, "translation"); }
      });
      this.rowsHost.addEventListener("mouseover", event => { const row = event.target.closest?.("[data-block-id]"); if (row && !row.contains(event.relatedTarget)) this.hover(row.dataset.blockId); });
      this.rowsHost.addEventListener("mouseout", event => { const row = event.target.closest?.("[data-block-id]"); if (row && !row.contains(event.relatedTarget)) this.hover(null); });
      this.epoch = 0; this.drawEpoch = 0; this.navigation = 0; this.zoom = 1; this.currentPage = 1;
      this.pageObserver = new IntersectionObserver(entries => {
        for (const e of entries) if (e.isIntersecting) this.renderPage(Number(e.target.dataset.page));
      }, { root: this.pdfPane, rootMargin: "300px" });
      this.rowObserver = new IntersectionObserver(entries => {
        for (const e of entries) { if (e.isIntersecting) this.visibleRows.add(e.target); else this.visibleRows.delete(e.target); }
      }, { root: this.translationPane });
      this.assetObserver = new IntersectionObserver(entries => {
        for (const entry of entries) { const id=entry.target.dataset.blockId; if(entry.isIntersecting)this.assetQueue.add(id);else this.assetQueue.delete(id); }
        this.pumpAssets();
      }, { root: this.translationPane, rootMargin: "300px" });
      // Rows far from the viewport keep plain text until they come within
      // ~1.5 screens or the browser is idle; KaTeX for a whole paper at once
      // blocks the UI for seconds on long documents.
      this.lazyTasks = new Map(); this.nearRows = new Set();
      this.lazyObserver = new IntersectionObserver(entries => {
        for (const e of entries) { if (e.isIntersecting) { this.nearRows.add(e.target); this.runLazy(e.target); } else this.nearRows.delete(e.target); }
      }, { root: this.translationPane, rootMargin: "1500px 0px" });
      this.translationPane.addEventListener("scroll", () => { clearTimeout(this.steerTimer); this.steerTimer = setTimeout(() => this.steer(), 450); }, { passive: true });
      for (const [pane, origin] of [[this.pdfPane, "pdf"], [this.translationPane, "translation"]]) {
        for (const type of ["wheel", "pointerdown", "keydown"]) pane.addEventListener(type, () => { this.scrollOrigin = origin; this.pinPage = null; this.navigation++; }, { passive: true });
        pane.addEventListener("scroll", () => {
          if (origin === "pdf") this.updatePageIndicator();
          if (origin !== this.scrollOrigin) return;
          if (this.frameRequest) return;
          this.frameRequest = requestAnimationFrame(() => { this.frameRequest = null; this.onScroll(); });
        }, { passive: true });
      }
      this.resizeObserver = new ResizeObserver(() => {
        clearTimeout(this.resizeTimer); this.resizeTimer = setTimeout(() => this.resize(), 120);
      });
      this.resizeObserver.observe(this.pdfPane);
    }
    setJob(job) {
      if (this.job?.id === job.id && this.job.readerRevision === job.readerRevision) { this.job=job;this.parts=new Map(job.blocks.map(b=>[b.id,b]));this.updateTranslations(); return; }
      const previousAnchor=this.job?.id===job.id?this.translationAnchor():null;
      this.epoch++; this.drawEpoch++; this.navigation++; this.scrollOrigin = null;
      const reuse = this.session && this.job?.document.attachmentID === job.document.attachmentID && this.job.document.fileHash === job.document.fileHash;
      if (reuse) { this.session.cancelRendering(); this.session.job = job; this.session.pages.clear(); }
      else this.session?.close().catch(() => {});
      this.pageObserver.disconnect(); this.rowObserver.disconnect(); this.assetObserver.disconnect();
      this.lazyObserver.disconnect(); this.lazyTasks.clear(); this.nearRows.clear(); this.lastSteer = null;
      this.assets.clear(); this.assetLoads.clear(); this.assetQueue.clear();
      this.frames.clear(); this.rows.clear(); this.dimensions.clear(); this.rendered.clear(); this.loads.clear(); this.visibleRows.clear();
      this.pagesHost.replaceChildren(); this.rowsHost.replaceChildren();
      this.job = job; this.focused = null; this.pinPage = null; this.currentPage = 1;
      this.pageChanged(1);
      this.elements = D.elements(job);
      this.blocks = new Map(this.elements.map(b => [b.id, b]));
      this.parts = new Map(job.blocks.map(b => [b.id, b]));
      try { this.citations?.setJob(job, this.elements); } catch (error) { this.citations = null; }
      this.partState=new Map();this.translationsReady=false;
      if (!reuse) this.session = new root.ParallelPDFSession(this.app, job, window);
      const addFrame = n => {
        const card = el("section", "pdf-page-card"); card.dataset.page = n;
        card.append(el("div", "pdf-folio", "第 " + n + " 页"));
        const frame = el("div", "pdf-page-frame"); frame.dataset.page = n; frame.style.aspectRatio = "595 / 842";
        frame.append(el("div", "page-placeholder", "第 " + n + " 页")); card.append(frame);
        this.frames.set(n, frame); this.pagesHost.append(card);
      };
      if(!this.native)for (let n = 1; n <= job.document.pages; n++) addFrame(n);
      if (job.preview) this.rowsHost.append(el("p", "parse-placeholder", "正在解析论文排版…"));
      const figures = new Map(), fragment=document.createDocumentFragment(), groups = D.figureGroups(this.elements);
      this.transcribed = new Set();
      let index = 0;
      for (const block of this.elements) {
        const eager = index++ < 24;
        const groupID = groups.get(block.id);
        let parent = fragment;
        if (groupID) {
          if (!figures.has(groupID)) {
            const asset = this.blocks.get(groupID), figure = el("figure", "document-figure figure-" + (asset?.kind === "table" ? "table" : "image"));
            figure.dataset.assetId = groupID; figures.set(groupID, figure); fragment.append(figure);
          }
          parent = figures.get(groupID);
        }
        const row = el(groupID && block.kind === "caption" ? "figcaption" : "section", "translation-block " + block.kind + (block.level === 1 ? " title" : ""));
        if(block.frontMatter)row.classList.add("front-matter");
        if(block.keywords)row.classList.add('keywords');
        if (block.noTranslate) { row.classList.add("no-translate"); row.dataset.skip = block.skipReason || "skip"; }
        row.dataset.blockId = block.id; row.dataset.page = block.page; row.tabIndex = 0;
        row.setAttribute("aria-label", "定位原文，第 " + block.page + " 页");
        if (block.kind === "math") {
          const holder = el("div", "formula formula-pending"), rect = block.anchors?.[0]?.rect;
          holder.style.minHeight = (rect ? clamp((rect[3] - rect[1]) / 8, 2.4, 14) : 3) + "em";
          row.append(holder);
          const paint = () => { if (holder.parentNode === row) this.paintFormula(row, block); };
          if (eager) paint(); else this.schedule(row, paint);
        }
        else if (D.visual(block.kind)) {
          const rotated = [90, 270].includes(block.tableRotation);
          if (block.tableMergedInto) { row.classList.add("table-merged"); row.hidden = true; }
          else for (const anchor of block.tableCropAnchors || block.anchors || []) {
            const slot = el("div", "asset-slot"), w = anchor.rect[2] - anchor.rect[0], h = anchor.rect[3] - anchor.rect[1];
            slot.style.aspectRatio = [90,270].includes(anchor.rotation ?? block.tableRotation) ? h + " / " + w : w + " / " + h; row.append(slot);
          }
          if (rotated) row.classList.add("rotated-asset");
          if(!block.tableMergedInto)this.assetObserver.observe(row);
        }
        if (!D.visual(block.kind)) {
          const source=el(block.kind==='heading'?'h'+(block.level||2):'p','source');
          source.textContent=listText(block,block.source);
          if(block.kind==='listitem'&&!NUMBERED.test(source.textContent))row.classList.add('bulleted');
          source.dataset.language='原文';
          const target=el(block.kind==='heading'?'h'+(block.level||2):'p','target');target.dataset.language='译文';
          source.lang='en';target.lang=block.noTranslate?'en':'zh-CN';
          row.append(source,target);
          if(block.readerFormat){const f=block.readerFormat;source.style.fontWeight=f.bold?'bold':'';source.style.fontStyle=f.italic?'italic':'';source.style.textAlign=f.align;source.style.textIndent=f.indent?'2em':'';source.style.marginBottom=f.spacing+'px';}
          if(block.edited)row.classList.add('reader-edited');
        }
        if(block.readerDeleted){row.classList.add('reader-deleted');const restore=el('button','reader-restore','已删除 · 恢复');restore.type='button';restore.addEventListener('click',event=>{event.stopPropagation();this.tools.run(async()=>{await this.tools.host.mutate(this.tools.base,state=>root.ParallelReaderModel.restore(this.tools.base,state,block.id));this.tools.update();});});row.append(restore);}
        if (block.reference) this.citations?.decorateReference(row, block);
        this.rows.set(block.id, row); parent.append(row); this.rowObserver.observe(row); this.lazyObserver.observe(row);
      }
      this.rowsHost.append(fragment);this.orderedRows=[...this.rowsHost.querySelectorAll("[data-block-id]")];
      this.updateTranslations(); this.layoutPages();
      this.native?.bind(this);
      // Formula AI runs with active translation in host.runJob. Simply reading
      // an existing checkpoint must not start a paid request.
      this.pdfPane.scrollTop = 0; this.translationPane.scrollTop = 0;
      const epoch = this.epoch;
      // Page metadata is cheap; establish actual rotation/crop-box sizes before distant jumps.
      this.metadataReady = (async () => {
        const pdf = await this.session.ready;
        if (epoch !== this.epoch) return;
        if(this.native){if(job.preview)job.document.pages=pdf.numPages;return;}
        if (job.preview) {
          job.document.pages = pdf.numPages;
          for (let n = this.frames.size + 1; n <= pdf.numPages; n++) addFrame(n);
          this.layoutPages();
        }
        for (let n = 1; n <= job.document.pages; n++) {
          if (epoch !== this.epoch) return;
          const page = await pdf.getPage(n), viewport = page.getViewport({ scale: 1 });
          if (epoch !== this.epoch) return;
          this.dimensions.set(n, [viewport.width, viewport.height]);
          this.frames.get(n).style.aspectRatio = viewport.width + " / " + viewport.height;
          if (n === 1) await this.renderPage(1);
        }
        if (epoch === this.epoch) for (const frame of this.frames.values()) this.pageObserver.observe(frame);
      })();
      this.metadataReady.catch(error => { if (epoch === this.epoch) this.showLoadError(error); });
      if(previousAnchor&&this.rows.has(previousAnchor.id))requestAnimationFrame(()=>{if(epoch===this.epoch)this.focusBlock(previousAnchor.id,'restore',previousAnchor.fraction);});
    }
    updateTranslations() {
      const dirty=new Set();
      for(const part of this.parts.values()){
        const previous=this.partState.get(part.id);
        if(!previous || previous.status!==part.status || previous.target!==part.target || previous.error!==part.error){
          dirty.add(part.paragraphID||part.id);
          this.partState.set(part.id,{status:part.status,target:part.target,error:part.error});
        }
      }
      let index = -1;
      for (const block of this.elements) {
        index++;
        if(this.translationsReady && !dirty.has(block.id))continue;
        const value = D.presentation(block, this.parts);
        const row = this.rows.get(block.id), signature = JSON.stringify(value);
        if (row.dataset.signature === signature) continue;
        row.dataset.signature = signature;
        const before = row.dataset.status;
        row.dataset.status = value.status;
        row.classList.toggle("translating", value.status === "running");
        row.classList.toggle("awaiting", value.status === "pending");
        if (this.translationsReady && before && before !== "complete" && value.status === "complete") {
          row.classList.add("arrived");
          setTimeout(() => row.classList.remove("arrived"), 1400);
        }
        if(block.kind==='table')continue;
        const target = row.querySelector(".target");
        if (!target) continue;
        const text = listText(block, value.text);
        const paint = () => { if (block.kind === 'preformatted') target.textContent = text; else { root.ParallelMath.renderText(document, target, text, block.inlineMath); if (!block.noTranslate) this.citations?.decorate(target);const source=row.querySelector('.source');if(source&&!source.dataset.mathReady){root.ParallelMath.renderText(document,source,listText(block,block.source),block.inlineMath);if(!block.noTranslate)this.citations?.decorate(source);source.dataset.mathReady='true';} } };
        if (block.kind === 'preformatted' || this.nearRows.has(row) || !this.translationsReady && index < 24) { this.lazyTasks.delete(row); paint(); }
        else { target.textContent = text; this.schedule(row, paint); }
        target.classList.toggle("pending", value.status !== "complete"); target.classList.toggle("failed", value.status === "failed");
        row.title = block.reference ? "点击打开参考文献详情" : block.noTranslate ? ({ reference: "参考文献保留原文", label: "子图标签保留原文", fragment: "图内文字片段保留原文" }[block.skipReason] || "元数据/脚注保留原文") + " · 点击定位" : value.error || (value.status === "complete" ? "点击定位原文" : "正在等待译文，暂显示原文");
      }
      this.translationsReady=true;
      this.refreshFormulas();
    }
    // Formula rows are repainted when a verified model transcription arrives.
    paintFormula(row, block) {
      const entry = this.job?.formulaCache?.items?.[block.id], M = root.ParallelMath;
      const formula = M.withTranscription ? M.withTranscription(block.formula, entry?.latex ? entry : null) : block.formula;
      for (const node of row.querySelectorAll(":scope > .formula, :scope > .formula-pending, :scope > .formula-original, :scope > .formula-toggle")) node.remove();
      const box = M.render(document, formula, block.source);
      row.prepend(box);
      if (formula?.transcribed) this.transcribed.add(block.id);
      if (box.classList.contains("formula-raster") && M.needsTranscription?.(block.formula) && this.app.formulaBusy?.(this.job.id)) box.classList.add("formula-awaiting");
      this.assets.delete(block.id);
      this.decorateMath(row, block, box);
    }
    refreshFormulas() {
      const items = this.job?.formulaCache?.items, busy = Boolean(this.job && this.app.formulaBusy?.(this.job.id));
      for (const block of this.elements || []) {
        if (block.kind !== "math") continue;
        const row = this.rows.get(block.id), box = row?.querySelector(":scope > .formula");
        if (!box) continue;
        if (items?.[block.id]?.latex && !this.transcribed.has(block.id)) { this.paintFormula(row, block); continue; }
        if (box.classList.contains("formula-raster")) box.classList.toggle("formula-awaiting", busy && !items?.[block.id]?.latex && (items?.[block.id]?.tries || 0) < 2 && Boolean(root.ParallelMath.needsTranscription?.(block.formula)));
      }
    }
    schedule(row, task) {
      // One pending upgrade per row; a newer translation replaces the old one.
      this.lazyTasks.set(row, task);
      if (this.nearRows.has(row)) { this.runLazy(row); return; }
      if (this.idleHandle) return;
      const idle = window.requestIdleCallback ? fn => window.requestIdleCallback(fn, { timeout: 1500 }) : fn => setTimeout(() => fn({ timeRemaining: () => 8 }), 60);
      const pump = deadline => {
        this.idleHandle = null; if (this.closed) return;
        for (const row of this.lazyTasks.keys()) { if (deadline.timeRemaining() < 3) break; this.runLazy(row); }
        if (this.lazyTasks.size) this.idleHandle = idle(pump);
      };
      this.idleHandle = idle(pump);
    }
    runLazy(row) {
      const task = this.lazyTasks.get(row); if (!task) return;
      this.lazyTasks.delete(row);
      try { task(); } catch (_) {}
    }
    decorateMath(row, block, formula) {
      const crops = () => {
        const box = el("div", "formula-original");
        for (const anchor of block.anchors || []) {
          const slot = el("div", "asset-slot");
          slot.style.aspectRatio = Math.max(1, anchor.rect[2] - anchor.rect[0]) + " / " + Math.max(1, anchor.rect[3] - anchor.rect[1]); box.append(slot);
        }
        return box;
      };
      if (formula.classList.contains("formula-raster")) {
        // Unparsed or scanned formulas: the exact PDF crop is the display itself.
        if (block.anchors?.length) { const box = crops(); box.classList.add("formula-crop"); row.append(box); this.assetObserver.observe(row); }
        return;
      }
      if (!block.anchors?.length) return;
      const chip = el("button", "formula-toggle", "原图");
      chip.type = "button"; chip.title = "对照 PDF 原公式截图"; chip.setAttribute("aria-pressed", "false");
      chip.addEventListener("click", event => {
        event.stopPropagation();
        let box = row.querySelector(".formula-original");
        const open = chip.getAttribute("aria-pressed") !== "true";
        chip.setAttribute("aria-pressed", String(open));
        if (open && !box) { box = crops(); row.append(box); }
        if (box) box.hidden = !open;
        if (open && (!this.assets.has(block.id) || !box.querySelector("canvas"))) { this.assets.delete(block.id); this.renderAsset(block.id).catch(() => {}); }
      });
      chip.addEventListener("keydown", event => event.stopPropagation());
      row.append(chip);
    }
    // Recovered tables are real HTML grids (header rows, spans, clickable
    // citations); the exact PDF crop stays one click away.
    rotateCanvas(canvas, rotation) { return rotateCanvas(canvas, rotation); }
    assetGeometry(block, anchor, page, maxWidth) {
      const viewport = page.getViewport(this.native ? this.native.clone({scale:1}) : {scale:1});
      const box = G.viewportRect(this.native ? this.native.clone(anchor.rect) : anchor.rect, viewport);
      const rotation = block.tableImageVersion || Number.isFinite(block.tableRotation) ? ((anchor.rotation ?? block.tableRotation ?? 0) - (viewport.rotation || 0) + 360) % 360 : 0;
      const turned = rotation === 90 || rotation === 270, sourceWidth = box[2] - box[0], sourceHeight = box[3] - box[1];
      const width = Math.min(maxWidth, (turned ? sourceHeight : sourceWidth) * 2);
      return {rotation, width, paintWidth:turned ? width * sourceWidth / Math.max(1,sourceHeight) : width};
    }
    steer() {
      if (!this.job || this.job.preview || typeof this.app.focusTranslation !== "function") return;
      const anchor = this.translationAnchor(); if (!anchor) return;
      const start = this.elements.findIndex(b => b.id === anchor.id); if (start < 0) return;
      for (let i = Math.max(0, start - 1); i < this.elements.length && i < start + 80; i++) {
        for (const id of this.elements[i].partIDs || []) {
          if (this.parts.get(id)?.status !== "pending") continue;
          if (this.lastSteer !== id && this.app.focusTranslation(this.job.id, id)) this.lastSteer = id;
          return;
        }
      }
    }
    pumpAssets() {
      while(!this.closed && this.activeAssets<2 && this.assetQueue.size){
        const id=this.assetQueue.values().next().value;this.assetQueue.delete(id);
        if(this.assets.has(id)||this.assetLoads.has(id))continue;
        this.activeAssets++;
        this.renderAsset(id).catch(()=>{}).finally(()=>{this.activeAssets--;if(!this.closed)setTimeout(()=>this.pumpAssets(),0);});
      }
    }
    async renderAsset(id) {
      if (this.assets.has(id)) return;
      if (this.assetLoads.has(id)) return this.assetLoads.get(id);
      const block = this.blocks.get(id), row = this.rows.get(id), epoch = this.epoch, drawEpoch = this.drawEpoch, session = this.session;
      if(!block||!row||!row.querySelector(".asset-slot"))return;
      const promise = (async () => {
        try {
          const slots = [...row.querySelectorAll(".asset-slot")];
          for (let i = 0; i < slots.length; i++) {
            const anchor = (block.tableCropAnchors || block.anchors)[i], { page } = await session.page(anchor.page);
            if (epoch !== this.epoch || drawEpoch !== this.drawEpoch) return;
            const {rotation, width, paintWidth} = this.assetGeometry(block, anchor, page, row.clientWidth || 600);
            let canvas = el("canvas", "document-asset"); canvas.setAttribute("role", "img");
            canvas.setAttribute("aria-label", block.kind === "table" || block.tableImageVersion ? "原文表格" : "论文原图");
            await session.paint(page, anchor.rect, canvas, paintWidth);
            if (epoch !== this.epoch || drawEpoch !== this.drawEpoch) { canvas.width = canvas.height = 0; return; }
            canvas = rotateCanvas(canvas, rotation);
            canvas.style.maxWidth = Math.ceil(width) + "px"; slots[i].style.aspectRatio = "auto"; slots[i].replaceChildren(canvas);
          }
          this.assets.set(id, row);
          delete row.dataset.assetError;
          // Once the exact PDF crop is painted it replaces the text shell entirely.
          if (row.querySelector(":scope > .formula-crop canvas, .formula-raster .formula-crop canvas")) row.querySelector(":scope > .formula-raster")?.classList.add("has-crop");
          // Keep distant figure canvases out of memory while retaining their exact layout height.
          const pane = this.translationPane.getBoundingClientRect();
          for (const [key, old] of this.assets) {
            if (this.assets.size <= 10) break;
            const rect = old.getBoundingClientRect();
            if (key === id || rect.bottom >= pane.top - 400 && rect.top <= pane.bottom + 400) continue;
            for (const slot of old.querySelectorAll(".asset-slot")) {
              if (slot.clientWidth && slot.clientHeight) slot.style.aspectRatio = slot.clientWidth + " / " + slot.clientHeight;
              const canvas = slot.querySelector("canvas"); if (canvas) canvas.width = canvas.height = 0; slot.replaceChildren();
            }
            this.assets.delete(key);
          }
        } catch (error) {
          if(epoch===this.epoch)row.dataset.assetError=error.message||error.name||"图像加载失败";
          if (epoch === this.epoch) row.querySelector(".asset-slot")?.replaceChildren(el("span", "asset-error", "图像加载失败，点击可查看 PDF 原文。"));
        }
      })();
      this.assetLoads.set(id, promise);
      await promise;
      if (this.assetLoads.get(id) === promise) this.assetLoads.delete(id);
    }
    layoutPages() {
      if(this.native)return;
      const width = Math.max(240, this.pdfPane.clientWidth - 36) * this.zoom;
      for (const frame of this.frames.values()) frame.parentElement.style.width = width + "px";
    }
    resize() {
      if(this.native)return;
      if (!this.job) return;
      const width = this.pdfPane.clientWidth;
      if (width === this.lastWidth && this.lastZoom === this.zoom) return;
      const anchor = this.pdfAnchor();
      this.lastWidth = width; this.lastZoom = this.zoom; this.scrollOrigin = null;
      this.drawEpoch++; this.session?.cancelRendering();
      this.loads.clear(); this.rendered.clear();
      // Figure crops were painted for the old column width; drop them so the
      // asset observer repaints at the new size instead of showing stale pixels.
      this.assets.clear(); this.assetQueue.clear();
      this.pageObserver.disconnect();
      for (const frame of this.frames.values()) frame.replaceChildren(el("div", "page-placeholder", "第 " + frame.dataset.page + " 页"));
      this.layoutPages();
      for (const frame of this.frames.values()) this.pageObserver.observe(frame);
      if (anchor) this.focusBlock(anchor.id, "resize", anchor.fraction, anchor.page);
      else this.renderPage(this.currentPage);
      for (const n of [this.currentPage - 1, this.currentPage + 1]) if (this.frames.has(n)) this.renderPage(n);
      this.pumpAssets();
    }
    setZoom(value) { this.zoom = value; this.resize(); }
    async renderPage(number) {
      if (!this.session || !this.frames.has(number)) return null;
      if (this.rendered.has(number)) return this.rendered.get(number);
      if (this.loads.has(number)) return this.loads.get(number);
      const epoch = this.epoch, drawEpoch = this.drawEpoch, session = this.session, frame = this.frames.get(number);
      const current = () => epoch === this.epoch && drawEpoch === this.drawEpoch;
      const promise = (async () => {
        try {
          const { page, mapping, mappingError } = await session.page(number);
          if (!current()) return null;
          const viewport = page.getViewport({ scale: 1 }); frame.style.aspectRatio = viewport.width + " / " + viewport.height;
          const canvas = el("canvas", "pdf-page-canvas"); canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "第 " + number + " 页完整 PDF");
          await session.paint(page, page.view, canvas, frame.clientWidth || 600);
          if (!current()) { canvas.width = canvas.height = 0; return null; }
          frame.replaceChildren(canvas);
          const regions = new Map();
          for (const [id, geometry] of mapping) {
            if (geometry.status !== "matched") continue;
            const nodes = [];
            for (const rect of geometry.rects) {
              const box = G.viewportRect(rect, viewport), button = el("button", "pdf-region");
              button.dataset.blockId = id; button.setAttribute("aria-label", "定位对应译文"); button.title = "点击查看译文";
              Object.assign(button.style, { left: 100 * box[0] / viewport.width + "%", top: 100 * box[1] / viewport.height + "%", width: 100 * (box[2] - box[0]) / viewport.width + "%", height: 100 * (box[3] - box[1]) / viewport.height + "%" });
              button.addEventListener("click", () => this.focusBlock(id, "pdf", 0.5, number));
              button.addEventListener("mouseenter", () => this.hover(id)); button.addEventListener("mouseleave", () => this.hover(null));
              nodes.push(button); frame.append(button);
            }
            regions.set(id, nodes);
          }
          const value = { page, mapping, regions, frame, canvas, mappingError };
          this.rendered.set(number, value); this.highlight(this.focused); this.trimPages(number);
          return value;
        } catch (error) {
          if (current() && error.name !== "RenderingCancelledException") {
            frame.replaceChildren(el("p", "pdf-error", "无法显示此页：" + (error.message || "PDF 加载失败") + "。可点击工具栏重新加载。"));
          }
          return null;
        }
      })();
      this.loads.set(number, promise);
      promise.finally(() => { if (this.loads.get(number) === promise) this.loads.delete(number); });
      return promise;
    }
    trimPages(recentPage) {
      if (this.rendered.size <= 5) return;
      const candidates = [...this.rendered.keys()].sort((a, b) => Math.abs(b - this.currentPage) - Math.abs(a - this.currentPage));
      const pane = this.pdfPane.getBoundingClientRect();
      for (const n of candidates) {
        if (this.rendered.size <= 5) break;
        if (n === this.pinPage || n === recentPage) continue;
        const value = this.rendered.get(n), rect = value.frame.getBoundingClientRect();
        if (rect.bottom >= pane.top - 350 && rect.top <= pane.bottom + 350) continue;
        value.canvas.width = value.canvas.height = 0;
        value.frame.replaceChildren(el("div", "page-placeholder", "第 " + n + " 页")); this.rendered.delete(n);
      }
    }
    showLoadError(error) {
      this.frames.get(1)?.replaceChildren(el("p", "pdf-error", (error.message || "PDF 加载失败") + "。译文仍可阅读；下载附件后点击重新加载。"));
    }
    // Captions and assets share one card; the card reflects its rows' state.
    figureState(id, name, on) { const figure = this.rows.get(id)?.closest?.(".document-figure"); if (figure) figure.classList.toggle(name, on); }
    highlight(id) {
      if (this.focused && this.focused !== id) { this.rows.get(this.focused)?.classList.remove("selected"); this.figureState(this.focused, "selected", false); }
      this.focused = id; this.rows.get(id)?.classList.add("selected"); this.figureState(id, "selected", true);
      for (const value of this.rendered.values()) for (const [key, nodes] of value.regions) for (const node of nodes) node.classList.toggle("selected", key === id);
    }
    hover(id) {
      if (this.hovered) { this.rows.get(this.hovered)?.classList.remove("hovered"); this.figureState(this.hovered, "hovered", false); }
      this.hovered = id; this.rows.get(id)?.classList.add("hovered"); this.figureState(id, "hovered", true);
      for (const value of this.rendered.values()) for (const [key, nodes] of value.regions) for (const node of nodes) node.classList.toggle("hovered", key === id);
    }
    center(pane, node, fraction = 0.5) {
      const p = pane.getBoundingClientRect(), r = node.getBoundingClientRect();
      pane.scrollTo({ top: pane.scrollTop + r.top - p.top + r.height * fraction - p.height / 2, left: pane.scrollLeft + r.left - p.left + r.width / 2 - p.width / 2, behavior: "instant" });
    }
    async focusBlock(id, origin, fraction = 0.5, pageNumber = null) {
      const block = this.blocks.get(id); if (!block) return;
      const page = pageNumber || block.page;
      const navigation = ++this.navigation, epoch = this.epoch;
      this.scrollOrigin = null; this.pinPage = page; this.highlight(id); this.currentPage = page; this.pageChanged(page);
      const row = this.rows.get(id);
      if (origin !== "resize") this.center(this.translationPane, row, fraction);
      if(this.native){if(origin!=="native")this.native.navigate(block,fraction);return;}
      await this.metadataReady.catch(() => {});
      if (navigation !== this.navigation || epoch !== this.epoch) return;
      const value = await this.renderPage(page);
      if (navigation !== this.navigation || epoch !== this.epoch) return;
      const nodes = value?.regions.get(id);
      if (nodes?.length) {
        this.highlight(id); this.center(this.pdfPane, nodes[0], fraction);
      } else {
        this.center(this.pdfPane, this.frames.get(page), 0.1);
        this.message(value ? "该段缺少准确坐标，已打开对应 PDF 页。" : "PDF 加载失败，译文仍可阅读。", true);
      }
      this.trimPages();
    }
    async goPage(number) {
      number = clamp(number, 1, this.job.document.pages);
      const block = this.elements.find(b => b.page === number || b.anchors?.some(a => a.page === number));
      if (block) return this.focusBlock(block.id, "page", .5, number);
      const epoch = this.epoch, navigation = ++this.navigation;
      this.scrollOrigin = null; this.pinPage = number; this.currentPage = number; this.pageChanged(number);
      await this.metadataReady.catch(() => {});
      if (epoch !== this.epoch || navigation !== this.navigation) return;
      await this.renderPage(number);
      if (epoch !== this.epoch || navigation !== this.navigation) return;
      this.center(this.pdfPane, this.frames.get(number), 0.1);
    }
    pdfAnchor() {
      const pane = this.pdfPane.getBoundingClientRect(), center = pane.top + pane.height / 2;
      let best, distance = Infinity;
      for (const value of this.rendered.values()) for (const [id, nodes] of value.regions) for (const node of nodes) {
        const r = node.getBoundingClientRect(); if (r.bottom < pane.top || r.top > pane.bottom) continue;
        const d = Math.abs((r.top + r.bottom) / 2 - center);
        if (d < distance) { distance = d; best = { id, page: Number(value.frame.dataset.page), fraction: clamp((center - r.top) / r.height, 0, 1) }; }
      }
      return best;
    }
    translationAnchor() {
      const pane=this.translationPane.getBoundingClientRect();
      const match=root.ParallelNativeLink.nearest(this.orderedRows||[],pane.top,pane.bottom);
      return match?{id:match.node.dataset.blockId,fraction:match.fraction}:undefined;
    }
    updatePageIndicator() {
      if(this.native)return;
      if (!this.job) return;
      const pane = this.pdfPane.getBoundingClientRect(), center = pane.top + pane.height / 2;
      let low = 1, high = this.job.document.pages;
      while (low <= high) {
        const n = Math.floor((low + high) / 2), r = this.frames.get(n).getBoundingClientRect();
        if (r.bottom < center) low = n + 1;
        else if (r.top > center) high = n - 1;
        else { this.currentPage = n; this.pageChanged(n); break; }
      }
    }
    syncEnabled() { return !this.native?.resizing && document.getElementById("sync-scroll").checked; }
    onScroll() {
      if (!this.job) return;
      if (!this.syncEnabled() || !this.scrollOrigin) return;
      if(this.native){
        if(this.scrollOrigin==="translation"){
          const anchor=this.translationAnchor();
          if(anchor){this.highlight(anchor.id);this.native.navigate(this.blocks.get(anchor.id),anchor.fraction);}
        }
        return;
      }
      if (this.scrollOrigin === "pdf") {
        const anchor = this.pdfAnchor(); if (!anchor) return;
        const row = this.rows.get(anchor.id); if (!row || row.hidden) return;
        this.highlight(anchor.id); this.center(this.translationPane, row, anchor.fraction);
      } else {
        const anchor = this.translationAnchor(); if (!anchor) return;
        const block = this.blocks.get(anchor.id), anchors = block.anchors || [];
        const selectedAnchor = anchors[Math.min(anchors.length - 1, Math.floor(anchor.fraction * anchors.length))];
        const epoch = this.epoch, navigation = ++this.navigation, page = selectedAnchor?.page || block.page;
        this.pinPage = page;
        this.renderPage(page).then(value => {
          if (epoch !== this.epoch || navigation !== this.navigation || this.scrollOrigin !== "translation") return;
          const region = value?.regions.get(anchor.id)?.[0]; if (!region) return;
          this.highlight(anchor.id); this.center(this.pdfPane, region, anchor.fraction);
          this.trimPages();
        });
      }
    }
    reload() { const job = this.job; this.job = null; this.setJob(job); }
    close() {
      this.tools?.close();
      this.closed=true;this.assetQueue.clear();
      this.citations?.close();
      this.epoch++; this.drawEpoch++; this.navigation++;
      this.pageObserver.disconnect(); this.rowObserver.disconnect(); this.assetObserver.disconnect(); this.resizeObserver.disconnect(); this.lazyObserver.disconnect();
      this.lazyTasks.clear(); clearTimeout(this.steerTimer);
      if (this.idleHandle && window.cancelIdleCallback) try { window.cancelIdleCallback(this.idleHandle); } catch (_) {}
      clearTimeout(this.resizeTimer); if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
      this.session?.close().catch(() => {});
    }
  }
  root.ParallelReadingView = ReadingView;
})(this);
