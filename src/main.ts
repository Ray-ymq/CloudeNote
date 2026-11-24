import { FileSystemAdapter, ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, requestUrl } from 'obsidian';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Engine, defaults } from './engine';
import { generator } from './ai';
import { Choice, Preview, Settings } from './types';

const VIEW = 'cloudnote-panel';
const titles = { overview: '同步概览', history: '版本历史', snapshots: '整库快照', conflicts: '冲突处理', devices: '连接设备', settings: '插件设置' };
type Tab = keyof typeof titles;

export default class Cloudnote extends Plugin {
  declare settings: Settings;
  engine!: Engine;
  private sessionKey = '';
  private debounce?: ReturnType<typeof setTimeout>;
  private autoRunning = false;
  private autoAgain = false;
  private unloaded = false;
  private status!: HTMLElement;
  private unsubscribeEngine?: () => void;

  async onload() {
    const saved = await this.loadData() as Partial<Settings> | null;
    // Whitelist settings: a legacy or injected apiKey field is never written back.
    this.settings = defaults();
    for (const key of Object.keys(this.settings) as (keyof Settings)[]) {
      if (saved && typeof saved[key] === typeof this.settings[key]) Object.assign(this.settings, { [key]: saved[key] });
    }
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) { new Notice('云笺仅支持桌面本地知识库'); return; }
    this.makeEngine();
    this.status = this.addStatusBarItem();
    this.subscribeEngine();
    this.registerView(VIEW, leaf => new CloudnoteView(leaf, this));
    this.addRibbonIcon('cloud', '云笺', () => { void this.open(); });
    this.addCommand({ id: 'open', name: '打开同步面板', callback: () => { void this.open(); } });
    this.addCommand({ id: 'sync', name: '立即同步', callback: () => { void this.action(() => this.engine.sync()); } });
    this.addCommand({ id: 'pull', name: '预览云端拉取', callback: () => { void this.action(() => this.engine.previewPull()); } });
    this.addSettingTab(new CloudnoteSettings(this));
    const changed = (file: { path: string }) => {
      if (file.path.split('/').some(p => ['.obsidian', '.trash', '.git', '.cloudnote'].includes(p.toLowerCase()))) return;
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => { void this.auto(); }, 3000);
    };
    this.registerEvent(this.app.vault.on('create', changed));
    this.registerEvent(this.app.vault.on('modify', changed));
    this.registerEvent(this.app.vault.on('delete', changed));
    this.registerEvent(this.app.vault.on('rename', changed));
    this.registerInterval(window.setInterval(() => { void this.auto(); }, 30_000));
    this.app.workspace.onLayoutReady(() => { void this.refresh(); });
  }
  private makeEngine() {
    this.engine = new Engine((this.app.vault.adapter as FileSystemAdapter).getBasePath(), this.settings,
      generator(() => this.settings, async () => this.app.secretStorage?.getSecret(this.settings.secretName) ?? this.sessionKey,
        async (body, key, signal) => {
          // Obsidian requestUrl bypasses browser CORS. The generator enforces the deadline;
          // late responses are ignored and cannot cause a second commit.
          if (signal.aborted) throw new Error('请求超时');
          const response = await requestUrl({ url: 'https://api.deepseek.com/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), throw: false });
          return { status: response.status, json: response.json as unknown };
        }));
  }
  private subscribeEngine() {
    this.unsubscribeEngine?.();
    const unsubscribe = this.engine.subscribe(state => {
      this.status?.setText(`云笺 · ${state.phase === 'busy' ? '处理中' : state.conflicts ? `${state.conflicts} 项冲突` : state.pendingCommit || state.pendingPush ? '待同步' : state.phase === 'error' ? '失败' : '就绪'}`);
    });
    this.unsubscribeEngine = unsubscribe;
    this.register(unsubscribe);
  }
  async saveSettings() { await this.saveData(this.settings); }
  async updateConnection(key: 'gitPath' | 'remote', value: string) {
    if (this.engine.isWorking || this.engine.preview) throw new Error('请先完成当前任务或预览');
    this.settings[key] = value.trim(); this.settings.connectionTested = false; this.settings.autoSync = false;
    this.makeEngine(); this.subscribeEngine(); await this.saveSettings(); await this.render();
  }
  async setKey(value: string) {
    if (this.app.secretStorage) this.app.secretStorage.setSecret(this.settings.secretName, value);
    else this.sessionKey = value;
  }
  async refresh() { if (await this.engine.isManaged()) await this.action(() => this.engine.refresh(), false); }
  async action<T>(operation: () => Promise<T>, showPreview = true) {
    try {
      const result = await operation();
      if (showPreview && this.engine.preview) new PreviewModal(this, this.engine.preview).open();
      await this.render(); return result;
    } catch (error) { new Notice((error as Error).message, 9000); await this.render(); return undefined; }
  }
  private async auto() {
    if (this.unloaded || !this.settings.autoSync || !this.settings.connectionTested || this.engine.preview || !await this.engine.isManaged()) return;
    if (this.autoRunning) { this.autoAgain = true; return; }
    this.autoRunning = true;
    try {
      do {
        this.autoAgain = false;
        try { await this.engine.sync(); } catch { /* State and panel retain the actionable error; no repeating notices. */ }
        await this.render();
      } while (this.autoAgain && !this.engine.preview && !this.unloaded && this.settings.autoSync);
    } finally { this.autoRunning = false; }
  }
  async render() {
    if (this.unloaded) return;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) await (leaf.view as CloudnoteView).render();
  }
  async open() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW)[0] ?? this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW, active: true }); await this.app.workspace.revealLeaf(leaf);
  }
  onunload() { this.unloaded = true; if (this.debounce) clearTimeout(this.debounce); this.sessionKey = ''; }
}

