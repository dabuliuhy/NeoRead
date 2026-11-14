/* Storage generation 2. Each PDF owns its index; there is no library-wide scan. */
(function (root) {
  "use strict";
  const C = root.ParallelCore || (typeof require === "function" ? require("./core.js") : null);
  const ID = /^[a-f0-9]{32}$/;
  class CacheStore {
    constructor({ directory, io, join, write }) {
      Object.assign(this, { directory, io, join, write });
      this.keys = new Map(); this.indexes = new Map(); this.records = new Map();
      this.indexWrites = new Map(); this.created = new Set();
    }
    init() { return this.io.makeDirectory(this.directory, { createAncestors: true, ignoreExisting: true }); }
    fingerprint(document) {
      const hash = typeof document?.fileHash === "string" ? document.fileHash.trim().toLowerCase() : "";
      if (!hash || hash.length > 128) throw new Error("PDF 内容指纹缺失，无法保存或查找译文。");
      return hash;
    }
    async location(document) {
      const hash = this.fingerprint(document);
      if (!this.keys.has(hash)) this.keys.set(hash, C.digest("pdf:" + hash));
      const key = await this.keys.get(hash), directory = this.join(this.directory, key);
      return { hash, directory, index: this.join(directory, "index.json") };
    }
    async jobPath(job) {
      if (job.schema !== 2 || !ID.test(job.id)) throw new Error("译文不是新版存储格式，无法保存。");
      const location = await this.location(job.document);
      if (!this.created.has(location.directory)) {
        await this.io.makeDirectory(location.directory, { createAncestors: true, ignoreExisting: true });
        this.created.add(location.directory);
      }
      return this.join(location.directory, job.id + ".json");
    }
    async stamp(file) {
      if (!this.io.stat) return null;
      const s = await this.io.stat(file);
      return s.lastModified + ":" + s.size;
    }
    validateIndex(value, hash) {
      if (value?.schema !== 2 || value.pdfHash !== hash || !Array.isArray(value.records) ||
          value.records.some(r => !ID.test(r?.id) || typeof r.language !== "string" || !r.language.trim()) ||
          new Set(value.records.map(r => r.id)).size !== value.records.length) throw new Error("译文索引损坏");
      return value;
    }
    async readRecord(location, id) {
      if (!ID.test(id)) throw new Error("译文文件标识无效");
      const file = this.join(location.directory, id + ".json");
      let error;
      for (const name of [file, file + ".bak"]) {
        try {
          if (!await this.io.exists(name)) continue;
          const stamp = await this.stamp(name), cached = this.records.get(name);
          if (stamp && cached?.stamp === stamp) return cached.job;
          const job = C.restore(JSON.parse(await this.io.readUTF8(name)));
          if (job.id !== id || this.fingerprint(job.document) !== location.hash) throw new Error("译文与索引中的 PDF 不一致");
          this.records.set(name, { stamp, job }); return job;
        } catch (e) { error = e; }
      }
      if (error) throw new Error("无法读取对应译文，已停止自动翻译：" + error.message);
      return null;
    }
    async rebuild(location) {
      // Only repair the directory for this fingerprint, never traverse other PDFs
      // or read generation-1 checkpoints from the parent directory.
      const value = { schema: 2, pdfHash: location.hash, records: [] };
      if (!await this.io.exists(location.directory)) return value;
      const files = await this.io.getChildren(location.directory);
      const ids = new Set(files.map(f => f.split(/[/\\]/).pop()).filter(n => /^[a-f0-9]{32}\.json(?:\.bak)?$/.test(n)).map(n => n.slice(0, 32)));
      for (const id of ids) {
        const job = await this.readRecord(location, id);
        if (job) value.records.push({ id: job.id, language: job.settings.language });
      }
      await this.write(location.index, JSON.stringify(value), true);
      this.indexes.set(location.hash, { value, stamp: await this.stamp(location.index) });
      return value;
    }
    async readIndex(location, refresh = false) {
      const cached = this.indexes.get(location.hash);
      if (cached && !refresh) return cached.value;
      if (await this.io.exists(location.index)) {
        const stamp = await this.stamp(location.index);
        if (stamp && cached?.stamp === stamp) return cached.value;
        try {
          const value = this.validateIndex(JSON.parse(await this.io.readUTF8(location.index)), location.hash);
          this.indexes.set(location.hash, { value, stamp }); return value;
        } catch (_) { /* Derive a new index from this PDF's generation-2 files. */ }
      }
      return this.rebuild(location);
    }
    async load(document, language) {
      const location = await this.location(document);
      return this.serializeIndex(location.hash, async () => {
        let index = await this.readIndex(location, true), result = [];
        let missing = false;
        for (const entry of index.records) {
          if (language && entry.language !== language) continue;
          const job = await this.readRecord(location, entry.id);
          if (job && job.settings.language === entry.language) result.push(job); else missing = true;
        }
        if (missing) {
          index = await this.rebuild(location); result = [];
          for (const entry of index.records) if (!language || entry.language === language) {
            const job = await this.readRecord(location, entry.id); if (job) result.push(job);
          }
        }
        return result;
      });
    }
    async serializeIndex(hash, operation) {
      // Readers can repair an index too. Serialize all index operations for one
      // PDF so simultaneous tabs cannot race on its atomic temporary file.
      const previous = this.indexWrites.get(hash);
      const pending = (async () => {
        await previous?.catch(() => {});
        return operation();
      })();
      this.indexWrites.set(hash, pending);
      try { return await pending; } finally { if (this.indexWrites.get(hash) === pending) this.indexWrites.delete(hash); }
    }
    async register(job) {
      const location = await this.location(job.document);
      return this.serializeIndex(location.hash, async () => {
        const current = await this.readIndex(location);
        if (current.records.some(r => r.id === job.id && r.language === job.settings.language)) return;
        const value = { ...current, records: [...current.records.filter(r => r.id !== job.id), { id: job.id, language: job.settings.language }] };
        // Commit the translation first, then its index. A failed initial index
        // commit stops the runner before any paid request; the file is recoverable.
        await this.write(location.index, JSON.stringify(value), true);
        this.indexes.set(location.hash, { value, stamp: await this.stamp(location.index) });
      });
    }
  }
  if (typeof module !== "undefined") module.exports = CacheStore;
  root.ParallelCacheStore = CacheStore;
})(typeof module !== "undefined" && module.exports ? globalThis : this);
