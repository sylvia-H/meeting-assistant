/**
 * 打包成單一執行檔（Node 內建 SEA）：npm run package → release/meeting-assistant.exe
 *
 * 1. 建置前端（tsc + vite build → dist/）
 * 2. 用 rolldown 把伺服器打成一個 CommonJS 檔（SEA 只吃單一檔案，不能 import node_modules）
 * 3. 把 dist/ 每個檔當成 SEA asset 塞進去，伺服器用 node:sea 的 getAsset 讀
 * 4. node --build-sea 產生 exe（內含目前這份 Node，同事不用另外裝）
 *
 * 產生 exe 的這台要 Node 25.5 以上（--build-sea）；用哪個 Node 打包，exe 裡就是哪個 Node。
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'rolldown';

const root = path.resolve(import.meta.dirname, '..');
const work = path.join(root, 'build', 'sea');
const release = path.join(root, 'release');
const exeName = process.platform === 'win32' ? 'meeting-assistant.exe' : 'meeting-assistant';
const pkg = (await import('../package.json', { with: { type: 'json' } })).default as { version: string };

function step(label: string): void {
  console.log(`\n▸ ${label}`);
}

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 25 || (major === 25 && minor < 5)) {
  console.error(`需要 Node 25.5 以上才能 --build-sea，目前是 ${process.version}`);
  process.exit(1);
}

step('建置前端');
execSync('npm run build', { cwd: root, stdio: 'inherit' });

step('打包伺服器');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(release, { recursive: true });
const serverBundle = path.join(work, 'server.cjs');
await build({
  input: path.join(root, 'server', 'index.ts'),
  platform: 'node',
  // ws 的選用原生加速套件：沒裝時 ws 會自己退回純 JS
  external: ['bufferutil', 'utf-8-validate'],
  // SEA 裡 projectRoot 改看 exe 位置，用不到 import.meta.dirname；給個值避免打包後是 undefined
  transform: { define: { 'import.meta.dirname': '__dirname' } },
  output: { file: serverBundle, format: 'cjs', codeSplitting: false },
  logLevel: 'warn',
});

step('收集前端檔案');
const dist = path.join(root, 'dist');
const assets: Record<string, string> = {};
function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else assets[`dist/${path.relative(dist, full).split(path.sep).join('/')}`] = full;
  }
}
walk(dist);
console.log(`  ${Object.keys(assets).length} 個檔案`);

step('產生執行檔');
const output = path.join(release, exeName);
try {
  rmSync(output, { force: true });
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    // Windows 不讓覆蓋執行中的 exe；不擋的話會留著舊版，看起來像改了沒效
    console.error(`\n${output} 還在執行，蓋不掉。請先關掉會議助手的黑色視窗，再跑一次 npm run package。`);
    process.exit(1);
  }
  throw err;
}
const config = path.join(work, 'sea-config.json');
writeFileSync(
  config,
  JSON.stringify(
    {
      main: serverBundle,
      output,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
      assets,
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--build-sea', config], { cwd: root, stdio: 'inherit' });

const size = (statSync(output).size / 1024 / 1024).toFixed(1);
console.log(`\n完成：${output}（${size} MB，v${pkg.version}，內含 Node ${process.version}）`);
