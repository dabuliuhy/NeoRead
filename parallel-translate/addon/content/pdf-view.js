/* Uses the PDF.js runtime installed with Zotero; no third-party runtime is copied. */
(function (root) {
  "use strict";
  const G = root.ParallelPDFLayout;
  class PDFSession {
    constructor(app, job, window) {
      this.app = app; this.job = job; this.window = window;
      this.pages = new Map(); this.tasks = new Set(); this.closed = false;
      this.ready = this.open();
      this.ready.catch(() => {});
    }
    async open() {
      this.borrowed = Boolean(this.app.nativeSession);
      const bytes = this.borrowed ? null : await this.app.readPDF(this.job);
      if (this.closed) throw new Error("PDF 已关闭");
      const pdfjs = this.app.importPDFRuntime ? await this.app.importPDFRuntime() : await import("resource://zotero/reader/pdf/build/pdf.mjs");
      if (this.closed) throw new Error("PDF 已关闭");
      this.pdfjs = pdfjs;
      if (this.borrowed) {
        this.pdf = await this.app.nativeSession.borrowPDF();
        if(this.closed)throw new Error("PDF 已关闭");
        return this.pdf;
      }
      pdfjs.GlobalWorkerOptions.workerSrc = "resource://zotero/reader/pdf/build/pdf.worker.mjs";
      this.loading = pdfjs.getDocument({
        data: new Uint8Array(bytes), ownerDocument: this.window.document,
        cMapUrl: "resource://zotero/reader/pdf/web/cmaps/", cMapPacked: true,
        standardFontDataUrl: "resource://zotero/reader/pdf/web/standard_fonts/",
        wasmUrl: "resource://zotero/reader/pdf/web/wasm/", useWorkerFetch: false,
        isEvalSupported: false, enableXfa: false
      });
      this.loading.onPassword = () => { this.loading.destroy(); };
      this.pdf = await this.loading.promise;
      if (this.closed) { await this.pdf.destroy(); throw new Error("PDF 已关闭"); }
      return this.pdf;
    }
    async page(number) {
      const pdf = await this.ready;
      if (this.closed) throw new Error("PDF 已关闭");
      if (!this.pages.has(number)) {
        const promise = (async () => {
          const result = await pdf.getPage(number);
          // Awaiting a native content Promise reintroduces an Xray wrapper, which hides
          // PDFPageProxy's prototype methods. Unwrap only objects from the owned reader.
          const page = this.borrowed ? this.app.nativeSession.unwrap(result) : result;
          if (this.job.structure) {
            const mapping = new Map();
            for (const block of this.job.structure) {
              const rects = block.anchors.filter(anchor => anchor.page === number).map(anchor => anchor.rect);
              if (rects.length) mapping.set(block.id, { status: "matched", rects });
            }
            return { page, mapping };
          }
          try {
            const data = await pdf.getPageData({ pageIndex: number - 1 });
            if (!data?.chars) throw new Error("当前 Zotero 未提供页面文字坐标");
            const blocks = this.job.blocks.filter(b => b.page === number);
            return { page, mapping: G.locateBlocks(blocks, data.chars, page.view) };
          } catch (error) {
            return { page, mapping: new Map(), mappingError: error.message };
          }
        })();
        this.pages.set(number, promise);
        promise.catch(() => this.pages.delete(number));
        // Keep geometry for only a few recent pages. PDF.js manages its own operator caches.
        while (this.pages.size > 6) {
          const oldest = this.pages.keys().next().value;
          if(!this.borrowed)this.pages.get(oldest).then(({ page }) => page.cleanup()).catch(() => {});
          this.pages.delete(oldest);
        }
      }
      return this.pages.get(number);
    }
    async graphics(onProgress = () => {}, signal) {
      const pdf = await this.ready, regions = [], views = [], layoutTransforms = [], mathRules = [];
      // Operator lists are produced by the PDF.js worker; keep a few in flight
      // so the worker is never idle, while results stay in page order.
      let next = 1, done = 0;
      const one = async n => {
        const native=this.app.nativeSession,raw=await pdf.getPage(n),page=this.borrowed?native.unwrap(raw):raw;
        const options={annotationMode:this.pdfjs.AnnotationMode.DISABLE};
        const result=await page.getOperatorList(this.borrowed?native.clone(options):options),operators=this.borrowed?native.unwrap(result):result;
        if (this.closed || signal?.aborted) throw new Error("解析已取消");
        const rules=[];regions[n-1]=root.ParallelAssetLayout.graphics(operators, this.pdfjs.OPS, page.view,rules);mathRules[n-1]=rules;views[n-1]=[...page.view];
        const [a,b,c,d,e,f]=page.getViewport(this.borrowed?native.clone({scale:1}):{scale:1}).transform; layoutTransforms[n-1]=[a,-b,c,-d,e,-f];
        onProgress(++done / pdf.numPages * 100);
      };
      const lane = async () => {
        while (next <= pdf.numPages) {
          if (this.closed || signal?.aborted) throw new Error("解析已取消");
          await one(next++);
          // Yield between pages. A microtask is enough: getOperatorList resolves through
          // the pdf.js worker's own task queue, and a cancelled window timer would otherwise
          // leave this loop pending forever.
          await Promise.resolve();
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, pdf.numPages) }, lane));
      return { regions, views, layoutTransforms, mathRules };
    }
    async paint(page, rect, canvas, width) {
      if (this.closed) return;
      if(this.borrowed){
        const src=await this.app.nativeSession.crop(page.pageNumber,rect);
        const image=new this.window.Image();image.src=src;await image.decode();
        if(this.closed)return;
        const scale=Math.min(1,Math.max(1,Number(width)||1600)*Math.min(this.window.devicePixelRatio||1,2)/image.naturalWidth,Math.sqrt(3_000_000/Math.max(1,image.naturalWidth*image.naturalHeight)));
        canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
        canvas.getContext("2d",{alpha:false}).drawImage(image,0,0,canvas.width,canvas.height);canvas.dataset.rendered="true";
        return;
      }
      const unit = page.getViewport({ scale: 1 });
      const box = G.viewportRect(rect, unit);
      const cssWidth = Math.max(150, Math.min(1600, width));
      let scale = cssWidth / (box[2] - box[0]) * Math.min(this.window.devicePixelRatio || 1, 2);
      scale = Math.min(scale, Math.sqrt(3_000_000 / ((box[2] - box[0]) * (box[3] - box[1]))), 4);
      const full = page.getViewport({ scale });
      const cropped = G.viewportRect(rect, full);
      const viewport = page.getViewport({ scale, offsetX: -cropped[0], offsetY: -cropped[1] });
      canvas.width = Math.max(1, Math.ceil(cropped[2] - cropped[0]));
      canvas.height = Math.max(1, Math.ceil(cropped[3] - cropped[1]));
      canvas.style.aspectRatio = canvas.width + " / " + canvas.height;
      const task = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport, background: "rgb(255,255,255)" });
      this.tasks.add(task);
      try { await task.promise; canvas.dataset.rendered = "true"; }
      finally { this.tasks.delete(task); }
    }
    cancelRendering() { for (const task of this.tasks) task.cancel(); }
    async close() {
      if (this.closed) return;
      this.closed = true; this.cancelRendering(); this.pages.clear();
      await this.loading?.destroy();
    }
  }
  root.ParallelPDFSession = PDFSession;
})(this);
