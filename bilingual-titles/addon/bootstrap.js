var scope;
async function startup({ rootURI }) {
  await Zotero.initializationPromise;
  scope = { Zotero, Services };
  Services.scriptloader.loadSubScript(rootURI + "content/core.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "content/main.js", scope);
  scope.BilingualTitles.init(rootURI);
  Zotero.BilingualTitles = scope.BilingualTitles;
  for (const window of Zotero.getMainWindows()) scope.BilingualTitles.addWindow(window);
}
function onMainWindowLoad({ window }) { scope?.BilingualTitles?.addWindow(window); }
function onMainWindowUnload({ window }) { scope?.BilingualTitles?.removeWindow(window); }
function shutdown() {
  const app = scope?.BilingualTitles;
  scope = null;
  app?.shutdown();
  if (Zotero.BilingualTitles === app) delete Zotero.BilingualTitles;
}
function install() {}
function uninstall() {}
