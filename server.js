import sirv from 'sirv';
// Local asset server. Reception and IQ generation run in the browser.
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const WEB_ROOT = fileURLToPath(new URL('./web/', import.meta.url));
export function createReceiverServer(root = WEB_ROOT) {
  const serve = sirv(root, { dev: true, etag: false });
  return createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const fail = (status) => {
      response.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end(request.method === 'HEAD' ? undefined : `${status}\n`);
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      fail(405);
      return;
    }
    // Receiver assets are served in full; sirv owns path and directory handling.
    delete request.headers.range;
    serve(request, response, () => fail(404));
  });
}

export async function startReceiver({ host = '127.0.0.1', port = 8000, root = WEB_ROOT } = {}) {
  for (const source of ['src/dsp/decoder.js', 'vendor/webrtlsdr.js']) {
    if (!(await stat(resolve(root, source))).isFile())
      throw new Error(`Required receiver file is missing: web/${source}`);
  }
  const server = createReceiverServer(root);
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      accept();
    });
  });
  return server;
}

async function main() {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '8000' },
    },
  });
  const server = await startReceiver({
    host: values.host,
    port: Number(values.port),
  });
  const hostname = ['127.0.0.1', '::1', '0.0.0.0', '::'].includes(values.host)
    ? 'localhost'
    : values.host.includes(':')
      ? `[${values.host}]`
      : values.host;
  const url = `http://${hostname}:${server.address().port}/`;
  console.log(`Open ${url}  (Ctrl+C stops the web server)`);
  const stop = () => {
    server.close();
    server.closeAllConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
