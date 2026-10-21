import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export async function buildViterbi() {
  const { runClang } = await import('@yowasp/clang');
  const files = {};
  for (const name of ['adapter.c', 'viterbi27_port.c', 'fec.h'])
    files[name] = await readFile(new URL(`libfec/${name}`, import.meta.url), 'utf8');
  let result;
  try {
    result = await runClang(
      [
        'clang',
        '-O3',
        '-nostdlib',
        '-Wl,--no-entry',
        '-Wl,-z,stack-size=4096',
        '-Wl,--export=__heap_base',
        'adapter.c',
        '-o',
        'viterbi.wasm',
      ],
      files,
      { fetchProgress() {} },
    );
  } catch (error) {
    throw new Error(`libfec build failed (${error.code ?? error.message})`);
  }
  const binary = result['viterbi.wasm'];
  const module = new WebAssembly.Module(binary);
  if (WebAssembly.Module.imports(module).length) throw new Error('libfec must be standalone');
  await build({
    stdin: {
      contents: `const module = new WebAssembly.Module(Uint8Array.from(atob('${Buffer.from(binary).toString('base64')}'), c => c.charCodeAt(0)));
export function createViterbi() { return new WebAssembly.Instance(module).exports; }`,
    },
    format: 'esm',
    minify: true,
    outfile: fileURLToPath(new URL('../vendor/viterbi.js', import.meta.url)),
    banner: {
      js: '// libfec (Phil Karn), LGPL-2.1; adapter GPL-3.0-or-later; source: ../build/libfec/',
    },
  });
  console.log(`Built viterbi (${binary.length} WASM bytes)`);
}
