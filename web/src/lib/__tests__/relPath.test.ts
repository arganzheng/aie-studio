import { describe, expect, it } from 'vitest';
import { makeRelPath } from '../relPath';

describe('makeRelPath', () => {
  const rel = makeRelPath('/Users/me/Code/aie-studio');

  it('is the identity without a project path', () => {
    expect(makeRelPath(undefined)('/a/b')).toBe('/a/b');
    expect(makeRelPath('')('/a/b')).toBe('/a/b');
    expect(makeRelPath('/')('/a/b')).toBe('/a/b');
  });

  it('strips the root from paths inside the project', () => {
    expect(rel('/Users/me/Code/aie-studio/web/src/a.ts')).toBe('web/src/a.ts');
    expect(makeRelPath('/Users/me/Code/aie-studio/')('/Users/me/Code/aie-studio/a.ts')).toBe('a.ts');
  });

  it('renders the root itself as .', () => {
    expect(rel('/Users/me/Code/aie-studio')).toBe('.');
    expect(rel('cd /Users/me/Code/aie-studio && ls')).toBe('cd . && ls');
    expect(rel('ls /Users/me/Code/aie-studio/')).toBe('ls ./');
    expect(rel('ls /Users/me/Code/aie-studio/*.md')).toBe('ls ./*.md');
  });

  it('leaves sibling directories that share the root as a prefix alone', () => {
    expect(rel('/Users/me/Code/aie-studio-plan-strip/web/a.ts')).toBe('/Users/me/Code/aie-studio-plan-strip/web/a.ts');
    expect(rel('cd /Users/me/Code/aie-studio-fix && ls')).toBe('cd /Users/me/Code/aie-studio-fix && ls');
    expect(rel('/Users/me/Code/aie-studio.bak/a')).toBe('/Users/me/Code/aie-studio.bak/a');
  });

  it('does not cut the root out of the middle of another path', () => {
    expect(rel('/backup/Users/me/Code/aie-studio/a.ts')).toBe('/backup/Users/me/Code/aie-studio/a.ts');
  });

  it('replaces every occurrence in commands, prose and JSON', () => {
    expect(rel('git -C /Users/me/Code/aie-studio diff /Users/me/Code/aie-studio/a.ts')).toBe('git -C . diff a.ts');
    expect(rel('{"file_path":"/Users/me/Code/aie-studio/a.ts"}')).toBe('{"file_path":"a.ts"}');
    expect(rel('见 /Users/me/Code/aie-studio/a.ts。')).toBe('见 a.ts。');
    expect(rel("'/Users/me/Code/aie-studio/a b.ts'")).toBe("'a b.ts'");
  });

  it('matches the macOS /private form of /tmp and /var roots', () => {
    const tmp = makeRelPath('/tmp/proj');
    expect(tmp('/private/tmp/proj/sample.png')).toBe('sample.png');
    expect(tmp('/tmp/proj/sample.png')).toBe('sample.png');
    expect(tmp('/private/tmp/proj-2/sample.png')).toBe('/private/tmp/proj-2/sample.png');
    const priv = makeRelPath('/private/var/folders/x');
    expect(priv('/var/folders/x/a')).toBe('a');
    expect(priv('/private/var/folders/x/a')).toBe('a');
    expect(makeRelPath('/Users/me/tmp/p')('/private/Users/me/tmp/p/a')).toBe('/private/Users/me/tmp/p/a');
  });

  it('treats regex characters in the root literally', () => {
    const r = makeRelPath('/Users/me/a+b (1)');
    expect(r('/Users/me/a+b (1)/x.ts')).toBe('x.ts');
    expect(r('/Users/me/aab (1)/x.ts')).toBe('/Users/me/aab (1)/x.ts');
  });
});
