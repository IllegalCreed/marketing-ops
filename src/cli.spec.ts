import { describe, expect, it } from 'vitest';
import { parseCliArgs, renderCliHelp } from './cli-core.js';

describe('marketing-ops CLI UX', () => {
  it('TC-AUTO-UX-127-01 setup/status/doctor 清晰且日常不要求 JSON 或 CLI', () => {
    const help = renderCliHelp();
    expect(help).toMatch(/setup[\s\S]*status[\s\S]*doctor/i);
    expect(help).toMatch(/daily campaigns.*Codex|日常.*Codex/i);
    expect(help).toMatch(/never.*password|不.*密码/i);
    expect(parseCliArgs(['setup', 'dev'])).toEqual({ command: 'setup', channel: 'dev' });
    expect(parseCliArgs(['status'])).toEqual({ command: 'status' });
    expect(parseCliArgs(['doctor'])).toEqual({ command: 'doctor' });
    for (const unsafe of ['--token', '--password', '--cookie', '--profile', '--json']) {
      expect(() => parseCliArgs(['setup', 'dev', unsafe, 'unsafe'])).toThrow(/not accepted/i);
    }
  });

  it('TC-AUTO-CLI-133-01 project 命令与显式项目选择保持低摩擦且拒绝秘密参数', () => {
    expect(parseCliArgs(['project', 'add'])).toEqual({ command: 'project-add' });
    expect(parseCliArgs(['project', 'list'])).toEqual({ command: 'project-list' });
    expect(parseCliArgs(['project', 'show', 'algorithm-visualizer'])).toEqual({
      command: 'project-show',
      projectId: 'algorithm-visualizer',
    });
    expect(parseCliArgs(['setup', 'github', '--project', 'algorithm-visualizer'])).toEqual({
      command: 'setup',
      channel: 'github',
      projectId: 'algorithm-visualizer',
    });
    expect(parseCliArgs(['status', '--project', 'algorithm-visualizer'])).toEqual({
      command: 'status',
      projectId: 'algorithm-visualizer',
    });
    expect(parseCliArgs(['doctor', '--project', 'algorithm-visualizer'])).toEqual({
      command: 'doctor',
      projectId: 'algorithm-visualizer',
    });
    expect(() => parseCliArgs(['project', 'show', '../escape'])).toThrow(/project/i);
    expect(() => parseCliArgs(['setup', 'github', '--repository', 'owner/repository'])).toThrow();
  });
});
