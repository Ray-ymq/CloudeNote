import fs from 'node:fs/promises';
await fs.mkdir('dist/cloudnote', { recursive: true });
for (const file of ['manifest.json', 'styles.css']) await fs.copyFile(file, 'dist/cloudnote/' + file);
await fs.copyFile('dist/main.js', 'dist/cloudnote/main.js');
// Small dependency-free ZIP (stored entries) for a portable manual install artifact.
const files = ['main.js', 'manifest.json', 'styles.css'];
const entries = [], directory = []; let offset = 0;
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
for (const file of files) {
  const data = await fs.readFile('dist/cloudnote/' + file), name = Buffer.from('cloudnote/' + file);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x21, 14);
  local.copy(central, 16, 14, 26); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
  entries.push(local, name, data); directory.push(central, name); offset += local.length + name.length + data.length;
}
const centralBytes = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
await fs.writeFile('dist/cloudnote-0.1.0.zip', Buffer.concat([...entries, centralBytes, end]));
console.log('待验收安装目录：dist/cloudnote（尚未发布）');
