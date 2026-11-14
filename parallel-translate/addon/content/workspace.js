"use strict";
window.addEventListener("DOMContentLoaded", () => {
  const { app, sourceWindow, nativeSession } = window.ParallelTranslateContext || window.arguments[0];
  if(nativeSession)document.body.classList.add("native-mode");
  const $ = id => document.getElementById(id);
  const settingsSelects=window.ParallelSelects=new window.ParallelSettingsSelects(document.body);
  const settingsTabs=[...document.querySelectorAll('[data-settings-tab]')];
  function selectSettingsTab(name,focus=false){
    settingsSelects.close();
    for(const tab of settingsTabs){const selected=tab.dataset.settingsTab===name;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;if(selected&&focus)tab.focus();}
    for(const panel of document.querySelectorAll('[data-settings-panel]'))panel.hidden=panel.dataset.settingsPanel!==name;
    settingsSelects.syncAll();
  }
  for(const tab of settingsTabs){
    tab.addEventListener('click',()=>selectSettingsTab(tab.dataset.settingsTab));
    tab.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();const index=settingsTabs.indexOf(tab),next=event.key==='Home'?0:event.key==='End'?settingsTabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+settingsTabs.length)%settingsTabs.length;
      selectSettingsTab(settingsTabs[next].dataset.settingsTab,true);
    });
  }
  $("close-native").hidden=!nativeSession;
  $("close-native").addEventListener("click",()=>{if(readerTools.confirmLeave(()=>nativeSession?.close()))nativeSession?.close();});
  let selected = null, preview = null, handled = 0, opening = false, closed = false, noticeTimer, openControl, renderFrame, testControl;
  let settingsOpen = false;
  let modelsControl = null;
  const modelCatalog = new Map();
  const currentJob = () => preview || app.jobs.get(selected);
  function controlled(promise, signal, timeout = 120000) {
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(new Error("解析已取消")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("解析等待超过两分钟。可继续阅读 PDF，稍后点击重新解析。")); }, timeout);
      function cleanup() { clearTimeout(timer); signal.removeEventListener("abort", abort); }
      signal.addEventListener("abort", abort, { once:true });
      Promise.resolve(promise).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
      if (signal.aborted) abort();
    });
  }
  function message(text, error = false) {
    if (closed) return;
    $("notice").textContent = text; $("notice").className = error ? "error" : ""; $("notice").hidden = false;
    clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $("notice").hidden = true, 8000);
  }
  function errorMessage(error) { return error.message || error.safeMessage || (error.status ? "API HTTP " + error.status : "操作未成功，请检查配置与网络。"); }
  async function action(fn) { try { return await fn(); } catch (error) { message(errorMessage(error), true); } }
  function settings() { return { apiType: $("api-type").value, authMode: $("auth-mode").value, reasoningEffort: $("reasoning-effort").value, maxOutputTokens: Number($("max-output-tokens").value), endpoint: $("endpoint").value, model: $("model").value, language: "简体中文", instructions: $("instructions").value, maxChars: Number($("max-chars").value) }; }
  function option(value,label){const node=document.createElementNS("http://www.w3.org/1999/xhtml","option");node.value=value;node.textContent=label;return node;}
  function updateSettingsActions(){
    $("fetch-models").disabled=Boolean(modelsControl);
    $("fetch-models").textContent=modelsControl?"读取中…":"获取模型";window.ParallelIcons?.put($("fetch-models"),"refresh");
    $("model").disabled=!modelCatalog.size||Boolean(modelsControl);
    $("reasoning-effort").disabled=!$("model").value;
    $("test-api").disabled=!$("model").value||Boolean(modelsControl||testControl);
    $("save-settings").disabled=!$("model").value||Boolean(modelsControl);
  }
  function cancelTest(){
    if(testControl){testControl.aborted=true;testControl.cancel?.();testControl=null;}
    $("settings-message").textContent="";updateSettingsActions();
  }
  function cancelModels(){
    if(modelsControl){modelsControl.aborted=true;modelsControl.cancel?.();modelsControl=null;}
    updateSettingsActions();
  }
  function updateEffortOptions(){
    const selected=$("reasoning-effort").value||"auto",model=modelCatalog.get($("model").value);
    const levels=model?window.ParallelAPI.effortOptions(settings(),model):["auto"];
    // Keep an already saved gateway-specific level usable while offline.
    if(model?.saved&&!levels.includes(selected)){
      try{window.ParallelAPI.reasoning({...settings(),reasoningEffort:selected,maxOutputTokens:65536});levels.push(selected);}catch(_){}
    }
    const names={auto:"默认（由模型决定）",none:"None · 不推理",minimal:"Minimal · 最低",low:"Low · 低",medium:"Medium · 中",high:"High · 高",xhigh:"Xhigh · 很高",max:"Max · 最高",ultra:"Ultra · 超高"};
    $("reasoning-effort").replaceChildren(...levels.map(v=>option(v,names[v]||v)));
    $("reasoning-effort").value=levels.includes(selected)?selected:"auto";
    updateReasoningHint();
    if(model&&selected!==$("reasoning-effort").value)$("reasoning-hint").textContent="原推理档位不适用于所选模型，已切回默认。";
    $("model").title=$("model").value;updateSettingsActions();
  }
  function populateModels(models,preferred=""){
    modelCatalog.clear();for(const model of models)modelCatalog.set(model.id,model);
    const placeholder=option("",models.length?"请选择模型":"请先获取模型");placeholder.disabled=true;
    $("model").replaceChildren(placeholder,...models.map(m=>option(m.id,m.name&&m.name!==m.id?m.name+" · "+m.id:m.id)));
    $("model").value=modelCatalog.has(preferred)?preferred:"";
    updateEffortOptions();
    updateLayoutModels();
  }
  // The layout pass may use its own (cheaper) model; an empty choice follows the
  // translation model so a single-model setup needs no extra decision.
  function updateLayoutModels(){
    const saved=$("layout-model").dataset.saved||"";
    const choices=[option("","跟随翻译模型"),...[...modelCatalog.values()].map(m=>option(m.id,m.name&&m.name!==m.id?m.name+" · "+m.id:m.id))];
    if(saved&&!modelCatalog.has(saved))choices.push(option(saved,saved+" · 已保存"));
    $("layout-model").replaceChildren(...choices);
    $("layout-model").value=saved;
  }
  function layoutOptions(){
    return { enabled:$("layout-ai").checked, model:$("layout-model").value||"", effort:$("layout-effort").value||"low" };
  }
  function invalidateModels(){
    cancelModels();cancelTest();populateModels([]);
    $("model-status").dataset.error="false";$("model-status").textContent="连接信息已改变，请重新获取模型。";
  }
  function updateReasoningHint(){try{if($("model").value)window.ParallelAPI.reasoningHint(settings());$("reasoning-hint").textContent="";$("reasoning-hint").dataset.error="false";}catch(e){$("reasoning-hint").textContent=e.message;$("reasoning-hint").dataset.error="true";}}
  for(const id of ["reasoning-effort","api-type","max-output-tokens","model"])$(id).addEventListener("input",updateReasoningHint);
  function updateKeyStatus() { $("key-status").dataset.error="false"; $("key-status").textContent="";$("api-key").placeholder=app.hasKey($("endpoint").value,$("api-type").value)?"已保存的密钥":"API Key"; }
  const protocolChoices = [...document.querySelectorAll('input[name="api-format"]')];
  function updateProtocolControls() {
    const type = $("api-type").value;
    for (const choice of protocolChoices) choice.checked = choice.value === type;
    $("output-limit-label").hidden = type === "openai-chat";
    $("max-output-tokens").disabled = type === "openai-chat";
    updateReasoningHint();
  }
  for (const choice of protocolChoices) choice.addEventListener("change", () => {
    if (!choice.checked) return;
    $("api-type").value = choice.value;
    $("api-type").dispatchEvent(new Event("change"));
  });
  function showSettings() {
    cancelModels();cancelTest();
    const s = app.getSettings();
    for (const id of ["endpoint", "instructions"]) $(id).value = s[id];
    $("api-type").value = s.apiType || "openai-chat"; $("auth-mode").value=s.authMode||"auto";
    $("reasoning-effort").replaceChildren(option(s.reasoningEffort||"auto",s.reasoningEffort||"auto"));
    $("max-output-tokens").value=s.maxOutputTokens||8192;
    $("cache-location").textContent=app.directory;
    $("max-chars").value = String(s.maxChars); $("api-key").value = ""; $("clear-key").checked = false;
    try { $("concurrency").value = String(app.maxConcurrency()); } catch (_) { $("concurrency").value = "4"; }
    try { const f = app.features(); $("formula-ai").checked = f.formulaAI; $("auto-tag").checked = f.autoTag; $("tag-name").value = f.tagName;$("tag-color").value=f.tagColor||'#f19837'; } catch (_) { /* Older host without feature prefs. */ }
    try {
      const l = app.layoutOptions();
      $("layout-ai").checked=l.enabled; $("layout-effort").value=l.effort||"low";
      $("layout-model").dataset.saved=l.model||""; updateLayoutModels();
    } catch (_) { /* Older host without layout prefs. */ }
    try { const paths=app.configPaths(); $("config-location").textContent=paths.prefs || paths.profile || "Zotero profile 目录 / prefs.js"; $("config-location").title="任务队列：" + paths.queue + "\nAI 排版缓存：" + paths.layout; } catch (_) {}
    syncTag();
    syncLayout();
    $("settings-message").textContent = ""; $("settings-message").dataset.error="false"; updateKeyStatus();
    updateProtocolControls();
    populateModels(s.model?[{id:s.model,name:s.model,efforts:null,saved:true}]:[],s.model);
    $("model-status").dataset.error="false";$("model-status").textContent="";
    settingsOpen = true; $("settings-panel").hidden = false; render();
    $("settings-panel").scrollTop=0;
    selectSettingsTab('connection');
  }
  $("settings-toggle").addEventListener("click", showSettings);
  function syncTag(){for(const id of ["tag-name","tag-color","tag-reset"])$(id).disabled=!$("auto-tag").checked;}
  $("auto-tag").addEventListener("change",syncTag);
  $("layout-model").addEventListener("change",()=>{$("layout-model").dataset.saved=$("layout-model").value;});
  $("tag-reset").addEventListener("click",()=>{$("tag-name").value='/翻译';$("tag-color").value='#f19837';});
  function syncLayout() { const off=!$("layout-ai").checked; $("layout-model").disabled=off; $("layout-effort").disabled=off; $("layout-hint").classList.toggle("muted-note", off); }
  $("layout-ai").addEventListener("change", syncLayout);
  $("settings-close").addEventListener("click", () => { settingsSelects.close();cancelModels();cancelTest();settingsOpen=false; $("settings-panel").hidden=true; render(); });
  $("api-type").addEventListener("change", () => {
    const type=$("api-type").value; updateProtocolControls();
    try { const url=new URL($("endpoint").value);
      if (["api.openai.com","api.anthropic.com"].includes(url.hostname)) url.hostname=type==="anthropic"?"api.anthropic.com":"api.openai.com";
      url.pathname=(url.pathname.replace(/\/(?:chat\/completions|responses|messages)\/?$/, "").replace(/\/+$/, "")||"/v1")+(type==="anthropic"?"/messages":type==="openai-responses"?"/responses":"/chat/completions");
      $("endpoint").value=url.href;
    } catch(_) {}
    $("api-key").value=""; $("clear-key").checked=false; updateKeyStatus();
    invalidateModels();
  });
  $("endpoint").addEventListener("input", () => {updateKeyStatus();invalidateModels();});
  $("api-key").addEventListener("input",invalidateModels);
  $("auth-mode").addEventListener("change",invalidateModels);
  $("clear-key").addEventListener("change",invalidateModels);
  $("model").addEventListener("change",()=>{cancelTest();updateEffortOptions();});
  for(const id of ["reasoning-effort","max-output-tokens"])$(id).addEventListener("change",cancelTest);
  $("fetch-models").addEventListener("click",async()=>{
    cancelModels();cancelTest();
    const control=modelsControl={aborted:false},preferred=$("model").value;
    $("model-status").dataset.error="false";$("model-status").textContent="正在读取可用模型…";updateSettingsActions();
    try{
      const models=await app.listModels({...settings(),clearKey:$("clear-key").checked},$("api-key").value,control);
      if(closed||control.aborted||modelsControl!==control)return;
      populateModels(models,preferred);
      $("model-status").textContent="已获取 "+models.length+" 个模型。"+(preferred&&!modelCatalog.has(preferred)?"原模型未在列表中，请重新选择。":"");
    }catch(error){
      if(!closed&&!control.aborted&&modelsControl===control){$("model-status").textContent=errorMessage(error);$("model-status").dataset.error="true";}
    }finally{if(modelsControl===control){modelsControl=null;updateSettingsActions();}}
  });
  $("save-key").addEventListener("click", () => {
    try {
      if (!$("api-key").value.trim()) {
        if (!app.hasKey($("endpoint").value, $("api-type").value)) throw new Error("请先填写 API Key；本机服务无需密钥时可直接保存并应用。");
        updateKeyStatus(); return;
      }
      app.saveKey($("endpoint").value, $("api-type").value, $("api-key").value);
      $("api-key").value=""; $("clear-key").checked=false; updateKeyStatus();$("key-status").textContent="密钥已保存";
    } catch (error) { $("key-status").textContent=errorMessage(error); $("key-status").dataset.error="true"; }
  });
  $("settings-form").addEventListener("invalid", event => {
    const panel=event.target.closest('[data-settings-panel]');if(panel?.hidden)selectSettingsTab(panel.dataset.settingsPanel);
  }, true);
  $("settings-form").addEventListener("submit", event => {
    event.preventDefault();
    try {
      if(modelsControl||!$("model").value)throw new Error("请先获取并选择模型。");
      app.saveSettings(settings(), $("api-key").value, $("clear-key").checked);
      app.setConcurrency(Number($("concurrency").value)||4);
      app.setFeatures({ formulaAI: $("formula-ai").checked, autoTag: $("auto-tag").checked, tagName: $("tag-name").value,tagColor:$("tag-color").value,tagVersion:1 });
      app.setLayoutOptions(layoutOptions());
      cancelTest();
      settingsSelects.close();$("api-key").value = ""; settingsOpen=false; $("settings-panel").hidden=true;
      action(()=>app.open(sourceWindow, currentJob()?.document.attachmentID || app.openRequest?.itemID));
    } catch (error) { $("settings-message").textContent = errorMessage(error); $("settings-message").dataset.error="true"; }
  });
  $("test-api").addEventListener("click", async () => {
    if(!$("model").value)return;
    cancelTest();const control=testControl={aborted:false};updateSettingsActions();
    $("settings-message").textContent = "正在调用所选模型测试…"; $("settings-message").dataset.error="false";
    try { const result=await app.testConnection({...settings(),clearKey:$("clear-key").checked}, $("api-key").value, control);if(!closed&&!control.aborted&&testControl===control)$("settings-message").textContent=result; }
    catch (error) { if(!closed&&!control.aborted&&testControl===control){$("settings-message").textContent = errorMessage(error); $("settings-message").dataset.error="true";} }
    finally { if(testControl===control){testControl=null;updateSettingsActions();} }
  });
  const reading = new window.ParallelReadingView(app, {
    message,
    pageChanged: page => {
      $("jump-page").value = String(page);
      settingsSelects.syncAll();
      $("previous-page").disabled = page <= 1;
      $("next-page").disabled = page >= (currentJob()?.document.pages || 1);
    }
  });
  const readerTools=new window.ParallelReaderTools(reading,message);
  window.addEventListener('unload',()=>readerTools.close());
  let appearanceFrame=null;
  function applyAppearance(value){
    const pane=reading.translationPane,top=pane.getBoundingClientRect().top;
    const anchor=[...reading.visibleRows].filter(n=>n.getBoundingClientRect().bottom>top).sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top)[0];
    const offset=anchor?.getBoundingClientRect().top;
    const style=document.documentElement.style;
    style.setProperty("--reading-size",value.size+"px");style.setProperty("--reading-leading",value.leading);style.setProperty("--reading-width",value.width+"rem");
    const fonts={serif:'Georgia, "Times New Roman"',georgia:'Georgia',cambria:'Cambria',times:'"Times New Roman"',sans:'Arial, "Microsoft YaHei"',kai:'"Times New Roman", "KaiTi"'};
    style.setProperty("--reading-font",(fonts[value.font]||fonts.serif)+', "Songti SC", "SimSun", "Noto Serif CJK SC", serif');
    style.setProperty("--reading-align",value.align||'justify');
    document.body.classList.toggle('thumbnail-hidden',value.thumbnail===false);readerTools.thumb.hidden=value.thumbnail===false;
    for(const key of ["font","size","leading","width","align"])$("reading-"+key).value=value[key];
    $("reading-thumbnail").checked=value.thumbnail!==false;
    $("reading-size-label").textContent=value.size+" px";
    settingsSelects.syncAll();
    if(anchor){reading.scrollOrigin=null;pane.scrollTop+=anchor.getBoundingClientRect().top-offset;}
    readerTools.repositionPopups?.();
  }
  function showAppearance(show){if(settingsSelects.active?.select.closest('#appearance-panel'))settingsSelects.close();$("appearance-panel").hidden=!show;$("appearance-toggle").setAttribute("aria-expanded",String(show));if(show)$("reading-font-trigger").focus();}
  applyAppearance(app.getAppearance());
  $("appearance-toggle").addEventListener("click",()=>showAppearance($("appearance-panel").hidden));
  $("appearance-close").addEventListener("click",()=>{showAppearance(false);$("appearance-toggle").focus();});
  $("settings-toggle").addEventListener("click",()=>showAppearance(false));
  document.addEventListener("pointerdown",event=>{if(!event.target.closest("#appearance-panel,#appearance-toggle,.settings-select-menu"))showAppearance(false);});
  document.addEventListener("keydown",event=>{if(event.key==="Escape"&&!$("appearance-panel").hidden){showAppearance(false);$("appearance-toggle").focus();event.stopPropagation();}});
  for(const key of ["font","size","leading","width","align","thumbnail"])$("reading-"+key).addEventListener("input",()=>{
    if(appearanceFrame)return;
    appearanceFrame=requestAnimationFrame(()=>{appearanceFrame=null;applyAppearance(app.saveAppearance(Object.fromEntries(["font","size","leading","width","align","thumbnail"].map(k=>[k,k==="thumbnail"?$("reading-"+k).checked:$("reading-"+k).value]))));});
  });
  for(const [id,delta] of [['reading-smaller',-1],['reading-larger',1]])$(id).addEventListener('click',()=>{applyAppearance(app.saveAppearance({...app.getAppearance(),size:Number($('reading-size').value)+delta}));});
  $("appearance-reset").addEventListener("click",()=>applyAppearance(app.saveAppearance({})));
  window.addEventListener("unload",()=>{if(appearanceFrame)cancelAnimationFrame(appearanceFrame);});
  $("start").addEventListener("click", () => action(async()=>{
    if(preview)return app.open(sourceWindow,preview.document.attachmentID);
    const job=await app.startJob(selected);if(job&&!closed){selected=job.id;render();}
  }));
  $("pause").addEventListener("click", () => { app.pauseJob(selected); render(); });
  $("cancel-parse").addEventListener("click", () => {
    openControl?.abort(); opening = false;
    if (preview) { preview.status = "paused"; preview.error = "解析已取消，可继续阅读原文。"; }
    render();
  });
  $("retry-open").addEventListener("click", () => app.open(sourceWindow, app.openRequest?.itemID));
  $("jump-page").addEventListener("change", () => action(() => reading.goPage(Number($("jump-page").value))));
  $("previous-page").addEventListener("click", () => action(() => reading.goPage(reading.currentPage - 1)));
  $("next-page").addEventListener("click", () => action(() => reading.goPage(reading.currentPage + 1)));
  $("pdf-zoom").addEventListener("change", () => reading.setZoom(Number($("pdf-zoom").value) / 100));
  $("reload-pdf").addEventListener("click", () => reading.reload());
  $("sync-scroll").addEventListener("change", () => { reading.scrollOrigin = null; });
  const divider = $("pane-divider"); let dragging = false, ratio = 50;
  function setRatio(value) {
    ratio = Math.max(25, Math.min(75, value));
    $("reading-panes").style.setProperty("--source-width", ratio + "%"); divider.setAttribute("aria-valuenow", String(Math.round(ratio)));
  }
  divider.addEventListener("pointerdown", event => { dragging = true; reading.scrollOrigin = null; divider.setPointerCapture(event.pointerId); event.preventDefault(); });
  divider.addEventListener("pointermove", event => {
    if (!dragging) return; const rect = $("reading-panes").getBoundingClientRect(); setRatio(100 * (event.clientX - rect.left) / rect.width);
  });
  divider.addEventListener("pointerup", () => { dragging = false; });
  divider.addEventListener("lostpointercapture", () => { dragging = false; });
  divider.addEventListener("keydown", event => {
    if (["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) { event.preventDefault(); setRatio(event.key === "Home" ? 50 : ratio + (event.key === "ArrowRight" ? 2 : -2)); }
  });
  function render() {
    if (closed) return;
    const job = currentJob();
    const queued=job&&!job.preview&&app.queue?.entries.some(e=>(e.jobID===job.id||!job.resumeNeedsConfiguration&&e.key===app.queueKey(job.document.attachmentID,job.settings))&&['waiting','parsing'].includes(e.state));
    $("empty").hidden = settingsOpen || Boolean(job); $("reader").hidden = settingsOpen || !job;
    $("start").hidden = !job || opening || queued || job.status === "running" || job.status === "complete";
    $("start").textContent = job?.preview ? "重新解析" : "继续翻译"; window.ParallelIcons?.put($("start"), job?.preview ? "refresh" : "play");
    $("pause").hidden = !job || (!queued && job.status !== "running");
    $("cancel-parse").hidden = !opening;
    $("job-error").hidden = !job?.error; $("job-error").textContent = job?.error || "";
    document.body.classList.toggle("is-running", Boolean(job && (opening || queued || job.status === "running")));
    document.body.classList.toggle("is-complete", Boolean(job && !job.preview && job.status === "complete"));
    if (!job) return;
    const n = job.blocks.filter(b => b.status === "complete").length;
    $("document-title").textContent = job.document.title; $("document-title").title = job.document.title;
    const state = queued?'等待前一篇完成':{ ready: "待翻译", running: "翻译中", paused: "已暂停", failed: "待重试", complete: "已完成" }[job.status];
    $("progress-label").textContent = job.preview ? (opening ? (job.stage || "正在打开 PDF…") : "解析已暂停") : state + (job.status === "complete" ? "" : " · " + Math.round(100 * n / Math.max(1,job.blocks.length)) + "%");
    $("progress").max = Math.max(1,job.blocks.length); $("progress").value = n; $("progress").dataset.complete=String(job.status==='complete');
    $("progress-label").dataset.state = queued ? "queued" : job.preview ? "parsing" : job.status;
    $("start").disabled = app.starting || opening;
    $("pause").disabled = Boolean(app.runners.get(job.id)?.stop);
    $("target-label").textContent = job.settings.language;
    if ($("jump-page").dataset.jobId !== job.id || $("jump-page").options.length !== job.document.pages) {
      $("jump-page").replaceChildren(...Array.from({ length: job.document.pages }, (_, i) => {
        const option = document.createElementNS("http://www.w3.org/1999/xhtml", "option"); option.textContent = (i + 1) + " / " + job.document.pages; option.value = i + 1; return option;
      }));
      $("jump-page").dataset.jobId = job.id;
    }
    readerTools.setJob(job);
    if (job.preview && $("rows").querySelector(".parse-placeholder")) $("rows").querySelector(".parse-placeholder").textContent = job.error || job.stage || "正在解析论文排版…";
  }
  async function openRequested() {
    const request = app.openRequest;
    if (closed || !request || request.sequence === handled) return;
    openControl?.abort();
    const control = new AbortController(); openControl = control;
    const active = () => !closed && openControl === control && !control.signal.aborted;
    handled = request.sequence; opening = true;
    try {
      const itemID = request.itemID || (await app.resolveAttachment(request.sourceWindow)).id;
      if (!active()) return;
      $("empty-message").textContent = "正在查找已有译文…"; $("retry-open").hidden = true;
      const document = await controlled(app.prepareAttachment(itemID), control.signal);
      if (!active()) return;
      const saved = await controlled(app.findSavedTranslation(document), control.signal);
      if (!active()) return;
      if (saved) { selected=saved.id; preview=null; render(); return; }
      if (!app.getSettings().model) {
        selected = null; preview = null; render(); $("empty-message").textContent = "请先设置翻译模型。"; showSettings(); return;
      }
      selected = null;
      preview = { id:"preview-"+request.sequence,preview:true,document,settings:app.getSettings(),structure:[],blocks:[],status:"parsing" };
      render();
      await controlled(reading.metadataReady, control.signal);
      if (!active()) return;
      preview.stage = "解析排版…"; render();
      const session = reading.session;
      const progress = (label,value) => { if (active() && preview) { preview.stage=label+" · "+Math.round(value)+"%"; render(); } };
      let reused = false;
      const job = await controlled(app.createFromAttachment(itemID, {
        onCache:()=>{reused=true;},
        document,signal:control.signal,onProgress:value=>progress("解析段落",value),onStage:label=>{if(preview&&active()){preview.stage=label;render();}},
        ...(nativeSession?{structured:()=>nativeSession.structured()}:{}),
        graphics:()=>session.graphics(value=>progress("核对图文",value),control.signal)
      }), control.signal);
      if (!active()) return;
      selected = job.id; preview = null; render();
      if (job.layoutReport?.ai?.summary && !job.layoutReport.ai.skipped && job.layoutReport.ai.summary !== "无需调整") message("AI 排版：" + job.layoutReport.ai.summary + "。");
      else if (job.layoutReport?.unmatchedCaptions?.length) Promise.resolve(reading.tools?.ready).then(()=>{if(active()&&job.layoutReport?.unmatchedCaptions?.length)message("部分图注未能可靠关联，已保留原文定位，可点击核对。");}).catch(()=>{});
      if (!reused && job.status !== "complete") action(() => app.startJob(job.id));
    } catch (error) {
      if (active()) {
        if (preview) { preview.error=errorMessage(error); preview.status="paused"; }
        else { $("empty-message").textContent=errorMessage(error); $("retry-open").hidden=false; }
        control.abort();
      }
    } finally {
      if (openControl === control) { opening = false; render(); }
    }
  }
  const unsubscribe = app.subscribe(() => {
    if (!renderFrame) renderFrame=requestAnimationFrame(()=>{renderFrame=null; if(!closed){render();openRequested();}});
  });
  window.addEventListener("unload", () => { closed = true;settingsSelects.destroy(); openControl?.abort(); cancelModels();cancelTest(); if(renderFrame)cancelAnimationFrame(renderFrame); unsubscribe(); clearTimeout(noticeTimer); reading.close(); });
  render(); openRequested();
  if (app.warnings.length) message(app.warnings.join(" "), true);
});
