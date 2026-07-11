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
});
