import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { emptyTree, MAX_FILE, Tree } from './types';

export const excluded = (name: string) => ['.obsidian', '.trash', '.git', '.cloudnote'].includes(name.toLowerCase()) || name.toLowerCase().startsWith('.cloudnote-tmp-');
export function validatePath(file: string) {
  const parts = file.split('/');
  if (!file || file.length > 240 || parts.some(p => !p || p === '.' || p === '..' || excluded(p) || /[<>:"\\|?*\x00-\x1f\x7f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) {
    throw new Error(`不支持的路径：${file}`);
  }
}
export function validateTree(tree: Tree) {
  const seen = new Set<string>();
  const spellings = new Map<string, string>();
  for (const file of Object.keys(tree).sort()) {
    validatePath(file);
    const parts = file.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/'), key = prefix.normalize('NFC').toLowerCase();
      if (spellings.has(key) && spellings.get(key) !== prefix) throw new Error(`大小写或 Unicode 路径碰撞：${file}`);
      spellings.set(key, prefix);
    }
    const normalized = file.normalize('NFC').toLowerCase();
    if (seen.has(normalized)) throw new Error(`大小写或 Unicode 路径碰撞：${file}`);
    seen.add(normalized);
  }
  for (const file of seen) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join('/'))) throw new Error(`文件与目录路径冲突：${file}`);
  }
}
export async function safePath(root: string, file: string) {
  validatePath(file);
  const full = path.resolve(root, ...file.split('/'));
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('路径越出知识库');
  let cursor = root;
  const parts = file.split('/');
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]!);
    const stat = await fs.lstat(cursor).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
    if (stat?.isSymbolicLink()) throw new Error(`不跟随符号链接：${file}`);
    if (stat && i < parts.length - 1 && !stat.isDirectory()) throw new Error(`父路径不是目录：${file}`);
  }
  return full;
}
export function blobHash(bytes: Buffer) { return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }
export async function readFile(root: string, file: string): Promise<Buffer | undefined> {
  const full = await safePath(root, file);
  try {
    const stat = await fs.lstat(full);
    if (!stat.isFile()) throw new Error(`路径不是普通文件：${file}`);
    if (stat.size > MAX_FILE) throw new Error(`文件超过 100 MiB：${file}`);
    return await fs.readFile(full);
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
export async function scan(root: string) {
  const tree: Tree = emptyTree();
  const skipped: { path: string; reason: string }[] = [];
  async function walk(dir: string, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (excluded(entry.name)) continue;
      const file = prefix + entry.name;
      try { validatePath(file); } catch (error) { skipped.push({ path: file, reason: (error as Error).message }); continue; }
      if (entry.isSymbolicLink()) { skipped.push({ path: file, reason: '不跟随符号链接' }); continue; }
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), file + '/');
      else if (entry.isFile()) {
        try {
          const data = await readFile(root, file);
          if (data) tree[file] = blobHash(data);
        } catch (error) { skipped.push({ path: file, reason: (error as Error).message }); }
      } else skipped.push({ path: file, reason: '不是普通文件' });
    }
  }
  await walk(root); validateTree(tree);
  return { tree, skipped };
}
