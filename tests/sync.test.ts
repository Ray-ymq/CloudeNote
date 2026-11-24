import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine, defaults } from '../src/engine';
import { Git, GitError } from '../src/git';
import { blobHash, scan, validateTree } from '../src/paths';
import { MessageGenerator, Tree } from '../src/types';

let temp: string, remote: string, a: Engine, b: Engine;
const dirs: string[] = [];
async function device(name: string, message?: MessageGenerator) {
  const root = path.join(temp, name); await fs.mkdir(root);
  const engine = new Engine(root, { ...defaults(), remote, deviceName: name }, message, true);
  await engine.initialize(); return engine;
}
async function put(engine: Engine, file: string, content: string | Buffer) {
  const destination = path.join(engine.root, file); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, content);
}
async function read(engine: Engine, file: string) { return fs.readFile(path.join(engine.root, file), 'utf8'); }
async function count(engine: Engine) { return Number(await engine.git.text(['rev-list', '--count', 'main'])); }
async function seed() { await put(a, '笔记.md', '基线\n'); await a.sync(); await b.sync(); }
async function conflict() { await seed(); await put(a, '笔记.md', '来自 A\n'); await a.sync(); await put(b, '笔记.md', '来自 B\n'); return (await b.sync())!; }

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudnote-test-')); dirs.push(temp);
  remote = path.join(temp, 'remote.git'); await fs.mkdir(remote);
  await new Git(remote).run(['init', '--bare', '--initial-branch=main']);
  a = await device('A'); b = await device('B');
});
afterEach(async () => {
  vi.restoreAllMocks();
  // All recursive cleanup targets are verified children of the OS temporary directory.
  for (const dir of dirs.splice(0)) {
    if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'cloudnote-test-')) throw new Error('unsafe test cleanup');
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

describe('Git synchronization', () => {
  it('propagates additions, updates, binary attachments, renames and deletions without empty commits', async () => {
    await seed();
    await put(a, '附件/a.png', Buffer.from([0, 1, 255])); await put(a, '笔记.md', '新内容'); await a.sync(); await b.sync();
    expect(await read(b, '笔记.md')).toBe('新内容');
    expect(await fs.readFile(path.join(b.root, '附件/a.png'))).toEqual(Buffer.from([0, 1, 255]));
    await fs.rename(path.join(b.root, '笔记.md'), path.join(b.root, '重命名.md'));
    await fs.unlink(path.join(b.root, '附件/a.png')); await b.sync(); await a.sync();
    expect(await read(a, '重命名.md')).toBe('新内容');
    expect((await scan(a.root)).tree).toEqual((await scan(b.root)).tree);
    const before = await count(a); await a.sync(); await b.sync(); expect(await count(a)).toBe(before); expect(await count(b)).toBe(before);
  });
  it('unions unrelated first-connect files and preserves same-path differences as conflicts', async () => {
    await put(a, 'only-a.md', 'a'); await put(a, 'same.md', 'a'); await a.sync();
    await put(b, 'only-b.md', 'b'); await put(b, 'same.md', 'b');
    const plan = (await b.sync())!; expect(plan.conflicts.map(c => c.path)).toEqual(['same.md']);
    expect(plan.target['only-a.md']).toBeDefined(); expect(plan.target['only-b.md']).toBeDefined();
    b.choose(plan.id, 'same.md', 'both'); await b.apply(plan.id); await a.sync();
    expect(await read(b, 'same.md')).toBe('a'); expect(await read(b, 'only-b.md')).toBe('b');
    expect(Object.keys((await scan(a.root)).tree).some(p => p.startsWith('same (B-'))).toBe(true);
  });
  it('automatically integrates independent paths with two-parent history', async () => {
    await seed(); await put(a, 'a.md', 'a'); await a.sync(); await put(b, 'b.md', 'b'); await b.sync(); await a.sync();
    const parents = await b.git.text(['rev-list', '--parents', '-n', '1', 'main']); expect(parents.split(' ')).toHaveLength(3);
    expect(await read(a, 'b.md')).toBe('b'); expect(await read(b, 'a.md')).toBe('a');
  });
  it.each(['local', 'remote', 'both'] as const)('resolves text conflicts with %s and retains both parent contents', async choice => {
    const plan = await conflict(); expect(await read(b, '笔记.md')).toBe('来自 B\n');
    expect(plan.conflicts).toHaveLength(1); await expect(b.apply(plan.id)).rejects.toThrow('尚未选择');
    b.choose(plan.id, '笔记.md', choice); await b.apply(plan.id); await a.sync();
    expect(await read(a, '笔记.md')).toBe(choice === 'local' ? '来自 B\n' : '来自 A\n');
    expect((await a.git.text(['rev-list', '--parents', '-n', '1', 'main'])).split(' ')).toHaveLength(3);
    expect((await b.fileVersion(plan.local!, '笔记.md'))?.toString()).toBe('来自 B\n');
    expect((await b.fileVersion(plan.remote!, '笔记.md'))?.toString()).toBe('来自 A\n');
    expect(await read(a, '笔记.md')).not.toContain('<<<<<<<');
    if (choice === 'both') { const copy = Object.keys((await scan(b.root)).tree).find(p => p.startsWith('笔记 (B-'))!; expect(await read(a, copy)).toBe('来自 B\n'); }
  });
  it('treats concurrent identical content as nonconflicting', async () => {
    await seed(); await put(a, '笔记.md', '一致'); await a.sync(); await put(b, '笔记.md', '一致'); expect(await b.sync()).toBeUndefined(); await a.sync();
    expect((await scan(a.root)).tree).toEqual((await scan(b.root)).tree);
  });
  it('preserves binary and delete/modify conflicts', async () => {
    await put(a, 'a.pdf', Buffer.from([0, 1])); await a.sync(); await b.sync();
    await put(a, 'a.pdf', Buffer.from([0, 2])); await a.sync(); await fs.unlink(path.join(b.root, 'a.pdf'));
    const plan = (await b.sync())!; expect(plan.conflicts[0]?.before).toBeUndefined(); expect(plan.conflicts[0]?.after).toBeDefined();
    b.choose(plan.id, 'a.pdf', 'local'); await b.apply(plan.id); await a.sync(); expect((await scan(a.root)).tree['a.pdf']).toBeUndefined();
    expect(await a.fileVersion(plan.remote!, 'a.pdf')).toEqual(Buffer.from([0, 2]));
  });
  it('previews and cancels pull without changing user files and does not push local commits', async () => {
    await seed(); await put(b, 'b.md', 'local'); await b.save(); const local = await b.git.head();
    await put(a, 'a.md', 'remote'); await a.sync(); const remoteBefore = await new Git(remote).head();
    const plan = await b.previewPull(); b.cancel(plan.id); expect((await scan(b.root)).tree['a.md']).toBeUndefined(); expect(await b.git.head()).toBe(local);
    const next = await b.previewPull(); await b.apply(next.id);
    expect(await new Git(remote).head()).toBe(remoteBefore); expect(b.state.pendingPush).toBeGreaterThan(0); expect(await read(b, 'a.md')).toBe('remote');
  });
  it('requires an explicit local save before pull, and rejects edits after preview', async () => {
    await seed(); await put(b, '笔记.md', '未保存'); await expect(b.previewPull()).rejects.toThrow('未提交');
    await b.save(); await put(a, '新文件.md', '远端'); await a.sync(); const plan = await b.previewPull();
    await put(b, '新文件.md', '下载期间编辑'); await expect(b.apply(plan.id)).rejects.toThrow('预览后'); expect(await read(b, '新文件.md')).toBe('下载期间编辑');
  });
  it('rejects conflict choices if content changed after comparison, including use-local', async () => {
    const plan = await conflict(); b.choose(plan.id, '笔记.md', 'local'); await put(b, '笔记.md', '后续编辑');
    await expect(b.apply(plan.id)).rejects.toThrow('预览后'); expect(await read(b, '笔记.md')).toBe('后续编辑');
  });
  it('rejects a stale remote preview and preserves local files', async () => {
    await seed(); await put(a, 'a.md', '1'); await a.sync(); const plan = await b.previewPull();
    await put(a, 'a.md', '2'); await a.sync(); await expect(b.apply(plan.id)).rejects.toThrow('远端已再次变化');
    expect((await scan(b.root)).tree['a.md']).toBeUndefined();
  });
  it('queues mutation tasks and leaves local commits intact across an offline retry', async () => {
    await seed(); await put(a, 'offline.md', '保留'); const destination = a.settings.remote; a.settings.remote = path.join(temp, 'missing.git');
    await expect(a.sync()).rejects.toThrow(); const offline = await a.git.head(); expect(await read(a, 'offline.md')).toBe('保留');
    a.settings.remote = destination; await Promise.all([a.sync(), a.sync(), a.save()]); expect(await a.git.head()).toBe(offline); await b.sync(); expect(await read(b, 'offline.md')).toBe('保留');
  });
  it('retries a non-fast-forward push after fetching, without re-generating a local message', async () => {
    const ai = vi.fn<MessageGenerator>(async () => ({ message: '生成说明', source: 'ai' }));
    const c = await device('C', ai); await seed(); await c.sync(); await put(c, 'c.md', 'c');
    const run = c.git.run.bind(c.git); let raced = false;
    vi.spyOn(c.git, 'run').mockImplementation(async (args, ...rest) => {
      if (args[0] === 'push' && !raced) { raced = true; await put(a, 'race.md', 'remote'); await a.sync(); }
      return run(args, ...rest);
    });
    await c.sync(); expect(raced).toBe(true); expect(ai).toHaveBeenCalledTimes(1); expect(await read(c, 'race.md')).toBe('remote'); await b.sync(); expect(await read(b, 'c.md')).toBe('c');
  });
  it('keeps edits made during AI generation for the next batch and commits the fixed staged content', async () => {
    let c: Engine;
    const ai = vi.fn<MessageGenerator>(async (delta, readObject) => {
      expect((await readObject(delta[0]!.after!)).toString()).toBe('待提交');
      await put(c, 'note.md', '生成期间的新编辑'); return { message: '说明对应待提交', source: 'ai' };
    });
    c = await device('C', ai); await put(c, 'note.md', '待提交'); await c.sync();
    expect(ai).toHaveBeenCalledTimes(1); expect(await read(c, 'note.md')).toBe('生成期间的新编辑');
    expect((await c.fileVersion((await c.git.head())!, 'note.md'))?.toString()).toBe('待提交');
    expect(c.state.pendingCommit).toBe(1); await a.sync(); expect(await read(a, 'note.md')).toBe('待提交');
  });
  it('stops after three automatic retries and retains the local commit', async () => {
    await seed(); await put(a, 'new.md', '保留'); const run = a.git.run.bind(a.git); let attempts = 0;
    vi.spyOn(a.git, 'run').mockImplementation(async (args, ...rest) => {
      if (args[0] === 'push') { attempts++; throw new GitError(args, 1, '[rejected] non-fast-forward'); }
      return run(args, ...rest);
    });
    await expect(a.sync()).rejects.toThrow(); expect(attempts).toBe(4); expect(await a.fileVersion((await a.git.head())!, 'new.md')).toEqual(Buffer.from('保留'));
  });
});

describe('history and recovery', () => {
  it('paginates older file history without hiding earlier commits', async () => {
    await seed(); const oldest = await a.git.head(); await put(a, '笔记.md', '新版'); await a.save();
    const first = await a.history('笔记.md', 1), second = await a.history('笔记.md', 1, 'refs/heads/main', 1);
    expect(first[0]?.hash).not.toBe(oldest); expect(second[0]?.hash).toBe(oldest); expect(await a.history('笔记.md', 1, 'refs/heads/main', 2)).toEqual([]);
  });
  it('retains unpushed snapshot tags even when user Git configuration enables pruning', async () => {
    await seed();
    await a.git.run(['config', 'fetch.prune', 'true']); await a.git.run(['config', 'fetch.pruneTags', 'true']);
    await a.git.run(['tag', '-a', 'cloudnote/snapshot/local-only', '-m', '尚未上传的快照'], undefined, { GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@localhost' });
    await a.sync(); expect((await a.snapshots()).some(s => s.name === '尚未上传的快照')).toBe(true);
    await b.sync(); expect((await b.snapshots()).some(s => s.name === '尚未上传的快照')).toBe(true);
  });
  it('restores deleted files, creates a new commit and allows undoing a restore', async () => {
    await seed(); const original = (await a.git.head())!; await fs.unlink(path.join(a.root, '笔记.md')); await a.sync(); const deleted = (await a.git.head())!;
    expect((await a.history('笔记.md'))).toHaveLength(2);
    const restore = await a.previewRestore(original, '笔记.md'); expect(restore.changes[0]?.before).toBeUndefined(); await a.apply(restore.id);
    expect(await read(a, '笔记.md')).toBe('基线\n'); expect(await a.git.head()).not.toBe(original);
    const undo = await a.previewRestore(deleted, '笔记.md'); await a.apply(undo.id); expect((await scan(a.root)).tree['笔记.md']).toBeUndefined();
  });
  it('uploads annotated snapshots and restores an entire vault from a new device', async () => {
    await seed(); await a.createSnapshot('基础快照'); const snapshotHead = (await a.git.head())!;
    await put(a, '笔记.md', '新笔记'); await put(a, 'extra.md', '多余'); await a.sync();
    const c = await device('C'); await c.sync(); const snapshots = await c.snapshots(); expect(snapshots[0]?.name).toBe('基础快照'); expect(snapshots[0]?.hash).toBe(snapshotHead);
    await put(c, '未保存.md', '恢复前编辑'); const plan = await c.previewRestore(snapshots[0]!.hash); const saved = (await c.git.head())!;
    expect(plan.changes.some(c => c.path === '未保存.md' && !c.after)).toBe(true); await c.apply(plan.id);
    expect(await read(c, '笔记.md')).toBe('基线\n'); expect((await scan(c.root)).tree['extra.md']).toBeUndefined();
    const undo = await c.previewRestore(saved); await c.apply(undo.id); expect(await read(c, '未保存.md')).toBe('恢复前编辑'); await c.sync(); await a.sync(); expect(await read(a, '未保存.md')).toBe('恢复前编辑');
  });
  it('blocks restore while conflict resolution is pending', async () => {
    const plan = await conflict(); await expect(b.previewRestore(plan.remote!)).rejects.toThrow('未完成');
  });
  it('rolls back partial writes when a disk write fails and retains backups', async () => {
    await seed(); const original = (await a.git.head())!; await put(a, '笔记.md', '当前'); await a.save(); const head = await a.git.head();
    const plan = await a.previewRestore(original); const link = fs.link.bind(fs); let failed = false;
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      if (String(to) === path.join(a.root, '笔记.md') && !failed) { failed = true; throw Object.assign(new Error('磁盘不足'), { code: 'ENOSPC' }); }
      return link(from, to);
    });
    await expect(a.apply(plan.id)).rejects.toThrow('磁盘不足'); expect(await read(a, '笔记.md')).toBe('当前'); expect(await a.git.head()).toBe(head);
    expect((await fs.readdir(path.join(a.root, '.git/cloudnote/operations'))).length).toBeGreaterThan(0);
  });
  it('preserves an edit that lands between final revalidation and replacement', async () => {
    await seed(); await put(a, '笔记.md', '云端新内容'); await a.sync(); const plan = await b.previewPull();
    const rename = fs.rename.bind(fs); let edited = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === path.join(b.root, '笔记.md') && !edited) { edited = true; await put(b, '笔记.md', '临界区的新编辑'); }
      return rename(from, to);
    });
    await expect(b.apply(plan.id)).rejects.toThrow('新编辑'); expect(await read(b, '笔记.md')).toBe('临界区的新编辑');
  });
  it('never replaces a file recreated by an editor while the old file is protected', async () => {
    await seed(); await put(a, '笔记.md', '云端新内容'); await a.sync(); const plan = await b.previewPull();
    const link = fs.link.bind(fs); let edited = false;
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      if (String(to) === path.join(b.root, '笔记.md') && !edited) { edited = true; await put(b, '笔记.md', '新建编辑'); }
      return link(from, to);
    });
    await expect(b.apply(plan.id)).rejects.toThrow(); expect(await read(b, '笔记.md')).toBe('新建编辑');
  });
  it('recovers an interrupted operation and preserves subsequent edits', async () => {
    await seed(); const before = (await a.git.head())!;
    const id = randomUUID(), directory = path.join(a.root, '.git/cloudnote');
    await fs.mkdir(path.join(directory, 'operations', id, 'backup'), { recursive: true });
    await fs.writeFile(path.join(directory, 'operations', id, 'backup', '0'), '基线\n');
    const afterBytes = Buffer.from('中断写入'), change = { path: '笔记.md', before: blobHash(Buffer.from('基线\n')), after: blobHash(afterBytes) };
    const journal = { version: 1, id, before, after: 'f'.repeat(40), changes: [change] };
    await fs.writeFile(path.join(directory, 'journal.json'), JSON.stringify(journal)); await put(a, '笔记.md', afterBytes);
    await a.refresh(); expect(await read(a, '笔记.md')).toBe('基线\n');
    await fs.writeFile(path.join(directory, 'journal.json'), JSON.stringify(journal)); await put(a, '笔记.md', '重启前新编辑');
    await expect(a.refresh()).rejects.toThrow('保留后续编辑'); expect(await read(a, '笔记.md')).toBe('重启前新编辑');
  });
});

