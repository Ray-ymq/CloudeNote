import { spawn } from 'node:child_process';
import path from 'node:path';

export class GitError extends Error {
  constructor(readonly args: string[], readonly code: number | null, readonly detail: string) {
    super(/Permission denied|Host key verification failed|Could not resolve|Connection refused|timed out/i.test(detail)
      ? 'SSH 连接失败：请检查 SSH Agent、主机信任、地址及网络。'
      : `Git 操作失败 (${args[0] ?? 'git'})：${detail.slice(0, 800)}`);
  }
}
export class Git {
  constructor(readonly root: string, readonly executable = 'git') {}
  async run(args: string[], input?: Buffer | string, env: NodeJS.ProcessEnv = {}, allowed = [0]): Promise<Buffer> {
    if (!this.executable || this.executable.startsWith('-') || /[\r\n\0]/.test(this.executable)) throw new Error('Git 路径无效');
    return new Promise((resolve, reject) => {
      const inherited = { ...process.env };
      for (const key of Object.keys(inherited)) if (key.startsWith('GIT_')) delete inherited[key];
      const proc = spawn(this.executable, ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'fetch.fsckObjects=true', '-c', 'core.hooksPath=' + path.join(this.root, '.git/cloudnote/no-hooks'), ...args], {
        cwd: this.root, shell: false, windowsHide: true,
        env: { ...inherited, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes', GIT_OPTIONAL_LOCKS: '0', ...env }
      });
      const out: Buffer[] = [], err: Buffer[] = [];
      let size = 0, settled = false;
      const timer = setTimeout(() => { proc.kill(); done(new Error('Git 操作超时，保留本地内容后可重试。')); }, 120_000);
      const done = (error?: Error, result?: Buffer) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(result!);
      };
      proc.on('error', error => done(error));
      proc.stdout.on('data', (data: Buffer) => {
        size += data.length;
        if (size > 128 * 1024 * 1024) { proc.kill(); done(new Error('Git 输出超出安全上限')); }
        else out.push(data);
      });
      proc.stderr.on('data', (data: Buffer) => { if (Buffer.concat(err).length < 8192) err.push(data); });
      proc.on('close', code => {
        const output = Buffer.concat(out);
        const detail = Buffer.concat(err).toString('utf8') + (args[0] === 'push' ? '\n' + output.toString('utf8').slice(0, 4096) : '');
        done(allowed.includes(code ?? -1) ? undefined : new GitError(args, code, detail), output);
      });
      proc.stdin.on('error', () => undefined);
      proc.stdin.end(input);
    });
  }
  async text(args: string[], input?: Buffer | string, env?: NodeJS.ProcessEnv, allowed?: number[]) {
    return (await this.run(args, input, env, allowed)).toString('utf8').trim();
  }
  async version() {
    const value = await this.text(['--version']);
    const match = /git version (\d+)\.(\d+)/.exec(value);
    if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 40)) throw new Error('需要 Git 2.40 或更新版本');
    return value;
  }
  async head(ref = 'refs/heads/main'): Promise<string | undefined> {
    const value = await this.text(['rev-parse', '--verify', '--quiet', ref], undefined, undefined, [0, 1]);
    return value || undefined;
  }
  async blob(oid: string) {
    if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error('无效对象哈希');
    return this.run(['cat-file', 'blob', oid]);
  }
}
