import { describe, expect, it, vi } from 'vitest';
import { aiInput, generator, textDiff } from '../src/ai';
import { defaults } from '../src/engine';
import { Change } from '../src/types';

const delta: Change[] = [{ path: 'note.md', after: 'b' }, { path: 'image.png', before: 'a', after: 'b' }];
const read = async (oid: string) => Buffer.from(oid === 'a' ? '旧内容' : '新内容');
describe('AI messages', () => {
  it('sends a text diff without unchanged prefix and suffix lines', () => {
    const diff = textDiff('私密未修改前缀\n旧\n未修改后缀', '私密未修改前缀\n新\n未修改后缀');
    expect(diff).toContain('-旧'); expect(diff).toContain('+新'); expect(diff).not.toContain('私密'); expect(diff).not.toContain('后缀');
  });
  it('does not request AI for disabled, missing-key or empty changes', async () => {
    const transport = vi.fn(); const settings = defaults(); const generate = generator(() => settings, async () => undefined, transport);
    expect((await generate(delta, read)).source).toBe('default'); settings.aiEnabled = true;
    expect((await generate(delta, read)).reason).toContain('缺少'); await generate([], read); expect(transport).not.toHaveBeenCalled();
  });
  it('bounds UTF-8 input to 24 KiB, marks truncation, and excludes attachment bytes', async () => {
    const input = await aiInput(delta, async () => Buffer.from('长'.repeat(30_000)), false);
    expect(Buffer.byteLength(input)).toBeLessThanOrEqual(24 * 1024); expect(input).toContain('截断');
    const names = await aiInput(delta, read, true); expect(names).toContain('note.md'); expect(names).not.toContain('新内容');
    const binary = await aiInput([{ path: 'a.pdf', after: 'b' }], async () => { throw new Error('must not read attachment'); }, false); expect(binary).toContain('a.pdf');
  });
  it('normalizes response text and limits it to 120 Unicode characters', async () => {
    const settings = { ...defaults(), aiEnabled: true };
    const generate = generator(() => settings, async () => 'private', async () => ({ status: 200, json: { choices: [{ message: { content: '\n说明\n' + '中'.repeat(200) } }] } }));
    const result = await generate(delta, read); expect(result.source).toBe('ai'); expect(Array.from(result.message)).toHaveLength(120); expect(result.message).not.toContain('\n');
  });
  it.each([429, 500, 401])('falls back on HTTP %i without retries', async status => {
    const transport = vi.fn(async () => ({ status, json: {} }));
    const generate = generator(() => ({ ...defaults(), aiEnabled: true }), async () => 'private', transport);
    expect((await generate(delta, read)).message).toContain('新增 1 个'); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('falls back for invalid responses and sanitizes network error details', async () => {
    for (const transport of [async () => ({ status: 200, json: {} }), async () => { throw new Error('Authorization: private-key'); }]) {
      const generate = generator(() => ({ ...defaults(), aiEnabled: true }), async () => 'private', transport);
      const result = await generate(delta, read); expect(result.source).toBe('default'); expect(result.reason).not.toContain('private');
    }
  });
  it('times out at ten seconds and ignores late responses', async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn(() => new Promise<{ status: number; json: unknown }>(() => undefined));
      const generate = generator(() => ({ ...defaults(), aiEnabled: true }), async () => 'private', transport);
      const pending = generate(delta, read); await vi.advanceTimersByTimeAsync(10_001); const result = await pending;
      expect(result.reason).toBe('请求超时'); expect(transport).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
