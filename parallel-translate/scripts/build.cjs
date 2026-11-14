const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) { crc ^= value; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const compressed = zlib.deflateRawSync(data); const crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(33, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(compressed.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(filename.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(33, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(compressed.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(filename.length, 28); c.writeUInt32LE(offset, 42);
    local.push(h, filename, compressed); central.push(c, filename); offset += h.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(entries.length, 8); footer.writeUInt16LE(entries.length, 10); footer.writeUInt32LE(directory.length, 12); footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, footer]);
}
const runtimeFiles=new Set(['bootstrap.js','manifest.json',...['api.js','cache-store.js','asset-layout.js','cite-view.js','core.js','document.js','host.js','icons.js','layout-ai.js','math.js','native-divider.js','native-link.js','native-reader.js','pdf-layout.js','pdf-view.js','queue.js','queue-view.js','reader-view.js','reader-model.js','reader-selection.js','reader-interactions.js','reader-editor.js','reader-host.js','reader-native.js','reader-tools.js','reader-tools.css','references.js','reflow.js','reading.css','workspace.css','workspace.js','workspace.xhtml','icons/icon.svg','icons/icon48.png','icons/icon96.png'].map(f=>'content/'+f),...['katex.min.js','katex.min.css','LICENSE.txt'].map(f=>'content/vendor/katex/'+f)]);
function validateAddon(base=path.resolve(__dirname,'..')) {
  runtimeFiles.add('content/icons/LICENSE.txt');
  runtimeFiles.add('content/settings-controls.js');
  runtimeFiles.add('content/icons/mark.svg');
  const manifest = JSON.parse(fs.readFileSync(path.join(base, 'addon/manifest.json')));
  const pkg=JSON.parse(fs.readFileSync(path.join(base,'package.json')));
  if(manifest.version!==pkg.version||!/^\d+\.\d+\.\d+$/.test(pkg.version))throw Error('Package and manifest versions must match');
  if(manifest.applications?.zotero?.id!=='parallel-translate@local')throw Error('Unexpected addon ID');
  if(!/^https:\/\//.test(manifest.applications.zotero.update_url||''))throw Error('Zotero requires an HTTPS update_url, even for manual installation');
  const entries = [];
  function walk(relative) {
    for (const name of fs.readdirSync(path.join(base, 'addon', relative)).sort()) {
      const rel = path.posix.join(relative, name), file = path.join(base, 'addon', rel);
      const stat=fs.lstatSync(file);
      if(stat.isSymbolicLink())throw Error('Packaged symlink: '+rel);
      if (stat.isDirectory()) walk(rel);
      else {
        if (!runtimeFiles.has(rel)&&!/^content\/vendor\/katex\/fonts\/KaTeX_[A-Za-z0-9_-]+\.woff2$/.test(rel)) throw new Error('Unexpected packaged file: ' + rel);
        const data = fs.readFileSync(file);
        if (name.endsWith('.js')) new vm.Script(data.toString(), { filename: rel });
        entries.push([rel, data]);
      }
    }
  }
  walk('');
  const files=new Map(entries);
  for(const name of runtimeFiles)if(!files.has(name))throw Error('Missing required runtime file: '+name);
  const verify=(from,ref)=>{
    if(/^(?:https?:|data:|#)/i.test(ref))throw Error('Unexpected external runtime resource: '+ref);
    const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(from),ref));
    if(!files.has(resolved))throw Error('Missing local resource: '+resolved);
  };
  for(const [name,data] of entries){
    const source=data.toString();
    if(name.endsWith('.xhtml'))for(const m of source.matchAll(/(?:src|href)=["']([^"']+)["']/g))verify(name,m[1]);
    if(name.endsWith('.css'))for(const m of source.matchAll(/url\(["']?([^'"\)]+)["']?\)/g))if(!/\.(?:woff|ttf)$/.test(m[1]))verify(name,m[1]);
  }
  for(const m of files.get('bootstrap.js').toString().matchAll(/rootURI\s*\+\s*["'](content\/[^"']+)["']/g))if(!files.has(m[1]))throw Error('Missing bootstrap script: '+m[1]);
  entries.push(['LICENSE', fs.readFileSync(path.join(base, 'LICENSE'))]);
  return {manifest,entries};
}
function build() {
  const base=path.resolve(__dirname,'..'),{manifest,entries}=validateAddon(base);
  const archive = zip(entries);
  const output = path.join(base, 'parallel-translate-' + manifest.version + '.xpi');
  fs.writeFileSync(output+'.tmp', archive);fs.renameSync(output+'.tmp',output);
  fs.writeFileSync(output + '.sha256', crypto.createHash('sha256').update(archive).digest('hex') + '  ' + path.basename(output) + '\n');
  console.log(JSON.stringify({ output, bytes: archive.length, files:entries.length,sha256:crypto.createHash('sha256').update(archive).digest('hex') }, null, 2));
  return output;
}
if (require.main === module) build();
module.exports = { zip, build, validateAddon };
