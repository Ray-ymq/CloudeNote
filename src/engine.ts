import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Git, GitError } from './git';
import { blobHash, readFile, scan, validateTree } from './paths';
import { Transaction } from './transaction';
import { fallback } from './ai';
import { Change, Choice, copyTree, emptyTree, HistoryEntry, MAX_FILE, MessageGenerator, Preview, Settings, Snapshot, SyncState, Tree } from './types';

const REF = 'refs/remotes/origin/main';
const SNAP = 'refs/tags/cloudnote/snapshot/';
export function changes(before: Tree, after: Tree): Change[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(p => before[p] !== after[p]).map(p => ({ path: p, before: before[p], after: after[p] }));
}
export function defaults(): Settings {
  return { gitPath: 'git', remote: '', deviceId: randomUUID(), deviceName: os.hostname(), autoSync: false, connectionTested: false, aiEnabled: false, aiNamesOnly: false, aiModel: 'deepseek-flash', secretName: 'cloudnote-deepseek' };
}
export class Engine {
  readonly git: Git;
  readonly transaction: Transaction;
  state: SyncState = { phase: 'idle', message: '等待连接', pendingCommit: 0, pendingPush: 0, pendingPull: 0, conflicts: 0, skipped: [] };
  preview?: Preview;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  get isWorking() { return this.queued > 0; }
  private listeners = new Set<(state: SyncState) => void>();
  constructor(readonly root: string, readonly settings: Settings, readonly message?: MessageGenerator, readonly allowLocalRemote = false) {
    this.git = new Git(root, settings.gitPath); this.transaction = new Transaction(this.git);
  }
  subscribe(listener: (state: SyncState) => void) { this.listeners.add(listener); listener(this.state); return () => { this.listeners.delete(listener); }; }
  private emit(patch: Partial<SyncState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(l => l(this.state)); }
  private async managed() {
    const directory = await fs.lstat(path.join(this.root, '.git')).catch(() => undefined);
    if (!directory?.isDirectory() || directory.isSymbolicLink()) throw new Error('知识库需要独立的云笺 Git 目录，不支持 Git 链接或工作树');
    const marker = await fs.readFile(path.join(this.root, '.git/cloudnote/managed.json'), 'utf8').catch(() => '');
    if (!marker || (JSON.parse(marker) as { version?: number }).version !== 1) throw new Error('尚未初始化，或此仓库不由云笺管理；请使用独立知识库。');
    if (await this.git.text(['symbolic-ref', 'HEAD']) !== 'refs/heads/main') throw new Error('当前分支不是 main，请先恢复插件管理分支');
  }
  async isManaged() { try { await this.managed(); return true; } catch { return false; } }
  private remote() {
    const remote = this.settings.remote.trim();
    if (!remote || remote.startsWith('-') || /[\x00-\x20]/.test(remote)) throw new Error('请配置有效的 SSH 远端地址');
    if (!this.allowLocalRemote && !/^(ssh:\/\/(?:[\w.-]+@)?[\w.-]+(?::\d+)?\/[^?#]+|(?:[\w.-]+@)?[\w.-]+:[^\\]+)$/.test(remote)) throw new Error('仅支持 SSH Git 地址，如 git@example.com:notes.git');
    return remote;
  }
  async testConnection() { await this.git.version(); await this.git.run(['ls-remote', '--', this.remote()]); return 'Git 与非交互 SSH 连接正常'; }
  async scope() { return scan(this.root); }
  async initialize() {
    await this.git.version();
    const stat = await fs.lstat(path.join(this.root, '.git')).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
    if (stat) { await this.managed(); return; }
    // Refuse nested repositories: Git must never discover and mutate an ancestor repository.
    const parentGit = new Git(path.dirname(this.root), this.settings.gitPath);
    const parent = await parentGit.text(['rev-parse', '--show-toplevel']).catch(() => '');
    if (parent) throw new Error('知识库位于其他 Git 仓库中，请使用独立目录');
    await scan(this.root);
    await this.git.run(['init', '--initial-branch=main', '--object-format=sha1']);
    await fs.mkdir(path.join(this.root, '.git/cloudnote/no-hooks'), { recursive: true });
    await this.git.run(['config', 'core.autocrlf', 'false']);
    await this.git.run(['config', 'core.filemode', 'false']);
    await this.git.run(['config', 'gc.auto', '0']);
    await this.git.run(['config', 'remote.origin.url', this.remote()]);
    await fs.writeFile(path.join(this.root, '.git/cloudnote/managed.json'), JSON.stringify({ version: 1 }));
  }
  private task<T>(label: string, operation: () => Promise<T>): Promise<T> {
    this.queued++;
    const run = this.tail.then(async () => {
      await this.managed();
      const lockPath = path.join(this.root, '.git/cloudnote/task.lock');
      let lock;
      try { lock = await fs.open(lockPath, 'wx'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const pid = Number(await fs.readFile(lockPath, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('任务锁损坏，请确认无任务运行后移除 .git/cloudnote/task.lock');
        try { process.kill(pid, 0); throw new Error('另一个知识库任务正在执行'); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
        await fs.unlink(lockPath); lock = await fs.open(lockPath, 'wx');
      }
      try {
        await lock.writeFile(String(process.pid));
        this.emit({ phase: 'busy', message: label });
        await this.transaction.recover();
        const result = await operation();
        if (this.state.phase === 'busy') this.emit({ phase: this.preview?.conflicts.length ? 'conflict' : 'idle', message: this.preview ? '等待预览确认' : '操作完成' });
        return result;
      } catch (error) { this.emit({ phase: 'error', message: (error as Error).message }); throw error; }
      finally { await lock.close(); await fs.unlink(lockPath); }
    });
    const result = run.finally(() => { this.queued--; });
    this.tail = result.catch(() => undefined);
    return result;
  }
  private identity(): NodeJS.ProcessEnv {
    const name = this.settings.deviceName.replace(/[\r\n<>\x00-\x1f]/g, '').slice(0, 80) || 'Cloudnote';
    return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: 'cloudnote@localhost', GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: 'cloudnote@localhost' };
  }
  private metadata(label: string) {
    return `${label}\n\nCloudnote-Device-ID: ${this.settings.deviceId.replace(/[^a-zA-Z0-9-]/g, '')}\nCloudnote-Device-Name: ${this.settings.deviceName.replace(/[\r\n\x00-\x1f]/g, '').slice(0, 80)}\n`;
  }
  async tree(ref?: string): Promise<Tree> {
    if (!ref) return emptyTree();
    if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error('无效提交哈希');
    const raw = await this.git.run(['ls-tree', '-rz', '--full-tree', ref]);
    const tree: Tree = emptyTree();
    for (const row of raw.toString('utf8').split('\0').filter(Boolean)) {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
      if (!match || match[1] !== '100644' && match[1] !== '100755' || match[2] !== 'blob') throw new Error('远端包含符号链接或不支持的 Git 对象');
      tree[match[4]!] = match[3]!;
    }
    validateTree(tree);
    const oids = [...new Set(Object.values(tree))];
    if (oids.length) {
      const sizes = await this.git.text(['cat-file', '--batch-check=%(objectsize)'], oids.join('\n') + '\n');
      if (sizes.split('\n').some(size => !/^\d+$/.test(size) || Number(size) > MAX_FILE)) throw new Error('远端包含超过 100 MiB 的文件，尚未写入知识库');
    }
    return tree;
  }
  private async commit(tree: Tree, parents: string[], label: string) {
    validateTree(tree);
    const index = path.join(this.root, '.git/cloudnote/index-' + randomUUID());
    const env = { GIT_INDEX_FILE: index, ...this.identity() };
    try {
      await this.git.run(['read-tree', '--empty'], undefined, env);
      const entries = Object.keys(tree).sort().map(p => `100644 ${tree[p]}\t${p}\0`).join('');
      if (entries) await this.git.run(['update-index', '-z', '--index-info'], entries, env);
      const hash = await this.git.text(['write-tree'], undefined, env);
      return await this.git.text(['commit-tree', hash, ...parents.flatMap(p => ['-p', p])], this.metadata(label), env);
    } finally { await fs.unlink(index).catch(() => undefined); }
  }
  private async localSnapshot() {
    const before = await this.tree(await this.git.head());
    const snapshot = await scan(this.root);
    // An excluded/unreadable tracked file is not a deletion.
    for (const skip of snapshot.skipped) for (const file of Object.keys(before)) if (file === skip.path || file.startsWith(skip.path + '/')) snapshot.tree[file] = before[file]!;
    this.emit({ skipped: snapshot.skipped, pendingCommit: changes(before, snapshot.tree).length });
    return snapshot;
  }
  private async saveLocal(label?: string) {
    const head = await this.git.head(), before = await this.tree(head), snapshot = await this.localSnapshot();
    const delta = changes(before, snapshot.tree);
    if (!delta.length) return head;
    for (const change of delta) if (change.after) {
      const bytes = await readFile(this.root, change.path);
      if (!bytes || blobHash(bytes) !== change.after) throw new Error(`保存期间检测到新编辑，等待下一批：${change.path}`);
      const oid = await this.git.text(['hash-object', '-w', '--stdin'], bytes);
      if (oid !== change.after) throw new Error('本地对象校验失败');
    }
    const result = label ? { message: label, reason: undefined } : this.message ? await this.message(delta, oid => this.git.blob(oid)) : { message: fallback(delta), reason: undefined };
    const next = await this.commit(snapshot.tree, head ? [head] : [], result.message);
    await this.git.run(['update-ref', 'refs/heads/main', next, head ?? '0'.repeat(40)]);
    this.emit({ aiFallback: result.reason, pendingPush: this.state.pendingPush + 1 });
    return next;
  }
  private async fetch() {
    const remote = this.remote();
    const listing = await this.git.text(['ls-remote', '--heads', '--', remote, 'refs/heads/main']);
    if (listing) await this.git.run(['fetch', '--no-tags', '--no-prune', '--no-prune-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--', remote, '+refs/heads/main:' + REF]);
    else if (await this.git.head(REF)) throw new Error('远端 main 分支已消失，请检查远端状态');
    await this.git.run(['fetch', '--no-tags', '--no-prune', '--no-prune-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--', remote, SNAP + '*:' + SNAP + '*']);
    return listing ? await this.git.head(REF) : undefined;
  }
  private async count(local?: string, remote?: string) {
    const ahead = local ? Number(await this.git.text(['rev-list', '--count', local, ...(remote ? ['--not', remote] : [])])) : 0;
    const behind = remote ? Number(await this.git.text(['rev-list', '--count', remote, ...(local ? ['--not', local] : [])])) : 0;
    this.emit({ pendingPush: ahead, pendingPull: behind });
  }
  async refresh() {
    return this.task('读取本地状态', async () => {
      await this.localSnapshot(); await this.count(await this.git.head(), await this.git.head(REF));
      const last = await fs.readFile(path.join(this.root, '.git/cloudnote/last-success'), 'utf8').catch(() => undefined);
      this.emit({ lastSuccess: last });
    });
  }
  private async device(hash?: string) { return hash ? (await this.history(undefined, 1, hash))[0]?.device ?? '未知设备' : this.settings.deviceName; }
  private async compare(kind: 'pull' | 'sync', local: string | undefined, remote: string | undefined): Promise<Preview> {
    const left = await this.tree(local), right = await this.tree(remote);
    const baseHash = local && remote ? await this.git.text(['merge-base', local, remote], undefined, undefined, [0, 1]) : '';
    const base = await this.tree(baseHash || undefined), target = copyTree(left);
    const conflicts: Preview['conflicts'] = [];
    const localDevice = await this.device(local), remoteDevice = await this.device(remote);
    for (const file of [...new Set([...Object.keys(left), ...Object.keys(right), ...Object.keys(base)])]) {
      const a = left[file], b = right[file], c = base[file];
      if (a === b) continue;
      // With no common base, a missing path is never interpreted as a deletion.
      if (!baseHash) { if (!b) continue; if (!a) { target[file] = b; continue; } }
      else { if (a === c) { if (b) target[file] = b; else delete target[file]; continue; } if (b === c) continue; }
      conflicts.push({ path: file, before: a, after: b, base: c, localDevice, remoteDevice });
    }
    validateTree(target);
    const expected = (await this.localSnapshot()).tree;
    // Edits made during fetch stay on disk and must be committed before integration.
    const affected = new Set([...changes(left, target).map(c => c.path), ...conflicts.map(c => c.path)]);
    if (changes(left, expected).some(c => affected.has(c.path))) throw new Error('下载期间检测到受影响文件的本地编辑，内容已保留，等待下一次同步');
    return { id: randomUUID(), kind, local, remote, expected, target, changes: changes(left, target), conflicts, choices: Object.create(null) as Record<string, Choice>, label: '整合云端变化' };
  }
  private setPreview(preview: Preview) {
    this.preview = preview;
    this.emit({ conflicts: preview.conflicts.length, phase: preview.conflicts.length ? 'conflict' : 'pending', message: preview.conflicts.length ? '请处理所有冲突后确认整合' : '等待预览确认' });
    return preview;
  }
  async previewPull() {
    return this.task('获取云端变化', async () => {
      if (this.preview) throw new Error('请先完成或取消当前预览');
      const local = await this.git.head();
      if (changes(await this.tree(local), (await this.localSnapshot()).tree).length) throw new Error('本地存在未提交修改，请先保存本地提交，再拉取');
      const remote = await this.fetch(); await this.count(local, remote);
      return this.setPreview(await this.compare('pull', local, remote));
    });
  }
  async save() { return this.task('保存本地提交', async () => { if (this.preview) throw new Error('请先完成或取消预览'); await this.saveLocal(); await this.localSnapshot(); await this.count(await this.git.head(), await this.git.head(REF)); }); }
  async sync() {
    return this.task('同步知识库', async () => {
      if (this.preview) return this.preview;
      await this.saveLocal();
      return this.synchronize();
    });
  }
  private async synchronize(): Promise<Preview | undefined> {
    for (let attempt = 0; attempt <= 3; attempt++) {
      const local = await this.git.head(), remote = await this.fetch(); await this.count(local, remote);
      const plan = await this.compare('sync', local, remote);
      if (plan.conflicts.length) return this.setPreview(plan);
      await this.integrate(plan);
      const head = await this.git.head();
      try {
        if (head && head !== remote) await this.git.run(['push', '--porcelain', '--', this.remote(), 'refs/heads/main:refs/heads/main']);
        const snapshots = await this.snapshots();
        if (snapshots.length) await this.git.run(['push', '--', this.remote(), ...snapshots.map(s => s.ref + ':' + s.ref)]);
        if (head) await this.git.run(['update-ref', REF, head]);
        const now = new Date().toISOString();
        await fs.writeFile(path.join(this.root, '.git/cloudnote/last-success'), now);
        await this.localSnapshot(); await this.count(head, head);
        this.emit({ phase: this.state.pendingCommit ? 'pending' : 'idle', lastSuccess: now, message: this.state.pendingCommit ? '本批已同步，新编辑等待下一批' : '云端同步成功', conflicts: 0 });
        return;
      } catch (error) {
        if (error instanceof GitError && /non-fast-forward|fetch first|remote contains work/i.test(error.detail) && attempt < 3) continue;
        await this.count(await this.git.head(), await this.git.head(REF));
        throw error;
      }
    }
  }
  choose(id: string, file: string, choice: Choice) {
    if (this.state.phase === 'busy') throw new Error('任务正在执行，请稍后处理冲突');
    if (!['local', 'remote', 'both'].includes(choice)) throw new Error('无效冲突选择');
    if (!this.preview || this.preview.id !== id || !this.preview.conflicts.some(c => c.path === file)) throw new Error('冲突预览已变化，请重新比较');
    this.preview.choices[file] = choice;
  }
  cancel(id: string) {
    if (this.state.phase === 'busy') throw new Error('任务正在执行，暂时不能取消');
    if (this.preview?.id === id) { this.preview = undefined; this.emit({ phase: 'idle', conflicts: 0, message: '已取消预览，知识库内容未应用变化' }); }
  }
  private resolve(plan: Preview) {
    const target = copyTree(plan.target);
    for (const conflict of plan.conflicts) {
      const choice = Object.hasOwn(plan.choices, conflict.path) ? plan.choices[conflict.path] : undefined;
      if (!choice) throw new Error(`尚未选择冲突处理方式：${conflict.path}`);
      const oid = choice === 'local' ? conflict.before : conflict.after;
      if (oid) target[conflict.path] = oid; else delete target[conflict.path];
      if (choice === 'both' && conflict.before) {
        const extension = path.posix.extname(conflict.path), stem = conflict.path.slice(0, conflict.path.length - extension.length);
        const device = this.settings.deviceName.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 24) || 'local';
        const suffix = ` (${device}-${new Date().toISOString().replace(/[:.]/g, '-')})`;
        let n = 0, copy: string;
        do { copy = stem + suffix + (n ? '-' + n : '') + extension; n++; } while (Object.keys(target).some(p => p.toLowerCase() === copy.toLowerCase()) || Object.hasOwn(plan.expected, copy));
        target[copy] = conflict.before;
      }
    }
    validateTree(target); return target;
  }
  private async integrate(plan: Preview) {
    if (await this.git.head() !== plan.local) throw new Error('本地提交已变化，请取消后重新预览');
    const target = this.resolve(plan), left = await this.tree(plan.local), delta = changes(left, target);
    const current = (await this.localSnapshot()).tree;
    for (const file of new Set([...delta.map(c => c.path), ...plan.conflicts.map(c => c.path)])) {
      if (current[file] !== plan.expected[file]) throw new Error(`预览后文件已编辑：${file}，请重新比较`);
    }
    if (plan.kind !== 'restore' && !plan.remote) return;
    if (plan.kind !== 'restore' && plan.local === plan.remote) return;
    let next: string;
    const remoteTree = plan.kind === 'restore' ? {} : await this.tree(plan.remote);
    const fastForward = !plan.local || (plan.remote && (await this.git.text(['merge-base', plan.local, plan.remote], undefined, undefined, [0, 1])) === plan.local);
    if (plan.kind !== 'restore' && fastForward && !changes(remoteTree, target).length) next = plan.remote!;
    else if (!delta.length && plan.kind === 'restore') return;
    else {
      // When remote is already an ancestor, avoid an empty merge on every sync.
      if (plan.kind !== 'restore' && plan.local && plan.remote && (await this.git.text(['merge-base', plan.local, plan.remote], undefined, undefined, [0, 1])) === plan.remote) return;
      next = await this.commit(target, [...new Set([plan.local, ...(plan.kind === 'restore' ? [] : [plan.remote])].filter((p): p is string => !!p))], plan.label);
    }
    await this.transaction.apply(delta.map(c => ({ ...c, before: plan.expected[c.path] })), plan.local, next);
  }
  async apply(id: string) {
    return this.task('应用确认后的变化', async () => {
      const plan = this.preview ? structuredClone(this.preview) : undefined;
      if (plan) { plan.target = copyTree(plan.target); plan.expected = copyTree(plan.expected); }
      if (!plan || plan.id !== id) throw new Error('预览已过期');
      this.resolve(plan);
      if (plan.kind !== 'restore') {
        const remote = await this.fetch();
        if (remote !== plan.remote) throw new Error('远端已再次变化，请取消并重新预览');
      }
      await this.integrate(plan);
      this.preview = undefined;
      this.emit({ conflicts: 0 });
      if (plan.kind === 'sync') return this.synchronize();
      await this.localSnapshot(); await this.count(await this.git.head(), await this.git.head(REF));
      this.emit({ phase: this.state.pendingPush || this.state.pendingCommit ? 'pending' : 'idle', message: plan.kind === 'restore' ? '恢复已创建新提交，等待推送' : '拉取已应用，本地提交保留待推送状态' });
    });
  }
  async history(file?: string, limit = 100, ref = 'refs/heads/main', offset = 0): Promise<HistoryEntry[]> {
    if (file) validateTree({ [file]: '' });
    if (!/^(refs\/heads\/main|[a-f0-9]{40})$/.test(ref)) throw new Error('无效历史引用');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('无效历史分页');
    if (ref === 'refs/heads/main' && !await this.git.head()) return [];
    const rows = await this.git.text(['log', ref, '--full-history', `--skip=${offset}`, `--max-count=${Math.min(500, Math.max(1, limit))}`, '--format=%H%x00%aI%x00%an%x00%B%x00%x1e', ...(file ? ['--', file] : [])]);
    return rows.split('\x1e').map(s => s.trim()).filter(Boolean).map(s => {
      const [hash = '', date = '', author = '', body = ''] = s.split('\0');
      return { hash, date, device: /^Cloudnote-Device-Name: (.+)$/m.exec(body)?.[1] ?? author, deviceId: /^Cloudnote-Device-ID: (.+)$/m.exec(body)?.[1] ?? 'external', message: body.split('\n')[0] ?? '' };
    });
  }
  async fileVersion(hash: string, file: string) { const oid = (await this.tree(hash))[file]; return oid ? this.git.blob(oid) : undefined; }
  async diff(hash: string, file: string) {
    validateTree({ [file]: '' }); if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error('无效提交');
    return this.git.text(['show', '--format=', '--no-ext-diff', '--no-textconv', '--first-parent', '--root', hash, '--', file]);
  }
  async previewRestore(hash: string, file?: string) {
    return this.task('准备历史恢复预览', async () => {
      if (this.preview) throw new Error('存在未完成预览或冲突，请先处理');
      // Save current edits without sending their content to AI during a restore.
      const local = await this.saveLocal('恢复前保存当前笔记'), current = await this.tree(local), historical = await this.tree(hash);
      let target = historical;
      if (file) { validateTree({ [file]: '' }); target = copyTree(current); if (historical[file]) target[file] = historical[file]!; else delete target[file]; }
      const expected = (await this.localSnapshot()).tree;
      if (changes(current, expected).length) throw new Error('保存期间产生新编辑，请重试恢复');
      return this.setPreview({ id: randomUUID(), kind: 'restore', local, target, expected, conflicts: [], choices: {}, changes: changes(current, target), label: `恢复${file ? '文件 ' + file : '整库'}至 ${hash.slice(0, 12)}`, source: hash });
    });
  }
  async createSnapshot(name: string) {
    return this.task('创建整库快照', async () => {
      if (this.preview) throw new Error('请先完成预览或冲突处理');
      const head = await this.saveLocal(); if (!head) throw new Error('知识库没有可快照的内容');
      const ref = SNAP + Date.now() + '-' + randomUUID();
      await this.git.run(['tag', '-a', ref.slice('refs/tags/'.length), head, '-F', '-'], this.metadata(name.replace(/[\x00-\x1f]/g, ' ').slice(0, 120) || '整库快照'), this.identity());
      // A network failure keeps the annotated local tag; the next sync uploads it.
      await this.synchronize(); return ref;
    });
  }
  async snapshots(): Promise<Snapshot[]> {
    const raw = await this.git.text(['for-each-ref', '--sort=-creatordate', '--format=%(refname)%00%(*objectname)%00%(subject)%00%(creatordate:iso-strict)', SNAP]);
    return raw ? raw.split('\n').map(row => { const [ref = '', hash = '', name = '', date = ''] = row.split('\0'); return { ref, hash, name, date }; }).filter(s => /^[a-f0-9]{40}$/.test(s.hash)) : [];
  }
  async devices() {
    const history = await this.history(undefined, 500);
    const seen = new Map<string, HistoryEntry>(); for (const item of history) if (!seen.has(item.deviceId)) seen.set(item.deviceId, item);
    return [...seen.values()];
  }
  static async download(directory: string, settings: Settings) {
    const existing = await fs.readdir(directory);
    if (existing.length) throw new Error('请选择已存在的空目录');
    const engine = new Engine(directory, settings);
    await engine.testConnection(); await engine.initialize();
    const preview = await engine.previewPull(); await engine.apply(preview.id);
    return engine;
  }
}
