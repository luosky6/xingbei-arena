// bridge/server.mjs
// 极简静态服务器：把只读引擎 clone 作为站点根目录提供给无头浏览器。
// 不修改 clone，只读取。默认端口 8099。
import http from 'node:http';
import { readFile, writeFile, mkdir, stat, rm, readdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEngineRoot, isWithinRoot, arenaRoot } from './engine.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
export const ROOT = resolveEngineRoot();
export const PORT = Number(process.env.XB_PORT || 8099);
// 浏览器端引擎会通过 index.html 暴露的文件 API 读写配置和扩展。
// 引擎源码保持只读；所有写入落到 arena/runtime/browser-files 沙箱。
export const BROWSER_FILES = join(__dirname, '..', 'runtime', 'browser-files');
export const ARENA_FILES = normalize(arenaRoot);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.map': 'application/json'
};

export function startServer({ root = resolveEngineRoot(), port = PORT } = {}) {
  const servingRoot = normalize(root);
  const writeRoot = normalize(BROWSER_FILES);

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp' });
    res.end(JSON.stringify(body));
  };
  const relative = value => {
    const raw = String(value || '').replace(/^[/\\]+/, '').replace(/^\.([/\\])/, '');
    const normalized = normalize(raw);
    if (!raw || normalized.startsWith('..') || normalized.includes(`..${'\\'}`) || normalized.includes(`..${'/'}`)) return null;
    return normalized;
  };
  const targetForRead = async rel => {
    const writable = join(writeRoot, rel);
    if (isWithinRoot(writeRoot, writable) && await stat(writable).catch(() => null)) return writable;
    const source = join(servingRoot, rel);
    return isWithinRoot(servingRoot, source) ? source : null;
  };
  const collectBody = req => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      let urlPath = decodeURIComponent(parsed.pathname);

      // 与原版 index.html 的 initReadWriteFunction 对齐的最小文件 API。
      // 这些接口仅允许访问引擎根目录或 browser-files 写入沙箱，禁止路径穿越。
      if (urlPath === '/checkFile' || urlPath === '/checkDir' || urlPath === '/readFile' || urlPath === '/readFileAsText' ||
          urlPath === '/getFileList' || urlPath === '/removeFile' || urlPath === '/removeDir') {
        const key = urlPath === '/checkDir' || urlPath === '/getFileList' || urlPath === '/removeDir' ? 'dir' : 'fileName';
        const rel = relative(parsed.searchParams.get(key));
        if (!rel) return json(res, 400, { success: false, code: 400, errorMsg: '非法路径' });
        const readPath = await targetForRead(rel);
        const st = readPath && await stat(readPath).catch(() => null);
        if (urlPath === '/checkFile' || urlPath === '/checkDir') {
          const wantDir = urlPath === '/checkDir';
          if (!st) return json(res, 404, { success: false, code: 404, errorMsg: wantDir ? '文件夹不存在或无法访问' : '文件不存在或无法访问' });
          if (wantDir !== st.isDirectory()) return json(res, 404, { success: false, code: 404, errorMsg: wantDir ? '不是一个文件夹' : '不是一个文件' });
          return json(res, 200, { success: true });
        }
        if (urlPath === '/getFileList') {
          if (!st || !st.isDirectory()) return json(res, 404, { success: false, code: 404, errorMsg: '文件夹不存在或无法访问' });
          const entries = await readdir(readPath, { withFileTypes: true });
          return json(res, 200, { success: true, data: {
            folders: entries.filter(e => e.isDirectory()).map(e => e.name),
            files: entries.filter(e => e.isFile()).map(e => e.name),
          }});
        }
        if (urlPath === '/removeFile' || urlPath === '/removeDir') {
          const writable = join(writeRoot, rel);
          if (!isWithinRoot(writeRoot, writable)) return json(res, 403, { success: false, code: 403, errorMsg: '禁止写入引擎目录' });
          await rm(writable, { recursive: urlPath === '/removeDir', force: true });
          return json(res, 200, { success: true });
        }
        if (!st || st.isDirectory()) return json(res, 404, { success: false, code: 404, errorMsg: '文件不存在或无法访问' });
        const data = await readFile(readPath);
        if (urlPath === '/readFileAsText') return json(res, 200, { success: true, data: data.toString('utf8') });
        return json(res, 200, { success: true, data: Array.from(data) });
      }

      if (urlPath === '/createDir') {
        const rel = relative(parsed.searchParams.get('dir'));
        if (!rel) return json(res, 400, { success: false, code: 400, errorMsg: '非法路径' });
        const target = join(writeRoot, rel);
        if (!isWithinRoot(writeRoot, target)) return json(res, 403, { success: false, code: 403, errorMsg: '禁止写入引擎目录' });
        await mkdir(target, { recursive: true });
        return json(res, 200, { success: true });
      }

      if (urlPath === '/writeFile' && req.method === 'POST') {
        let payload;
        try { payload = JSON.parse(await collectBody(req)); } catch { return json(res, 400, { success: false, code: 400, errorMsg: '请求体不是 JSON' }); }
        const rel = relative(payload?.path);
        if (!rel) return json(res, 400, { success: false, code: 400, errorMsg: '非法路径' });
        const target = join(writeRoot, rel);
        if (!isWithinRoot(writeRoot, target)) return json(res, 403, { success: false, code: 403, errorMsg: '禁止写入引擎目录' });
        await mkdir(join(target, '..'), { recursive: true });
        const value = typeof payload.data === 'string' ? Buffer.from(payload.data) : Buffer.from(payload.data || []);
        await writeFile(target, value);
        return json(res, 200, { success: true });
      }

      // 只读暴露竞技场自身的浏览器端模块，供 overlay/调试注入使用。
      // 该前缀不允许访问 runtime、引擎或任意父目录。
      if (urlPath.startsWith('/__arena/')) {
        const rel = relative(urlPath.slice('/__arena/'.length));
        const arenaPath = rel && normalize(join(ARENA_FILES, rel));
        if (!arenaPath || !isWithinRoot(ARENA_FILES, arenaPath)) { res.writeHead(403); return res.end('forbidden'); }
        const s = await stat(arenaPath).catch(() => null);
        if (!s || s.isDirectory()) { res.writeHead(404); return res.end('not found'); }
        const data = await readFile(arenaPath);
        res.writeHead(200, { 'Content-Type': MIME[extname(arenaPath)] || 'application/octet-stream',
          'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
        return res.end(data);
      }

      if (urlPath === '/') urlPath = '/index.html';
      const filePath = normalize(join(servingRoot, urlPath));
      if (!isWithinRoot(servingRoot, filePath)) { res.writeHead(403); return res.end('forbidden'); }
      const s = await stat(filePath).catch(() => null);
      if (!s || s.isDirectory()) { res.writeHead(404); return res.end('not found'); }
      const data = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
        // 引擎大量用到 SharedArrayBuffer/模块, 放开跨源隔离以防部分功能受限
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
      res.end(data);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return mkdir(writeRoot, { recursive: true }).then(() => new Promise(resolve => server.listen(port, () => {
    console.log(`[server] serving ${servingRoot} at http://localhost:${port}`);
    console.log(`[server] browser file sandbox ${writeRoot}`);
    resolve(server);
  })));
}

if (import.meta.url === `file://${process.argv[1]}`) startServer();
