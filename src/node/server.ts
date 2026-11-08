import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare } from '../core/compare.ts';
import { parseManifest } from '../core/manifest.ts';
import type { Report } from '../core/types.ts';
import { defaultLocale, isLocale } from '../i18n/index.ts';
import { maxJsonBytes, maxPdfBytes } from './limits.ts';
import { appRoot } from './paths.ts';
import { analyzePdf } from './pdf.ts';
import { reportHtml } from './report.ts';
import { capture, printSource, sha256, validateOptions } from './source.ts';

export interface ServerOptions {
  port?: number;
  dev?: boolean;
  desktop?: { instanceId: string; quit: () => void };
}
export async function startServer(options: ServerOptions = {}) {
  let port = options.port ?? 4173;
  const dev = options.dev ?? false;
  const vite = dev
    ? await (await import('vite')).createServer({
        server: { middlewareMode: true },
        appType: 'spa',
      })
    : undefined;
  // Bounded, volatile storage. Documents disappear when the process exits.
  const results = new Map<string, { report: Report; images: string[]; pdf: Buffer }>();
  let busy = false;
  const server = createServer(async (req, res) => {
    const host = req.headers.host;
    if (!host || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) {
      res.writeHead(403).end('Invalid host');
      return;
    }
    if (
      req.headers.origin &&
      ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)
    ) {
      res.writeHead(403).end('Invalid origin');
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'GET' && url.pathname === '/api/runtime') {
          json({ desktop: !!options.desktop, instanceId: options.desktop?.instanceId });
          return;
        }
        if (req.method === 'GET' && url.pathname.startsWith('/api/results/')) {
          const [, , , id, asset] = url.pathname.split('/');
          const result = results.get(id);
          if (!result) {
            json({ error: 'Report expired or server restarted. Run the check again.' }, 404);
            return;
          }
          if (asset === 'report.html') {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Disposition': 'attachment; filename="printwitness-report.html"',
            });
            const language = url.searchParams.get('lang');
            res.end(
              reportHtml(
                result.report,
                result.images,
                isLocale(language) ? language : defaultLocale,
              ),
            );
            return;
          }
          if (asset === 'report.json') {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Content-Disposition': 'attachment; filename="printwitness-report.json"',
            });
            res.end(JSON.stringify(result.report, null, 2));
            return;
          }
          if (asset === 'document.pdf') {
            res.writeHead(200, {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'attachment; filename="document.pdf"',
            });
            res.end(result.pdf);
            return;
          }
          if (asset?.match(/^page-\d+\.png$/)) {
            const image = result.images[Number(asset.slice(5, -4)) - 1];
            if (!image) {
              res.writeHead(404).end();
              return;
            }
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(Buffer.from(image.split(',')[1], 'base64'));
            return;
          }
          json({ error: 'Unknown report asset' }, 404);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/demo') {
          json({
            source: resolve(appRoot, 'fixtures/validation.html'),
            selectors: ['#summary', '#register', '#terms'],
          });
          return;
        }
        if (
          req.method !== 'POST' ||
          req.headers['x-printwitness'] !== '1' ||
          !req.headers['content-type']?.startsWith('application/json')
        ) {
          json({ error: 'Expected same-origin JSON request' }, 403);
          return;
        }
        if (busy) {
          json({ error: 'Another operation is running. Wait for it to finish.' }, 409);
          return;
        }
        if (url.pathname === '/api/desktop/quit' && options.desktop) {
          json({ stopped: true });
          setImmediate(options.desktop.quit);
          return;
        }
        busy = true;
        try {
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > maxJsonBytes)
              throw new Error('Request exceeds 40 MiB. PDF limit is 25 MiB.');
            chunks.push(chunk);
          }
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
            string,
            unknown
          >;
          if (url.pathname === '/api/capture') {
            json(await capture(validateOptions(data)));
            return;
          }
          if (url.pathname === '/api/manifest') {
            json(parseManifest(data));
            return;
          }
          if (url.pathname !== '/api/print' && url.pathname !== '/api/check') {
            json({ error: 'Unknown operation' }, 404);
            return;
          }
          const manifest = parseManifest(data.manifest);
          let pdf: Buffer;
          let name: string;
          if (url.pathname === '/api/print') {
            const options = validateOptions(data.options);
            pdf = await printSource(options);
            name = 'Chromium export.pdf';
          } else {
            if (typeof data.pdf !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.pdf))
              throw new Error('Invalid base64 PDF');
            pdf = Buffer.from(data.pdf, 'base64');
            name = typeof data.name === 'string' ? data.name.slice(0, 500) : 'Imported PDF';
          }
          if (pdf.length > maxPdfBytes) throw new Error('PDF exceeds 25 MiB.');
          const { index, images } = await analyzePdf(pdf);
          const report = compare(manifest, index, { name, sha256: sha256(pdf) });
          const id = randomUUID();
          while (results.size >= 3) {
            const oldest = results.keys().next().value;
            if (oldest === undefined) break;
            results.delete(oldest);
          }
          results.set(id, { report, images, pdf });
          json({ id, report });
        } finally {
          busy = false;
        }
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      if (vite) {
        vite.middlewares(req, res);
        return;
      }
      const root = await realpath(resolve(appRoot, 'dist'));
      const candidate = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      let file = candidate.startsWith(root + sep) ? candidate : resolve(root, 'index.html');
      if (!extname(file)) file = resolve(root, 'index.html');
      const canonical = await realpath(file);
      if (!canonical.startsWith(root + sep)) {
        res.writeHead(403).end();
        return;
      }
      const mime: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
      };
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
      res.end(await readFile(canonical));
    } catch (error) {
      if (!res.headersSent)
        json({ error: error instanceof Error ? error.message : 'Operation failed' }, 400);
      else res.end();
    }
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string')
        return reject(new Error('Missing server address'));
      port = address.port;
      done();
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    async close() {
      results.clear();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      await vite?.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await startServer({
    port: Number(process.env.PORT ?? 4173),
    dev: process.argv.includes('--dev'),
  });
  console.log(`PrintWitness v0.1 · ${server.url}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      void server.close().finally(() => process.exit(0));
    });
}
