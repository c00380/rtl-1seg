import { readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildAssetLicenses } from './assets.js';

const web = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(web, 'licenses');
const packages = new Map();
const headers = new Set();
const embedded = new Set();
const aliases = {
  '@jtarrio/signals': 'signals',
  '@jtarrio/webrtlsdr': 'webrtlsdr',
  '@nodable/entities': 'nodable-entities',
};

export async function collectLicenses(result, scope = 'browser') {
  const inputs = new Set(
    Object.values(result.metafile.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, input]) => input.bytesInOutput > 0)
        .map(([path]) => path),
    ),
  );
  for (const input of inputs) {
    if (!input.includes('node_modules/')) continue;
    const filename = resolve(web, input);
    let root = dirname(filename),
      manifest;
    while (root !== dirname(root)) {
      try {
        manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        root = dirname(root);
      }
    }
    if (!manifest?.name) throw new Error(`Package owner not found: ${input}`);
    packages.set(`${manifest.name}@${manifest.version}`, { root, manifest, scope });
    // This CJS entry is already bundled upstream. Its dependencies are invisible
    // to esbuild's input graph; the accompanying source map identifies them.
    if (
      manifest.name === 'fast-xml-parser' &&
      filename.endsWith('fxp.cjs') &&
      !embedded.has(root)
    ) {
      embedded.add(root);
      const map = JSON.parse(await readFile(join(root, 'lib/fxp.min.js.map'), 'utf8'));
      const names = new Set(
        map.sources
          .map((source) => source.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1])
          .filter(Boolean),
      );
      for (const name of names) {
        let parent = root,
          dependency;
        while (parent !== dirname(parent)) {
          const packageRoot = join(parent, 'node_modules', name);
          try {
            dependency = {
              root: packageRoot,
              manifest: JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')),
              scope,
              embeddedIn: `${manifest.name}@${manifest.version}`,
            };
            break;
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          parent = dirname(parent);
        }
        if (!dependency) throw new Error(`Embedded package license not found: ${name}`);
        packages.set(`${name}@${dependency.manifest.version}`, dependency);
      }
    }
    const text = await readFile(filename, 'utf8');
    const header = text.match(/^(?:(?:\s*\/\/[^\n]*\n)|(?:\s*\/\*[\s\S]*?\*\/))+/)?.[0];
    if (header && /copyright/i.test(header)) headers.add(`${manifest.name}\n${header.trim()}`);
  }
}

export async function buildLicenses() {
  await mkdir(directory, { recursive: true });
  const { downloads: sources, sourceNotices } = JSON.parse(
    await readFile(new URL('licenses.json', import.meta.url), 'utf8'),
  );
  const inventory = [];
  for (const { root, manifest, scope, embeddedIn } of [...packages.values()].sort((a, b) =>
    a.manifest.name.localeCompare(b.manifest.name, 'en'),
  )) {
    const details = {
      name: manifest.name,
      version: embeddedIn ? null : manifest.version,
      ...(embeddedIn ? { embeddedIn, licensePackageVersion: manifest.version } : {}),
      license: manifest.license,
      scope,
    };
    const files = (await readdir(root))
      .filter((name) => /^(?:licen[cs]e|copying|notice|copyright)(?:$|[.-])/i.test(name))
      .sort(
        (a, b) =>
          Number(!/^licen[cs]e(?:$|[.-])/i.test(a)) - Number(!/^licen[cs]e(?:$|[.-])/i.test(b)) ||
          a.localeCompare(b, 'en'),
      );
    if (!files.length) {
      const source = sources.find(
        (item) => item.package === manifest.name && item.version === manifest.version,
      );
      if (!source) throw new Error(`License text missing in ${manifest.name}@${manifest.version}`);
      inventory.push({ ...details, files: [source.name] });
      continue;
    }
    const name =
      aliases[manifest.name] ??
      manifest.name
        .replace(/^@floating-ui\//, 'floating-ui-')
        .replace(/^@/, '')
        .replaceAll('/', '-');
    const base = manifest.name.startsWith('@zag-js/')
      ? `zag-js/${manifest.name.slice('@zag-js/'.length)}`
      : scope === 'server'
        ? `server/${name}`
        : name;
    const licenses = [];
    for (const [index, filename] of files.entries()) {
      const target = `${base}-${index === 0 ? 'LICENSE' : filename}`;
      await mkdir(dirname(join(directory, target)), { recursive: true });
      await copyFile(join(root, filename), join(directory, target));
      licenses.push(target);
    }
    inventory.push({ ...details, files: licenses });
  }
  for (const source of sources) {
    const destination = join(directory, source.name);
    let bytes;
    try {
      bytes = await readFile(destination);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const hash = (value) => createHash('sha256').update(value).digest('hex');
    if (!bytes || hash(bytes) !== source.sha256) {
      const response = await fetch(source.url);
      if (!response.ok)
        throw new Error(`License download failed: ${response.status} ${source.url}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      if (hash(bytes) !== source.sha256) throw new Error(`License source changed: ${source.name}`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
  }
  await buildAssetLicenses();
  await writeFile(
    join(directory, 'COPYRIGHT-NOTICES.txt'),
    [...sourceNotices, ...[...headers].sort()].join('\n\n') + '\n',
  );
  const expected = new Set([
    ...inventory.flatMap((item) => item.files),
    ...sources.map((item) => item.name),
    'COPYRIGHT-NOTICES.txt',
    'INDEX.json',
    'mediabunny/adts-reader.js',
    'mediabunny/codec-data.js',
    'mediabunny/conversion.js',
    'mediabunny/mpeg-ts-demuxer.js',
    'zag-js/tooltip-machine.mjs',
    'zag-js/vanilla-machine.mjs',
  ]);
  async function list(root) {
    const found = [];
    for (const item of await readdir(root, { withFileTypes: true })) {
      const path = join(root, item.name);
      if (item.isDirectory()) found.push(...(await list(path)));
      else found.push(relative(directory, path).replaceAll('\\', '/'));
    }
    return found;
  }
  const extraFiles = (await list(directory)).filter((name) => !expected.has(name));
  await writeFile(
    join(directory, 'INDEX.json'),
    JSON.stringify({ packages: inventory, additionalSources: sources, extraFiles }, null, 2) + '\n',
  );
  console.log(
    `Collected licenses for ${inventory.length} bundled/server packages; ${extraFiles.length} extra files retained.`,
  );
}
