import { describe, expect, it } from 'vitest';
import { appendScrollback, terminalAllowed, ZSH_FILES } from '../terminal.js';

describe('appendScrollback', () => {
  it('keeps the newest output within the limit, cutting at a newline', () => {
    expect(appendScrollback('abc', 'def', 10)).toBe('abcdef');
    expect(appendScrollback('line1\nline2\n', 'line3\n', 10)).toBe('line3\n');
  });
});

describe('terminalAllowed', () => {
  it('only with the setting on, and never with AIE_TERMINAL=off', () => {
    expect(terminalAllowed({}, {})).toBe(false);
    expect(terminalAllowed({ terminal: false }, {})).toBe(false);
    expect(terminalAllowed({ terminal: true }, {})).toBe(true);
    expect(terminalAllowed({ terminal: true }, { AIE_TERMINAL: 'off' })).toBe(false);
  });
});

describe('zsh startup files', () => {
  it('source the user\'s own files and install the guard last', () => {
    for (const f of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) expect(ZSH_FILES[f]).toContain(`source $ZDOTDIR/${f}`);
    expect(ZSH_FILES['.zlogin']).toContain('source $_aie_zdotdir/guard.zsh');
    expect(ZSH_FILES['guard.zsh']).toContain('zle -N $w _aie_guard_widget');
  });
});
