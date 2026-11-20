import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('No inline game scripts found');

for (const [, script] of scripts) {
    execFileSync(process.execPath, ['--check'], { input: script, stdio: ['pipe', 'inherit', 'inherit'] });
}
for (const script of ['tests/touch-loop.mjs', 'tests/game.test.mjs', 'tests/touch.e2e.mjs']) {
    execFileSync(process.execPath, ['--check', script], { cwd: root, stdio: 'inherit' });
}
execFileSync('git', ['diff', '--check', 'HEAD'], { cwd: root, stdio: 'inherit' });
