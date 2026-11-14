/* Zotero 10 bootstrap: host globals are supplied by Zotero.Plugins. */
var chromeHandle;
var scope;
async function startup({ rootURI }, reason) {
  await Zotero.initializationPromise;
  // The previous instance must finish its atomic checkpoint before cache hydration.
  await Zotero.ParallelTranslateShutdown;
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup)
    .registerChrome(manifestURI, [["content", "paralleltranslate", rootURI + "content/"]]);
  scope = { Zotero, Services, IOUtils, PathUtils, Components, ChromeUtils, crypto, TextEncoder, URL, setTimeout, clearTimeout };
  const startingScope = scope;
  Services.scriptloader.loadSubScript(rootURI + "content/api.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/core.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/cache-store.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/vendor/katex/katex.min.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/math.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/document.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/reader-selection.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/reader-model.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/reader-host.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/asset-layout.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/references.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/reflow.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/layout-ai.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/pdf-layout.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/pdf-view.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/queue.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/queue-view.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/native-link.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/native-divider.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/native-reader.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/reader-native.js", startingScope);
  Services.scriptloader.loadSubScript(rootURI + "content/host.js", startingScope);
  await startingScope.ParallelTranslate.init();
  if (scope !== startingScope || startingScope.ParallelTranslate.closed) return;
  Zotero.ParallelTranslate = startingScope.ParallelTranslate;
  for (const window of Zotero.getMainWindows()) startingScope.ParallelTranslate.addWindow(window);
}
function onMainWindowLoad({ window }) { scope?.ParallelTranslate?.addWindow(window); }
function onMainWindowUnload({ window }) { scope?.ParallelTranslate?.removeWindow(window); }
async function shutdown() {
  // Zotero can enable the next instance while an old checkpoint is still flushing.
  // Detach globals and UI registration synchronously, then await only old-instance IO.
  const oldApp = scope?.ParallelTranslate, oldChrome = chromeHandle;
  scope = null; chromeHandle = null;
  if (Zotero.ParallelTranslate === oldApp) delete Zotero.ParallelTranslate;
  let pending;
  try { pending = oldApp?.shutdown(); }
  finally { oldChrome?.destruct(); }
  const completion = Promise.resolve(pending);
  Zotero.ParallelTranslateShutdown = completion;
  try { await completion; }
  finally { if (Zotero.ParallelTranslateShutdown === completion) delete Zotero.ParallelTranslateShutdown; }
}
function install() {}
function uninstall() {}