function button(parent: HTMLElement, label: string, action: () => void | Promise<unknown>, primary = false) {
  const element = parent.createEl('button', { text: label, cls: primary ? 'mod-cta' : '' });
  element.addEventListener('click', () => {
    element.disabled = true;
    void Promise.resolve().then(action).catch(e => new Notice((e as Error).message, 8000)).finally(() => { element.disabled = false; });
  });
  return element;
}
function description(parent: HTMLElement, text: string) { parent.createEl('p', { text, cls: 'cloudnote-muted' }); }
function changeList(parent: HTMLElement, preview: Preview) {
  if (!preview.changes.length) description(parent, '没有独立文件变化；如存在冲突，仍需选择处理方式。');
  const list = parent.createEl('ul', { cls: 'cloudnote-changes' });
  for (const change of preview.changes) list.createEl('li', { text: `${!change.before ? '新增' : !change.after ? '删除' : '覆盖'}　${change.path}` });
}

class CloudnoteView extends ItemView {
  tab: Tab = 'overview';
  private generation = 0;
  private historyQuery = '';
  private historyFile = '';
  private historyOffset = 0;
  constructor(leaf: WorkspaceLeaf, readonly plugin: Cloudnote) { super(leaf); }
  getViewType() { return VIEW; }
  getDisplayText() { return '云笺'; }
  getIcon() { return 'cloud'; }
  async onOpen() { await this.render(); }
  async render() {
    const generation = ++this.generation;
    const root = this.contentEl; root.empty(); root.addClass('cloudnote');
    const heading = root.createDiv({ cls: 'cloudnote-heading' });
    heading.createEl('h2', { text: '云笺' });
    description(heading, this.plugin.app.vault.getName());
    const nav = root.createEl('nav', { cls: 'cloudnote-nav', attr: { 'aria-label': '云笺功能' } });
    for (const [key, title] of Object.entries(titles)) {
      const el = button(nav, title, async () => { this.tab = key as Tab; await this.render(); });
      el.setAttribute('aria-current', this.tab === key ? 'page' : 'false');
    }
    const body = root.createDiv(); body.createEl('h3', { text: titles[this.tab] });
    try {
      const engine = this.plugin.engine;
      if (this.tab === 'settings') { renderSettings(body, this.plugin); return; }
      if (!await engine.isManaged()) {
        if (generation !== this.generation) return;
        description(body, '先在插件设置填写 Git 和 SSH 地址并测试连接，然后预览同步范围并初始化独立知识库。已有非云笺仓库不会被接管。');
        button(body, '打开插件设置', async () => { this.tab = 'settings'; await this.render(); }); return;
      }
      if (generation !== this.generation) return;
      if (this.tab === 'overview') {
        const state = engine.state;
        const banner = body.createDiv({ cls: `cloudnote-banner cloudnote-${state.phase}` });
        banner.createEl('strong', { text: state.message });
        description(banner, state.lastSuccess ? `最近云端同步成功：${new Date(state.lastSuccess).toLocaleString()}` : '尚无云端同步成功记录');
        const stats = body.createDiv({ cls: 'cloudnote-stats' });
        for (const [name, count] of [['待提交文件', state.pendingCommit], ['待推送提交', state.pendingPush], ['待拉取提交', state.pendingPull], ['冲突文件', state.conflicts]]) {
          const card = stats.createDiv({ cls: 'cloudnote-card' }); card.createEl('strong', { text: String(count) }); description(card, String(name));
        }
        const actions = body.createDiv({ cls: 'cloudnote-actions' });
        button(actions, '立即同步', () => this.plugin.action(() => engine.sync()), true);
        button(actions, '预览云端拉取', () => this.plugin.action(() => engine.previewPull()));
        button(actions, '仅保存本地提交', () => this.plugin.action(() => engine.save()));
        button(actions, '刷新本地状态', () => this.plugin.refresh());
        if (engine.preview) button(actions, '继续处理预览', () => new PreviewModal(this.plugin, engine.preview!).open());
        description(body, '编辑停止 3 秒后同步，每 30 秒检查云端；自动同步与 AI 默认关闭。单独拉取不推送本地提交。');
        if (state.aiFallback) description(body, `AI 已回退默认说明：${state.aiFallback}`);
        for (const skip of state.skipped) description(body, `未同步：${skip.path} · ${skip.reason}`);
      } else if (this.tab === 'history') {
        description(body, '输入精确文件路径可查询已删除文件，完整历史可翻页查看；当前页可搜索说明、哈希与设备名称。每次恢复先保存当前修改，再创建新提交。');
        const filter = body.createDiv({ cls: 'cloudnote-actions' });
        const file = filter.createEl('input', { type: 'text', placeholder: '文件路径，如 日记/今天.md', value: this.historyFile, attr: { 'aria-label': '历史文件路径' } });
        const query = filter.createEl('input', { type: 'search', placeholder: '搜索说明、哈希或设备', value: this.historyQuery, attr: { 'aria-label': '搜索提交历史' } });
        button(filter, '查询', async () => { this.historyFile = file.value.trim(); this.historyQuery = query.value.trim(); this.historyOffset = 0; await this.render(); });
        const entries = await engine.history(this.historyFile || undefined, 100, 'refs/heads/main', this.historyOffset);
        if (generation !== this.generation) return;
        const matching = entries.filter(e => `${e.hash} ${e.message} ${e.device}`.toLowerCase().includes(this.historyQuery.toLowerCase()));
        description(body, `第 ${Math.floor(this.historyOffset / 100) + 1} 页，每页最多 100 条，筛选后显示 ${matching.length} 条。`);
        const pagination = body.createDiv({ cls: 'cloudnote-actions' });
        button(pagination, '上一页', async () => { this.historyOffset = Math.max(0, this.historyOffset - 100); await this.render(); }).disabled = this.historyOffset === 0;
        button(pagination, '下一页', async () => { this.historyOffset += 100; await this.render(); }).disabled = entries.length < 100;
        for (const entry of matching) {
          const card = body.createDiv({ cls: 'cloudnote-card' }); card.createEl('strong', { text: entry.message });
          description(card, `${entry.hash.slice(0, 12)} · ${new Date(entry.date).toLocaleString()} · ${entry.device}`);
          if (this.historyFile) {
            button(card, '查看内容与差异', async () => {
              const data = await engine.fileVersion(entry.hash, this.historyFile);
              const diff = await engine.diff(entry.hash, this.historyFile);
              new ContentModal(this.plugin, this.historyFile, data, diff, entry.hash).open();
            });
            button(card, '恢复预览', () => this.plugin.action(() => engine.previewRestore(entry.hash, this.historyFile)));
          } else button(card, '查看该提交文件', async () => {
            const tree = await engine.tree(entry.hash);
            new FilesModal(this.plugin, entry.hash, Object.keys(tree), file => { this.historyFile = file; void this.render(); }).open();
          });
        }
      } else if (this.tab === 'snapshots') {
        description(body, '快照使用带注释 Git 标签保存已提交状态，下一次同步会补传未上传标签。整库恢复会预览新增、覆盖与删除，并保存恢复前状态。');
        button(body, '创建快照', () => new InputModal(this.plugin, '快照名称', '手动快照', value => this.plugin.action(() => engine.createSnapshot(value))).open(), true);
        const snapshots = await engine.snapshots(); if (generation !== this.generation) return;
        if (!snapshots.length) description(body, '尚无快照；拉取云端后也会获取其他设备的快照。');
        for (const snapshot of snapshots) {
          const card = body.createDiv({ cls: 'cloudnote-card' }); card.createEl('strong', { text: snapshot.name }); description(card, `${snapshot.hash.slice(0, 12)} · ${new Date(snapshot.date).toLocaleString()}`);
          button(card, '整库恢复预览', () => this.plugin.action(() => engine.previewRestore(snapshot.hash)));
        }
      } else if (this.tab === 'conflicts') {
        description(body, '同一文件的并发修改由你选择。保留双方时，云端内容保留原路径，本地内容另存副本；所有选择完成后才能整合与推送。');
        if (!engine.preview) description(body, '当前没有待处理冲突。');
        else { description(body, `${engine.preview.conflicts.length} 项冲突，双方提交均已保留。`); button(body, '比较并处理冲突', () => new PreviewModal(this.plugin, engine.preview!).open(), true); }
      } else if (this.tab === 'devices') {
        description(body, '设备信息来自最近 500 条可达提交，仅表示最近提交时间。此信息不能判断设备是否实时在线。');
        const devices = await engine.devices(); if (generation !== this.generation) return;
        for (const device of devices) { const card = body.createDiv({ cls: 'cloudnote-card' }); card.createEl('strong', { text: device.device }); description(card, `${device.deviceId} · 最近提交 ${new Date(device.date).toLocaleString()}`); }
      }
    } catch (error) { description(body, (error as Error).message); }
  }
}