describe('repository and path protection', () => {
  it('synchronizes ordinary files whose names match JavaScript object properties', async () => {
    for (const file of ['__proto__', 'constructor', 'toString']) await put(a, file, file);
    await a.sync(); await b.sync();
    for (const file of ['__proto__', 'constructor', 'toString']) expect(await read(b, file)).toBe(file);
  });
  it('refuses an unmanaged repository without changing its configuration', async () => {
    const directory = path.join(temp, 'unmanaged'); await fs.mkdir(directory); const git = new Git(directory); await git.run(['init']);
    const config = await fs.readFile(path.join(directory, '.git/config'), 'utf8');
    const engine = new Engine(directory, { ...defaults(), remote }, undefined, true); await expect(engine.initialize()).rejects.toThrow('不由云笺管理');
    expect(await fs.readFile(path.join(directory, '.git/config'), 'utf8')).toBe(config);
  });
  it('ignores private directories and oversized files while synchronizing other notes', async () => {
    await put(a, '.obsidian/secret.json', 'secret'); await put(a, '.trash/deleted.md', 'trash'); await put(a, '.cloudnote-tmp-test', 'temp'); await put(a, 'good.md', 'note');
    const huge = await fs.open(path.join(a.root, 'large.pdf'), 'w'); await huge.truncate(100 * 1024 * 1024 + 1); await huge.close();
    await a.sync(); await b.sync(); expect(Object.keys((await scan(b.root)).tree)).toEqual(['good.md']); expect(a.state.skipped[0]?.reason).toContain('100 MiB');
  });
  it('rejects traversal, excluded, case-colliding and file-directory remote paths before writing', () => {
    const trees: Tree[] = [{ '../bad.md': 'a' }, { '.obsidian/key': 'a' }, { 'A.md': 'a', 'a.md': 'b' }, { 'A/x.md': 'a', 'a/y.md': 'b' }, { 'a': 'a', 'a/b': 'b' }, { 'con.md': 'a' }];
    for (const tree of trees) expect(() => validateTree(tree)).toThrow();
  });
  it('does not follow symbolic links', async () => {
    const external = path.join(temp, 'outside'); await fs.mkdir(external); await fs.writeFile(path.join(external, 'secret.md'), 'secret');
    await fs.symlink(external, path.join(a.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await put(a, 'good.md', 'note'); await a.sync(); await b.sync(); expect(Object.keys((await scan(b.root)).tree)).toEqual(['good.md']); expect(a.state.skipped.some(s => s.path === 'linked')).toBe(true);
  });
  it('reports SSH errors without leaking detailed credential-bearing output', async () => {
    const e = new GitError(['ls-remote'], 128, 'Permission denied (publickey). token=private'); expect(e.message).toContain('SSH'); expect(e.message).not.toContain('private');
  });
});
