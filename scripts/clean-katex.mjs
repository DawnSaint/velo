import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM 中没有全局的 __dirname 和 __filename，需要手动获取
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distDir = path.resolve(__dirname, '../dist'); 
const assetsDir = path.join(distDir, 'assets');

// 1. 清理 CSS 中的冗余字体引用
const cssFiles = fs.readdirSync(assetsDir).filter(f => f.endsWith('.css'));
cssFiles.forEach(file => {
  const filePath = path.join(assetsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  
  // 匹配并删除非 woff2 的字体引用
  // 例如: , url(fonts/xxx.woff) format('woff')
  const regex = /,\s*url\([^)]+\)\s*format\('(woff|truetype|embedded-opentype)'\)/g;
  const newContent = content.replace(regex, '');
  
  if (content !== newContent) {
    fs.writeFileSync(filePath, newContent, 'utf8');
    console.log(`已清理 CSS 冗余字体引用: ${file}`);
  }
});

// 2. 删除物理字体文件 (只保留 .woff2)
// 注意：Vite 可能会把字体放在 assets/fonts 或者直接放在 assets 下，请根据实际情况调整
const fontDirs = [
  path.join(assetsDir, 'fonts'),
  assetsDir 
];

fontDirs.forEach(dir => {
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    let deletedCount = 0;
    
    files.forEach(file => {
      // 删除 woff, ttf, eot，只保留 woff2
      if (file.match(/\.(woff|ttf|eot)$/i)) {
        fs.unlinkSync(path.join(dir, file));
        deletedCount++;
      }
    });
    
    if (deletedCount > 0) {
      console.log(`KaTeX 资源优化：删除 ${deletedCount} 个冗余字体文件`);
    }
  }
});