class PreviewModal extends Modal {
  constructor(readonly plugin: Cloudnote, readonly preview: Preview) { super(plugin.app); }
  async onOpen() {
    const root = this.contentEl; root.empty(); root.addClass('cloudnote');
    root.createEl('h2', { text: this.preview.kind === 'restore' ? '历史恢复预览' : '云端整合预览' });
    description(root, '确认时会重新检查远端提交和受影响文件。取消不应用预览；恢复预览前保存的本地提交仍然保留。');
    changeList(root, this.preview);
    for (const conflict of this.preview.conflicts) {
      const card = root.createDiv({ cls: 'cloudnote-card' }); card.createEl('h3', { text: conflict.path });
      const compare = card.createDiv({ cls: 'cloudnote-compare' });
      for (const [label, oid] of [[`本地 · ${conflict.localDevice}`, conflict.before], [`云端 · ${conflict.remoteDevice}`, conflict.after]]) {
        const column = compare.createDiv(); column.createEl('strong', { text: label });
        if (!oid) description(column, '此版本已删除文件');
        else {
          const data = await this.plugin.engine.git.blob(oid);
          if (/\.(md|txt|canvas|json|ya?ml|csv)$/i.test(conflict.path) && !data.includes(0)) column.createEl('pre', { text: data.subarray(0, 32 * 1024).toString('utf8') + (data.length > 32 * 1024 ? '\n[预览截断，下载可查看全文]' : '') });
          else description(column, `附件 · ${data.length} 字节 · ${oid.slice(0, 12)}`);
          button(column, '下载此版本', () => downloadModal(this.plugin, conflict.path, data));
        }
      }
      const setting = new Setting(card).setName('处理方式');
      setting.addDropdown(drop => {
        drop.addOptions({ '': '请选择', local: '使用本地', remote: '使用云端', both: '保留双方文件' });
        drop.setValue(this.preview.choices[conflict.path] ?? '');
        drop.onChange(value => { if (value) this.plugin.engine.choose(this.preview.id, conflict.path, value as Choice); else delete this.preview.choices[conflict.path]; });
      });
    }
    const actions = root.createDiv({ cls: 'cloudnote-actions' });
    button(actions, '取消预览', async () => { this.plugin.engine.cancel(this.preview.id); this.close(); await this.plugin.render(); });
    button(actions, '确认应用', async () => {
      try {
        await this.plugin.engine.apply(this.preview.id); this.close();
        if (this.plugin.engine.preview) new PreviewModal(this.plugin, this.plugin.engine.preview).open();
      } finally { await this.plugin.render(); }
    }, true);
  }
  onClose() { this.contentEl.empty(); }
}

