// Packages a built checkout into out/webswitch-<version>-linux.tar.gz: dist/, the launcher, the
// desktop entry and the license. `npm run make` builds first.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = `webswitch-${version}`;
const stage = path.join(root, 'out', name);

rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(stage, 'bin'), { recursive: true });
cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
for (const file of ['LICENSE', 'README.md']) cpSync(path.join(root, file), path.join(stage, file));
cpSync(path.join(root, 'data'), path.join(stage, 'data'), { recursive: true });
cpSync(path.join(root, 'bin/webswitch'), path.join(stage, 'bin/webswitch'));
cpSync(path.join(root, 'scripts/install.sh'), path.join(stage, 'install.sh'));
writeFileSync(
  path.join(stage, 'RUNNING.md'),
  'Needs GJS, GTK 4 and WebKitGTK 6 (openSUSE: gjs typelib-1_0-WebKit-6_0 typelib-1_0-Gtk-4_0).\n' +
    'Run ./bin/webswitch, or ./install.sh to add it to your applications menu.\n',
);

const archive = `${name}-linux.tar.gz`;
execFileSync('tar', ['-czf', archive, name], { cwd: path.join(root, 'out'), stdio: 'inherit' });
console.log(`out/${archive}`);
