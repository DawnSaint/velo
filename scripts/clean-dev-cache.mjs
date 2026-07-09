import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const targetDir = path.resolve(__dirname, '../src-tauri/target');
const debugDir = path.join(targetDir, 'debug');
const releaseDir = path.join(targetDir, 'release');

const incrementalDir = path.join(debugDir, 'incremental');
const x86Dir = path.join(targetDir, 'x86_64-pc-windows-msvc');

// --all: 连同整个 debug/ 一起清（会触发下次全量重编依赖）
// --cross: 额外清理交叉编译目标残留
const args = new Set(process.argv.slice(2));
const cleanAll = args.has('--all');
const cleanCross = args.has('--cross');

function rmrf(p) {
  if (fs.existsSync(p)) {
    const stat = fs.statSync(p);
    const sizeBytes = stat.isDirectory() ? getDirSize(p) : stat.size;
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`✓ 已删除 ${path.relative(targetDir, p)} (${formatSize(sizeBytes)})`);
    return sizeBytes;
  } else {
    console.log(`· 跳过 ${path.relative(targetDir, p)} (不存在)`);
    return 0;
  }
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function getDirSize(p) {
  let total = 0;
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, entry.name);
    if (entry.isDirectory()) {
      total += getDirSize(full);
    } else {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

// 安装包目录，永不动
const bundleDir = path.join(releaseDir, 'bundle');
if (fs.existsSync(bundleDir)) {
  const msis = fs.readdirSync(path.join(bundleDir, 'msi')).filter(f => f.endsWith('.msi'));
  console.log(`已保护 release/bundle/msi/ (${msis.length} 个安装包)\n`);
}

let totalCleaned = 0;

totalCleaned += rmrf(incrementalDir);
if (cleanAll) {
  for (const sub of ['build', 'deps', '.fingerprint', '_up_']) {
    totalCleaned += rmrf(path.join(debugDir, sub));
  }
  totalCleaned += rmrf(path.join(debugDir, 'app_lib.dll'));
  totalCleaned += rmrf(path.join(debugDir, 'app_lib.dll.exp'));
  totalCleaned += rmrf(path.join(debugDir, 'app_lib.dll.lib'));
  totalCleaned += rmrf(path.join(debugDir, 'app_lib.lib'));
  totalCleaned += rmrf(path.join(debugDir, 'app_lib.pdb'));
  totalCleaned += rmrf(path.join(debugDir, 'libapp_lib.d'));
  totalCleaned += rmrf(path.join(debugDir, 'libapp_lib.rlib'));
  totalCleaned += rmrf(path.join(debugDir, 'velo.exe'));
  totalCleaned += rmrf(path.join(debugDir, 'velo.pdb'));
  totalCleaned += rmrf(path.join(debugDir, 'app_lib.d'));
  totalCleaned += rmrf(path.join(debugDir, 'velo.d'));
}
if (cleanCross) {
  totalCleaned += rmrf(x86Dir);
}

console.log(`\n清理完成，共释放 ${formatSize(totalCleaned)} 缓存。`);
