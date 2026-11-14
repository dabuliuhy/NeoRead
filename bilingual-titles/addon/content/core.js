(function (root) {
  "use strict";
  const translationKey = /(?:^|[-_.])(?:titleTranslation|translatedTitle|title_translation)$/i;
  const extraKey = /^(?:titleTranslation|title[ _-]translation|translated[ _-]?title|标题翻译|译文标题|翻译标题)$/i;
  const normalize = value => typeof value === "string" ? value.replace(/[\r\n\t ]+/g, " ").trim() : "";
  function translationFromExtra(extra) {
    if (typeof extra !== "string") return "";
    for (const line of extra.split(/\r?\n/)) {
      const match = line.match(/^\s*([^:：]+?)\s*[:：]\s*(.*)$/);
      if (match && extraKey.test(match[1])) {
        const value = normalize(match[2]);
        if (value) return value;
      }
    }
    return "";
  }
  function isTranslationColumn(column) {
    return translationKey.test(column.dataKey || "");
  }
  function metadataKind(key) {
    if (/(?:^|[-_.])(?:publicationTags|tags|coloredTags)$/i.test(key)) return "tags";
    if (/^(?:publicationTitle|publisher|conferenceName|journalAbbreviation|firstCreator)$/.test(key)) return "text";
    return "value";
  }
  function clonePrefs(prefs) {
    return Object.fromEntries(Object.entries(prefs || {}).map(([key, value]) => [key, { ...value }]));
  }
  // The hidden flag is a view overlay. Native column resizes must not save it.
  function overlayPrefs(prefs, columns, hide) {
    const result = clonePrefs(prefs);
    if (hide) for (const column of columns) {
      if (isTranslationColumn(column)) result[column.dataKey] = { ...result[column.dataKey], hidden: true };
    }
    return result;
  }
  function preserveVisibility(next, current, columns, hide) {
    const result = clonePrefs(next);
    if (hide) for (const column of columns) {
      if (!isTranslationColumn(column) || !result[column.dataKey]) continue;
      if (Object.hasOwn(current[column.dataKey] || {}, "hidden")) {
        result[column.dataKey].hidden = current[column.dataKey].hidden;
      } else delete result[column.dataKey].hidden;
    }
    return result;
  }
  const api = { normalize, translationFromExtra, isTranslationColumn, metadataKind, overlayPrefs, preserveVisibility };
  root.BilingualTitlesCore = api;
  if (typeof module !== "undefined") module.exports = api;
})(this);
