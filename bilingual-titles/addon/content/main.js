/* All patches are scoped to the main library view and are reversible. */
var BilingualTitles = {
  windows: new Map(),
  active: true,
  defaults: { enabled: true, hideSeparate: true, centerMetadata: true, wrapMetadata: true, compact: false },
  init(rootURI) { this.rootURI = rootURI; },
  pref(key) { return Services.prefs.getBoolPref("extensions.bilingualtitles." + key, this.defaults[key]); },
  setPref(key, value) {
    if (!(key in this.defaults)) throw new Error("Unknown Bilingual Titles preference: " + key);
    Services.prefs.setBoolPref("extensions.bilingualtitles." + key, Boolean(value));
    for (const state of this.windows.values()) this.refresh(state);
  },
  report(error) { Zotero.logError(error); },
  addWindow(window) {
    if (!this.active || this.windows.has(window)) return;
    const state = { window, view: null, tree: null, undoView: [], undoTree: [], alive: true };
    this.windows.set(window, state);
    const doc = window.document;
    state.style = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
    state.style.setAttribute("rel", "stylesheet");
    state.style.setAttribute("href", this.rootURI + "content/style.css");
    doc.documentElement.append(state.style);
    this.addMenu(state);
    const tick = () => {
      if (!state.alive || !this.active || window.closed) return;
      try { this.attach(state); } catch (error) { this.report(error); }
      state.timer = window.setTimeout(tick, 800);
    };
    tick();
  },
  patch(target, key, make, undo) {
    const original = target[key];
    if (typeof original !== "function") throw new Error("Unsupported Zotero method: " + key);
    const own = Object.hasOwn(target, key);
    const wrapper = make(original);
    target[key] = wrapper;
    undo.push(() => {
      // Never remove a patch installed by another add-on after this one.
      if (target[key] !== wrapper) return;
      if (own) target[key] = original;
      else delete target[key];
    });
  },
  attach(state) {
    if (!state.menu) this.addMenu(state);
    const view = state.window.ZoteroPane?.itemsView;
    if (!view?.tree || !view.domEl) return;
    if (state.view !== view) {
      this.detach(state);
      state.view = view;
      const app = this;
      const applies = () => app.active && state.alive && state.view === view && app.pref("enabled");
      const readPrefs = view._getColumnPrefs;
      this.patch(view, "_getColumnPrefs", original => function (...args) {
        const prefs = original.apply(this, args);
        return applies() ? BilingualTitlesCore.overlayPrefs(prefs, this.getColumns(), app.pref("hideSeparate")) : prefs;
      }, state.undoView);
      this.patch(view, "_storeColumnPrefs", original => function (prefs, ...args) {
        if (applies()) prefs = BilingualTitlesCore.preserveVisibility(
          prefs, readPrefs.call(this), this.getColumns(), app.pref("hideSeparate"));
        return original.call(this, prefs, ...args);
      }, state.undoView);
      this.patch(view, "_renderItem", original => function (index, ...args) {
        const row = original.call(this, index, ...args);
        if (applies()) {
          try { app.decorateRow(state, this, row, index, args[2] || []); }
          catch (error) { app.report(error); }
        }
        return row;
      }, state.undoView);
      state.needsRefresh = true;
    }
    if (state.tree !== view.tree) {
      for (const undo of state.undoTree.splice(0).reverse()) undo();
      const tree = state.tree = view.tree;
      const app = this;
      this.patch(tree, "_getRowHeight", original => function (...args) {
        const base = original.apply(this, args);
        if (!app.active || !state.alive || state.tree !== tree || !app.pref("enabled")) return base;
        const size = parseFloat(state.window.getComputedStyle(view.domEl).fontSize) || 13;
        return Math.max(base, Math.ceil(size * 2.7 + (app.pref("compact") ? 8 : 14)));
      }, state.undoTree);
      state.needsRefresh = true;
    }
    if (state.needsRefresh) {
      state.needsRefresh = false;
      this.refresh(state);
    }
  },
  refresh(state) {
    const view = state.view;
    if (!view || !state.alive) return;
    const active = this.active && this.pref("enabled");
    view.domEl.classList.toggle("bt-enabled", active);
    view.domEl.classList.toggle("bt-centered", active && this.pref("centerMetadata"));
    view.domEl.classList.toggle("bt-wrapped", active && this.pref("wrapMetadata"));
    view._columnsId = null;
    view.forceUpdate(() => {
      if (!state.alive || !view.tree?._jsWindow) return;
      view.tree.updateFontSize();
      view.tree.invalidate();
    });
  },
  decorateRow(state, view, row, index, columns) {
    if (!row) return;
    // Zotero recycles row elements for attachments, annotations and section headers.
    row.classList.remove("bt-item");
    const item = view.getRow(index)?.ref;
    if (!item?.isRegularItem?.()) return;
    row.classList.add("bt-item");
    const titleCell = row.querySelector(".cell.title");
    const text = titleCell?.querySelector(".cell-text");
    if (text) {
      const originalTitle = item.getDisplayTitle();
      const translated = BilingualTitlesCore.translationFromExtra(item.getField("extra"));
      const doc = row.ownerDocument;
      const original = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      original.className = "bt-original";
      original.dir = "auto";
      // Zotero's own sanitizer preserves scientific italics, subscripts and superscripts.
      Zotero.Utilities.Internal.renderItemTitle(originalTitle, original);
      const showTranslation = translated && BilingualTitlesCore.normalize(original.textContent) !== translated;
      const decorations = Array.from(text.children).filter(node => node.style.position === "absolute");
      text.replaceChildren(original);
      text.classList.add("bt-title-stack");
      text.classList.toggle("bt-has-translation", Boolean(showTranslation));
      if (showTranslation) {
        const translation = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        translation.className = "bt-translation";
        translation.dir = "auto";
        translation.textContent = translated;
        text.append(translation);
      }
      text.append(...decorations);
      const nativeLabel = text.getAttribute("aria-label") || original.textContent;
      if (showTranslation) text.setAttribute("aria-label", nativeLabel + " 译文：" + translated);
      titleCell.setAttribute("title", original.textContent + (showTranslation ? "\n" + translated : ""));
    }
    for (const column of columns) {
      if (column.dataKey === "title" || column.hidden) continue;
      const cell = Array.from(row.children).find(node => node.classList.contains(column.dataKey));
      if (!cell) continue;
      cell.dataset.btKind = BilingualTitlesCore.metadataKind(column.dataKey);
      if (!cell.children.length) cell.classList.add("bt-plain");
      if (!cell.getAttribute("title") && cell.textContent.trim()) cell.setAttribute("title", cell.textContent.trim());
    }
  },
  addMenu(state) {
    const doc = state.window.document;
    const host = doc.getElementById("menu_ToolsPopup");
    if (!host) return;
    const menu = state.menu = doc.createXULElement("menu");
    menu.id = "bilingual-titles-menu";
    menu.setAttribute("label", "双行标题");
    const popup = doc.createXULElement("menupopup");
    menu.append(popup);
    const labels = {
      enabled: "启用双行标题",
      hideSeparate: "合并后隐藏单独的译文列",
      centerMetadata: "其他列居中",
      wrapMetadata: "列标题和内容过长时自动换行（最多两行）",
      compact: "紧凑行距"
    };
    for (const [key, label] of Object.entries(labels)) {
      const node = doc.createXULElement("menuitem");
      node.setAttribute("type", "checkbox");
      node.setAttribute("label", label);
      node.dataset.btPref = key;
      node.addEventListener("command", () => this.setPref(key, !this.pref(key)));
      popup.append(node);
    }
    popup.addEventListener("popupshowing", event => {
      if (event.target !== popup) return;
      for (const node of popup.children) node.setAttribute("checked", String(this.pref(node.dataset.btPref)));
    });
    host.append(menu);
  },
  detach(state) {
    const view = state.view, tree = state.tree;
    state.view = null;
    state.tree = null;
    for (const undo of state.undoTree.splice(0).reverse()) undo();
    for (const undo of state.undoView.splice(0).reverse()) undo();
    view?.domEl?.classList.remove("bt-enabled", "bt-centered", "bt-wrapped");
    if (view && tree?._jsWindow && !state.window.closed) {
      view._columnsId = null;
      view.forceUpdate(() => {
        try { tree.updateFontSize(); tree.invalidate(); } catch (error) { this.report(error); }
      });
    }
  },
  removeWindow(window) {
    const state = this.windows.get(window);
    if (!state) return;
    state.alive = false;
    window.clearTimeout(state.timer);
    this.detach(state);
    state.menu?.remove();
    state.style?.remove();
    this.windows.delete(window);
  },
  shutdown() {
    this.active = false;
    for (const window of Array.from(this.windows.keys())) this.removeWindow(window);
  }
};
