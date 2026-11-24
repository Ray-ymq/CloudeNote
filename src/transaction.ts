import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { Git } from './git';
import { blobHash, readFile, safePath, validatePath } from './paths';
import { Change } from './types';

interface Journal {
  version: 1;
  id: string;
  before?: string;
  after: string;
  changes: Change[];
}
export class Transaction {
  readonly directory: string;
  constructor(readonly git: Git) { this.directory = path.join(git.root, '.git/cloudnote'); }
  private async atomic(file: string, bytes: Buffer) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), '.cloudnote-tmp-' + randomUUID());
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temporary, file); } catch (e) { await fs.unlink(temporary).catch(() => undefined); throw e; }
  }
  private async hash(file: string) {
    const bytes = await readFile(this.git.root, file);
    return bytes ? blobHash(bytes) : undefined;
  }
  private async exists(file: string) {
    return fs.lstat(file).then(() => true).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; });
  }
  private async publish(file: string, source: string) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), '.cloudnote-tmp-' + randomUUID());
    try {
      await fs.copyFile(source, temporary, constants.COPYFILE_EXCL);
      // link is atomic and never replaces a file created by an editor during the write.
      await fs.link(temporary, file);
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  }
  async recover() {
    const journalFile = path.join(this.directory, 'journal.json');
    let journal: Journal;
    try { journal = JSON.parse(await fs.readFile(journalFile, 'utf8')) as Journal; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    if (journal.version !== 1 || !/^[a-f0-9-]{36}$/.test(journal.id) || !/^[a-f0-9]{40}$/.test(journal.after)) throw new Error('操作日志损坏，请保留 .git/cloudnote 并人工恢复');
    if (await this.git.head() === journal.after) { await fs.unlink(journalFile); return; }
    if (await this.git.head() !== journal.before) throw new Error('恢复期间分支发生外部变化，请保留操作日志后人工处理');
    const preserved: string[] = [];
    const operation = path.join(this.directory, 'operations', journal.id);
    await fs.mkdir(path.join(operation, 'interrupted'), { recursive: true });
    for (let i = journal.changes.length - 1; i >= 0; i--) {
      const change = journal.changes[i]!; validatePath(change.path);
      const current = await this.hash(change.path);
      const displaced = path.join(operation, 'displaced', String(i));
      const hasDisplaced = await this.exists(displaced);
      const backup = hasDisplaced ? displaced : path.join(operation, 'backup', String(i));
      const original = change.before ? await fs.readFile(backup) : undefined;
      if (original && !hasDisplaced && blobHash(original) !== change.before) throw new Error('恢复副本校验失败');
      if (current === change.before) {
        if (original && blobHash(original) !== change.before) preserved.push(change.path);
        continue;
      }
      if (current !== undefined && current !== change.after) { preserved.push(change.path); continue; }
      if (current === undefined && change.before && !hasDisplaced) { preserved.push(change.path); continue; }
      const file = await safePath(this.git.root, change.path);
      let source = change.before ? backup : undefined;
      if (current !== undefined) {
        const interrupted = path.join(operation, 'interrupted', i + '-' + randomUUID());
        try { await fs.rename(file, interrupted); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { preserved.push(change.path); continue; } throw error; }
        // Preserve a write that landed between the preceding hash and rename.
        if (blobHash(await fs.readFile(interrupted)) !== change.after) { source = interrupted; preserved.push(change.path); }
      }
      if (source) {
        try { await this.publish(file, source); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') preserved.push(change.path); else throw error; }
      }
    }
    await fs.unlink(journalFile);
    if (preserved.length) throw new Error(`中断恢复已保留后续编辑，原内容副本保存在 .git/cloudnote/operations/${journal.id}；需重新比较：${preserved.join('、')}`);
  }
  async apply(changes: Change[], before: string | undefined, after: string) {
    await this.recover();
    if (await this.git.head() !== before) throw new Error('本地分支已变化，请重新预览');
    const journal: Journal = { version: 1, id: randomUUID(), before, after, changes };
    const operation = path.join(this.directory, 'operations', journal.id);
    await fs.mkdir(path.join(operation, 'backup'), { recursive: true });
    await fs.mkdir(path.join(operation, 'staging'), { recursive: true });
    await fs.mkdir(path.join(operation, 'displaced'), { recursive: true });
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i]!;
      const bytes = await readFile(this.git.root, change.path);
      if ((bytes ? blobHash(bytes) : undefined) !== change.before) throw new Error(`文件在预览后已变化，保留当前内容并等待重新处理：${change.path}`);
      if (bytes) await this.atomic(path.join(operation, 'backup', String(i)), bytes);
      if (change.after) await this.atomic(path.join(operation, 'staging', String(i)), await this.git.blob(change.after));
    }
    // All blobs and backups are durable before the first user file is changed.
    await this.atomic(path.join(operation, 'operation.json'), Buffer.from(JSON.stringify(journal)));
    await this.atomic(path.join(this.directory, 'journal.json'), Buffer.from(JSON.stringify(journal)));
    try {
      for (let i = 0; i < changes.length; i++) {
        const change = changes[i]!;
        if (await this.hash(change.path) !== change.before) throw new Error(`写入前检测到新编辑：${change.path}`);
        const file = await safePath(this.git.root, change.path);
        if (change.before) {
          const displaced = path.join(operation, 'displaced', String(i));
          // Retain the actual old inode: an editor writing through an already-open
          // handle cannot have its bytes destroyed by an atomic replacement.
          await fs.rename(file, displaced);
          if (blobHash(await fs.readFile(displaced)) !== change.before) throw new Error(`替换期间检测到新编辑：${change.path}`);
        }
        if (change.after) await this.publish(file, path.join(operation, 'staging', String(i)));
      }
      // Recheck the entire write set, including earlier writes, before advancing history.
      for (let i = 0; i < changes.length; i++) {
        const change = changes[i]!;
        if (await this.hash(change.path) !== change.after) throw new Error(`写入期间检测到新编辑：${change.path}`);
        if (change.before && blobHash(await fs.readFile(path.join(operation, 'displaced', String(i)))) !== change.before) throw new Error(`原文件仍在编辑：${change.path}`);
      }
      await this.git.run(['update-ref', 'refs/heads/main', after, before ?? '0'.repeat(40)]);
      await fs.unlink(path.join(this.directory, 'journal.json'));
    } catch (error) {
      await this.recover();
      throw error;
    }
  }
}
