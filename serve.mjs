// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * 零依赖静态服务器：把 dist/ 跑在 http://localhost:8080
 * 用途：生产版直接打开，不带 Vite 的 HMR/overlay。
 *   node serve.mjs [port]
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const port = Number(process.argv[2] ?? 8080)
const root = new URL('./dist/', import.meta.url).pathname.replace(/^\//, '')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
    let filePath = join(root, normalize(urlPath).replace(/^(\.\.[/\\])+/, ''))
    const info = await stat(filePath).catch(() => null)
    if (!info || info.isDirectory()) filePath = join(root, 'index.html')
    const body = await readFile(filePath)
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    res.end(body)
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`404 ${err?.message ?? ''}`)
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Chameleon Web GUI -> http://localhost:${port}`)
})
