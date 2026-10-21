import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export async function buildReedSolomon() {
  const { runClang } = await import('@yowasp/clang');
  const source = JSON.parse(await readFile(new URL('ezpwd/SOURCE.json', import.meta.url), 'utf8'));
  const files = { ezpwd: {} };
  for (const name of ['rs', 'rs_base']) {
    const bytes = await readFile(new URL(`ezpwd/ezpwd/${name}`, import.meta.url));
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256[name])
      throw new Error(`EZPWD source changed: ${name}`);
    files.ezpwd[name] = bytes.toString('utf8');
  }
  // No console or process API is needed in a browser. Trap catastrophic codec
  // initialization failures rather than linking stdio/abort and a WASI runtime.
  const fatal = /#  define EZPWD_RAISE_OR_ABORT\(  typ, str \)[\s\S]*?\} while \( false \)/;
  if (!fatal.test(files.ezpwd.rs_base)) throw new Error('Review EZPWD fatal-error hook');
  files.ezpwd.rs_base = files.ezpwd.rs_base.replace(
    fatal,
    '#  define EZPWD_RAISE_OR_ABORT( typ, str ) __builtin_trap()',
  );
  files['adapter.cpp'] = await readFile(new URL('ezpwd/adapter.cpp', import.meta.url), 'utf8');
  let result;
  try {
    result = await runClang(
      [
        'clang++',
        '-std=c++17',
        '-O3',
        '-flto',
        '-fno-exceptions',
        '-fno-rtti',
        '-fno-c++-static-destructors',
        '-nostdlib',
        '-Wl,--no-entry',
        '-Wl,--export=__wasm_call_ctors',
        '-Wl,-z,stack-size=16384',
        '-Wl,--initial-memory=65536',
        '-Wl,--max-memory=65536',
        '-Wl,--export=rs_work',
        '-Wl,--export=rs_encode',
        '-Wl,--export=rs_check',
        '-Wl,--export=rs_decode',
        'adapter.cpp',
        '-o',
        'ezpwd.wasm',
      ],
      files,
      { fetchProgress() {} },
    );
  } catch (error) {
    throw new Error(`EZPWD build failed (${error.code ?? error.message})`);
  }
  const binary = result['ezpwd.wasm'];
  const module = new WebAssembly.Module(binary);
  if (WebAssembly.Module.imports(module).length) throw new Error('EZPWD must be standalone');
  await build({
    stdin: {
      contents: `const module = new WebAssembly.Module(Uint8Array.from(atob('${Buffer.from(binary).toString('base64')}'), c => c.charCodeAt(0)));
export function createReedSolomon() { const api = new WebAssembly.Instance(module).exports; api.__wasm_call_ctors(); return api; }`,
    },
    format: 'esm',
    minify: true,
    outfile: fileURLToPath(new URL('../vendor/ezpwd.js', import.meta.url)),
    banner: {
      js: '// EZPWD (Hard Consulting / Phil Karn), GPL-3.0-or-later / LGPL; source and build-time fatal hook: ../build/ezpwd/',
    },
  });
  console.log(`Built ezpwd (${binary.length} WASM bytes)`);
}
