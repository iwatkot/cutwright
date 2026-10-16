import { describe, expect, it } from 'vitest';
import { cliInvocation } from '../electron/agentCli';

describe('Windows provider launchers', () => {
  it('invokes native binaries without a command shell', () => {
    const spec = cliInvocation('C:\\Apps\\Muse\\muse.exe', ['exec', '--prompt-file', 'C:\\Temp\\a & b\\prompt.txt'], 'win32');
    expect(spec.command).toBe('C:\\Apps\\Muse\\muse.exe');
    expect(spec.args).toEqual(['exec', '--prompt-file', 'C:\\Temp\\a & b\\prompt.txt']);
  });
  it('launches cmd shims through quoted environment references with no prompt interpolation', () => {
    const spec = cliInvocation('C:\\User & stuff\\claude.cmd', ['--print', '--tools', ''], 'win32');
    expect(spec.command.toLowerCase()).toMatch(/cmd.exe$/);
    expect(spec.args.at(-1)).toBe('""%CW_AGENT_BIN%" "%CW_AGENT_ARG_0%" "%CW_AGENT_ARG_1%" "%CW_AGENT_ARG_2%""');
    expect(spec.env.CW_AGENT_ARG_2).toBe('');
    expect(spec.env.CW_AGENT_BIN).toBe('C:\\User & stuff\\claude.cmd');
  });
});
