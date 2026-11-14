const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
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
function build() {
  const base = path.resolve(__dirname, '..');
  const files = ['manifest.json', 'bootstrap.js', 'content/core.js', 'content/main.js', 'content/style.css'];
  const entries = files.map(name => {
    const bytes = fs.readFileSync(path.join(base, 'addon', name));
    if (name.endsWith('.js')) new vm.Script(bytes.toString(), { filename: name });
    return [name, bytes];
  });
  const manifest = JSON.parse(entries[0][1]);
  if (manifest.version !== require('../package.json').version) throw Error('Version mismatch');
  entries.push(['LICENSE', fs.readFileSync(path.join(base, 'LICENSE'))]);
  const bytes = zip(entries);
  const output = path.join(base, 'bilingual-titles-' + manifest.version + '.xpi');
  fs.writeFileSync(output + '.tmp', bytes);
  fs.renameSync(output + '.tmp', output);
  fs.writeFileSync(output + '.sha256', crypto.createHash('sha256').update(bytes).digest('hex') + '  ' + path.basename(output) + '\n');
  return output;
}
if (require.main === module) console.log(build());
module.exports = { build };
