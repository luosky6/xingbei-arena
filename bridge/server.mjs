// bridge/server.mjs
// 极简静态服务器：把只读引擎 clone 作为站点根目录提供给无头浏览器。
// 不修改 clone，只读取。默认端口 8099。
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
export const ROOT = normalize(join(__dirname, '..', '..', 'noname_xingbei_clone'));
export const PORT = Number(process.env.XB_PORT || 8099);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.map': 'application/json'
};

export function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = normalize(join(ROOT, urlPath));
      if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
      const s = await stat(filePath).catch(() => null);
      if (!s || s.isDirectory()) { res.writeHead(404); return res.end('not found'); }
      const data = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
        // 引擎大量用到 SharedArrayBuffer/模块, 放开跨源隔离以防部分功能受限
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
      res.end(data);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return new Promise(resolve => server.listen(PORT, () => {
    console.log(`[server] serving ${ROOT} at http://localhost:${PORT}`);
    resolve(server);
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) startServer();
