import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const children: ChildProcess[] = [];

function run(label: string, command: string, args: string[], color: string): ChildProcess {
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const prefix = `\x1b[${color}m[${label}]\x1b[0m `;
  const forward = (chunk: Buffer): void => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) process.stdout.write(`${prefix}${line}\n`);
    }
  };
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) process.stdout.write(`${prefix}結束（code ${code}）\n`);
  });
  children.push(child);
  return child;
}

const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
  console.error('找不到 vite，請先 npm install');
  process.exit(1);
}

run('api', process.execPath, ['--watch', 'server/index.ts'], '36');
run('web', process.execPath, [viteBin], '35');

const shutdown = (): void => {
  for (const child of children) child.kill();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