class InputModal extends Modal {
  constructor(readonly plugin: Cloudnote, readonly title: string, readonly value: string, readonly action: (value: string) => Promise<unknown>) { super(plugin.app); }
  onOpen() {
    this.contentEl.createEl('h2', { text: this.title });
    const input = this.contentEl.createEl('input', { type: 'text', value: this.value, attr: { 'aria-label': this.title } }); input.style.width = '100%';
    button(this.contentEl, '确认', async () => { if (!input.value.trim()) throw new Error('请输入内容'); await this.action(input.value.trim()); this.close(); }, true);
  }
  onClose() { this.contentEl.empty(); }
}
function downloadModal(plugin: Cloudnote, file: string, bytes: Buffer) {
  new InputModal(plugin, '另存历史附件（完整目标路径，不能覆盖现有文件）', path.join(plugin.engine.root, path.basename(file) + '.history'), async destination => {
    if (!path.isAbsolute(destination)) throw new Error('请输入绝对路径');
    const handle = await fs.open(destination, 'wx');
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    new Notice('历史内容已另存');
  }).open();
}
class ContentModal extends Modal {
  constructor(readonly plugin: Cloudnote, readonly file: string, readonly bytes: Buffer | undefined, readonly diff: string, readonly hash: string) { super(plugin.app); }
  onOpen() {
    this.contentEl.addClass('cloudnote'); this.contentEl.createEl('h2', { text: this.file });
    if (!this.bytes) description(this.contentEl, '该提交中此文件已删除。可以选择删除前的提交恢复内容。');
    else {
      if (/\.(md|txt|canvas|json)$/i.test(this.file) && !this.bytes.includes(0)) this.contentEl.createEl('pre', { text: this.bytes.subarray(0, 128 * 1024).toString('utf8') });
      button(this.contentEl, '另存此版本', () => downloadModal(this.plugin, this.file, this.bytes!));
    }
    this.contentEl.createEl('h3', { text: '相对前一版本的差异' });
    this.contentEl.createEl('pre', { text: this.diff.slice(0, 128 * 1024) || '没有文本差异（附件或整合提交可另存查看）' });
    button(this.contentEl, '恢复预览', async () => { this.close(); await this.plugin.action(() => this.plugin.engine.previewRestore(this.hash, this.file)); }, true);
  }
  onClose() { this.contentEl.empty(); }
}
class FilesModal extends Modal {
  constructor(readonly plugin: Cloudnote, readonly hash: string, readonly files: string[], readonly select: (file: string) => void) { super(plugin.app); }
  onOpen() {
    this.contentEl.createEl('h2', { text: '提交中的文件' });
    description(this.contentEl, '选择文件后可查看完整文件历史；当前列表包含此提交存在的文件。');
    for (const file of this.files) button(this.contentEl, file, () => { this.select(file); this.close(); });
  }
  onClose() { this.contentEl.empty(); }
}

