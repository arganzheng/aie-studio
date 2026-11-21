// Strip the active project's absolute path prefix from strings for display,
// so a tool field showing `<projectRoot>/web/src/foo.ts` renders as
// `web/src/foo.ts` and the bare root renders as `.`. The root is supplied at
// call time (per project), not baked in — callers pass `activeProject.path`.
// Returns an identity function when no path is known. Replaces every
// occurrence inside the string, which covers Bash commands, tool outputs and
// serialized JSON blobs that mention the root.
//
// Only whole path occurrences are replaced: the root must not be preceded by
// a path character (so `/private/tmp/p` is not cut out of the middle) and must
// be followed by `/` or something that cannot continue a path segment (so the
// root `/x/aie-studio` leaves the sibling worktree `/x/aie-studio-fix` alone).
//
// On macOS /tmp, /var and /etc are symlinks into /private, and tools report
// the resolved path; a root on either side of that link matches both forms.

const PATH_CHAR = String.raw`[\w.~/-]`;
const SEGMENT_CHAR = String.raw`[\w.-]`;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rootAliases(root: string): string[] {
  const m = /^\/private(\/(?:tmp|var|etc)(?:\/.*)?)$/.exec(root);
  if (m) return [root, m[1]];
  if (/^\/(?:tmp|var|etc)(?:\/|$)/.test(root)) return [root, '/private' + root];
  return [root];
}

export function makeRelPath(projectPath: string | undefined | null): (s: string) => string {
  if (!projectPath) return (s) => s;
  const root = projectPath.replace(/\/+$/, '');
  if (!root) return (s) => s;
  const alts = rootAliases(root)
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|');
  // Group 1: root followed by `/` and more path → drop `root/`.
  // Otherwise: the root itself, at a segment boundary → `.`.
  const re = new RegExp(
    `(?<!${PATH_CHAR})(?:(?:${alts})(\\/)(?=${SEGMENT_CHAR})|(?:${alts})(?!${SEGMENT_CHAR}))`,
    'g',
  );
  return (s) => {
    if (typeof s !== 'string' || s.length === 0) return s;
    return s.replace(re, (_m, slash: string | undefined) => (slash ? '' : '.'));
  };
}
