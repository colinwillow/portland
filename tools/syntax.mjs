// Does every file still PARSE? That is all this asks, and it is the only thing
// that runs without being asked for.
//
// The loop here is: a change is made, it is pushed, and he looks at it on a
// phone. Nothing in this repo should get between those -- a wrong guess costs
// him one look, and a verification pass costs him a round trip he was going to
// spend looking anyway. So the harnesses stay and they stay UNRUN.
//
// This one earns its second because a file that will not parse is a BLANK PAGE:
// the module never evaluates, `#boot` sits for ever on the text it was born
// with, and nothing on screen or in a phone's console says why. That is not a
// wrong guess he can look at and correct, it is a round trip with nothing in it.
//
//   node tools/syntax.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const files = [];
for (const dir of ['game', 'tools', 'tests']) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir))
    if (/\.m?js$/.test(f)) files.push(path.join(dir, f));
}
// `node --check` reads the module type out of package.json, which says
// "type": "module" -- so a bare `.js` full of `import` is parsed as one.
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.log(`FAIL ${f}\n${(r.stderr || '').split('\n').slice(0, 6).join('\n')}`); }
}
console.log(bad ? `${bad} of ${files.length} will not parse` : `${files.length} files parse`);
process.exit(bad ? 1 : 0);
