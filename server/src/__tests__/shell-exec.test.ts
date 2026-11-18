import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { bangContextBlocks, runBang, truncateOutput } from '../shell-exec.js';

describe('truncateOutput', () => {
  it('keeps short output and marks the cut on long output', () => {
    expect(truncateOutput('abc', 5)).toBe('abc');
    expect(truncateOutput('abcdefgh', 5)).toBe('abcde\n… [3 more characters truncated]');
  });
});

describe('bangContextBlocks', () => {
  it('renders the Claude Code bash-mode tags', () => {
    expect(bangContextBlocks({ command: 'ls', stdout: 'a\nb', stderr: '', code: 0 })).toEqual([
      '<bash-input>ls</bash-input>',
      '<bash-stdout>a\nb</bash-stdout><bash-stderr></bash-stderr>',
    ]);
  });
  it('reports exit code, timeout and guard blocks in stderr', () => {
    expect(bangContextBlocks({ command: 'false', stdout: '', stderr: '', code: 1 })[1]).toContain('<bash-stderr>Exit code 1</bash-stderr>');
    expect(bangContextBlocks({ command: 'x', stdout: '', stderr: 'e', code: null, timedOut: true })[1]).toContain('e\nCommand timed out');
    expect(bangContextBlocks({ command: 'sudo x', stdout: '', stderr: '', code: null, blocked: 'sudo: no' })[1]).toContain('Blocked by aie-studio shell guard (sudo: no)');
  });
  it('escapes closing tags inside output', () => {
    expect(bangContextBlocks({ command: 'x', stdout: '</bash-stdout>', stderr: '', code: 0 })[1]).toBe(
      '<bash-stdout><\\/bash-stdout></bash-stdout><bash-stderr></bash-stderr>',
    );
  });
});

describe('runBang', () => {
  it('runs in cwd with stdin closed and captures both streams', async () => {
    const r = await runBang('pwd; echo err >&2; read x || echo no-stdin; exit 3', os.tmpdir()).promise;
    expect(r.stdout.split('\n').at(-2)).toMatch(/T|tmp/);
    expect(r.stdout).toContain('no-stdin');
    expect(r.stderr).toContain('err');
    expect(r.code).toBe(3);
  }, 20_000);
  it('never runs a guarded command', async () => {
    const r = await runBang('sudo rm -rf /', os.tmpdir()).promise;
    expect(r.blocked).toMatch(/^sudo:/);
    expect(r.code).toBeNull();
  });
  it('kills the command on timeout', async () => {
    const r = await runBang('sleep 30', os.tmpdir(), 1500).promise;
    expect(r.timedOut).toBe(true);
  }, 20_000);
});