class CloudnoteSettings extends PluginSettingTab {
  constructor(readonly plugin: Cloudnote) { super(plugin.app, plugin); }
  display() { this.containerEl.empty(); renderSettings(this.containerEl, this.plugin); }
}
function renderSettings(root: HTMLElement, plugin: Cloudnote) {
  const settings = plugin.settings;
  description(root, '需要 Git 2.40+ 和已配置的 SSH Agent。笔记保存在本地，通过 SSH 同步到私人 Git 裸仓库。');
  new Setting(root).setName('Git 可执行文件').setDesc('修改后自动同步会关闭，需重新测试连接。').addText(text => text.setValue(settings.gitPath).onChange(value => { text.inputEl.onblur = () => { void plugin.updateConnection('gitPath', value).catch(e => new Notice((e as Error).message)); }; }));
  new Setting(root).setName('SSH 远端地址').setDesc('如 git@example.com:notes.git，不保存私钥。').addText(text => text.setValue(settings.remote).onChange(value => { text.inputEl.onblur = () => { void plugin.updateConnection('remote', value).catch(e => new Notice((e as Error).message)); }; }));
  new Setting(root).setName('设备名称').addText(text => text.setValue(settings.deviceName).onChange(async value => { settings.deviceName = value; await plugin.saveSettings(); }));
  new Setting(root).setName('连接测试').setDesc(settings.connectionTested ? '本次配置已通过测试' : '尚未测试当前配置').addButton(b => b.setButtonText('测试连接').onClick(async () => {
    b.setDisabled(true);
    try { new Notice(await plugin.engine.testConnection()); settings.connectionTested = true; await plugin.saveSettings(); }
    catch (error) { settings.connectionTested = false; await plugin.saveSettings(); new Notice((error as Error).message, 9000); }
    finally { b.setDisabled(false); }
  }));
  new Setting(root).setName('初始化知识库').setDesc('先预览同步范围，确认后创建受管仓库并首次同步。').addButton(b => b.setButtonText('预览初始化').onClick(async () => {
    try {
      if (!settings.connectionTested) throw new Error('请先测试当前 SSH 连接');
      const scope = await plugin.engine.scope();
      const modal = new Modal(plugin.app); modal.contentEl.createEl('h2', { text: '首次同步范围' });
      description(modal.contentEl, `${Object.keys(scope.tree).length} 个文件；排除 .obsidian、.trash、.git 和临时数据，单文件上限 100 MiB。已有远端内容将在首次比较后整合，同名差异等待人工处理。`);
      const list = modal.contentEl.createEl('ul'); for (const file of Object.keys(scope.tree)) list.createEl('li', { text: file });
      for (const skip of scope.skipped) description(modal.contentEl, `${skip.path}：${skip.reason}`);
      button(modal.contentEl, '确认初始化并同步', async () => { await plugin.engine.initialize(); modal.close(); await plugin.action(() => plugin.engine.sync()); }, true); modal.open();
    } catch (error) { new Notice((error as Error).message, 9000); }
  }));
  new Setting(root).setName('新设备下载').setDesc('填写本机已存在的空目录，下载后在 Obsidian 中打开。').addButton(b => b.setButtonText('选择空目录路径').onClick(() => {
    new InputModal(plugin, '下载到空目录（绝对路径）', '', async directory => {
      if (!settings.connectionTested || !path.isAbsolute(directory)) throw new Error('先测试连接并输入绝对目录路径');
      await Engine.download(directory, { ...settings, deviceId: defaults().deviceId }); new Notice('下载完成，请在 Obsidian 中打开该目录作为知识库');
    }).open();
  }));
  new Setting(root).setName('自动同步').setDesc('编辑停止 3 秒后同步，每 30 秒检查云端。').addToggle(toggle => toggle.setValue(settings.autoSync).onChange(async value => {
    if (value && !settings.connectionTested) { new Notice('先测试当前连接'); toggle.setValue(false); return; }
    settings.autoSync = value; await plugin.saveSettings();
  }));
  root.createEl('h3', { text: 'DeepSeek 提交说明' });
  description(root, '开启后会向 DeepSeek 发送本次待提交的文件名与文本差异，附件只发送名称和类型。每次最多 24 KiB，超时或失败回退默认说明。');
  new Setting(root).setName('启用 AI').addToggle(toggle => toggle.setValue(settings.aiEnabled).onChange(async value => { settings.aiEnabled = value; await plugin.saveSettings(); }));
  new Setting(root).setName('仅发送文件名与变更类型').addToggle(toggle => toggle.setValue(settings.aiNamesOnly).onChange(async value => { settings.aiNamesOnly = value; await plugin.saveSettings(); }));
  new Setting(root).setName('模型 ID').addText(text => text.setValue(settings.aiModel).onChange(async value => { settings.aiModel = value.trim(); await plugin.saveSettings(); }));
  new Setting(root).setName('API Key').setDesc(plugin.app.secretStorage ? '保存在 Obsidian SecretStorage；留空并保存可移除。' : '当前 Obsidian 不支持 SecretStorage，仅在当前会话保存。').addText(text => {
    text.inputEl.type = 'password'; text.inputEl.autocomplete = 'off'; text.setPlaceholder('输入新 Key，点击保存');
    new Setting(root).setName('保存或移除 Key').addButton(b => b.setButtonText('保存 Key').onClick(async () => { await plugin.setKey(text.getValue().trim()); text.setValue(''); new Notice('Key 已更新'); }));
  });
  description(root, '同步和恢复不会清理可达历史，服务器仍应独立备份。云端管理员可以读取仓库内容；第一版不提供端到端加密。');
}
