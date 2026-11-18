import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { checkCommand, segments } from '../shell-guard.js';

const none = {};
const blocked = (line: string, cfg = none) => checkCommand(line, cfg);
const ruleOf = (line: string, cfg = none) => {
  const v = checkCommand(line, cfg);
  return v.blocked ? v.ruleId : null;
};

describe('segments', () => {
  it('splits on separators and strips assignments / wrappers / paths', () => {
    expect(segments('FOO=1 nohup /bin/rm -rf x && echo hi | \\grep h').map((s) => s.text)).toEqual([
      'rm -rf x',
      'echo hi',
      'grep h',
    ]);
    expect(segments('nice -n 5 env A=b sudo ls').map((s) => s.argv[0])).toEqual(['sudo']);
  });
});

describe('checkCommand — blocks', () => {
  it.each([
    ['sudo rm foo', 'sudo'],
    ['echo ok; sudo -s', 'sudo'],
    ['su root', 'sudo'],
    ['rm -rf /', 'rm-critical'],
    ['rm -fr ~', 'rm-critical'],
    ['rm -r -f $HOME/', 'rm-critical'],
    [`rm -rf ${os.homedir()}`, 'rm-critical'],
    ['rm --recursive --force /usr', 'rm-critical'],
    ['rm -rf .', 'rm-critical'],
    ['rm -rf *', 'rm-critical'],
    ['\\rm -Rf "/"', 'rm-critical'],
    ['chmod -R 777 /', 'perm-critical'],
    ['chown -R nobody ~', 'perm-critical'],
    ['mkfs.ext4 /dev/sda1', 'disk'],
    ['dd if=/dev/zero of=/dev/disk2 bs=1m', 'disk'],
    ['diskutil eraseDisk APFS X disk2', 'disk'],
    ['cat x > /dev/rdisk3', 'disk'],
    ['shutdown -h now', 'power'],
    ['reboot', 'power'],
    ['kill -9 -1', 'kill-all'],
    ['killall node', 'kill-all'],
    ['pkill -f tsx', 'kill-all'],
    [':(){ :|:& };:', 'fork-bomb'],
    ['git push --force origin main', 'git-force-push'],
    ['git push -f origin master', 'git-force-push'],
    ['git push origin +main', 'git-force-push'],
    ['git push --force-with-lease origin HEAD:main', 'git-force-push'],
    ['bash -c "rm -rf /"', 'rm-critical'],
    ["zsh -lc 'sudo ls'", 'sudo'],
    ['eval sudo ls', 'sudo'],
    ['ls $(sudo whoami)', 'sudo'],
  ])('%s', (line, rule) => {
    expect(ruleOf(line)).toBe(rule);
  });
});

describe('checkCommand — allows everyday commands', () => {
  it.each([
    'ls -la',
    'rm -rf node_modules',
    'rm -rf dist/ build/*',
    'rm -f ./tmp.txt',
    'chmod -R 755 ./scripts',
    'git push origin feat/terminal',
    'git push -u origin main',
    'git push --force origin feat/terminal',
    'gh auth refresh -s workflow',
    'kill -9 1234',
    'killall Finder',
    'echo "sudo is a word"',
    'pnpm dev',
    'dd if=/dev/zero of=./blob bs=1m count=1',
  ])('%s', (line) => {
    expect(blocked(line).blocked).toBe(false);
  });
});

describe('config', () => {
  it('disables built-in rules by id', () => {
    expect(ruleOf('git push -f origin main', { disable: ['git-force-push'] })).toBeNull();
  });
  it('adds custom regex rules and skips invalid ones', () => {
    const cfg = { rules: [{ id: 'prod', pattern: 'kubectl .*--context=prod', reason: 'no prod' }, { id: 'bad', pattern: '(' }] };
    expect(checkCommand('FOO=1 kubectl delete pod x --context=prod', cfg)).toEqual({ blocked: true, ruleId: 'prod', reason: 'no prod' });
    expect(ruleOf('kubectl get pods', cfg)).toBeNull();
  });
});
