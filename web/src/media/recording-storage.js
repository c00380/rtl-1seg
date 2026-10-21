// Delete only this recording's files; earlier downloads may still be using theirs.
export async function createRecordingStorage({
  storage: fileSystem = globalThis.navigator?.storage,
} = {}) {
  const root = await fileSystem.getDirectory();
  const directory = await root.getDirectoryHandle('1seg-recordings', { create: true });
  const name = crypto.randomUUID();
  const files = new Map();
  let writable;
  const storage = {
    async output(extension) {
      const filename = `${name}.${extension}`;
      const handle = await directory.getFileHandle(filename, { create: true });
      files.set(filename, handle);
      return handle;
    },
    write(bytes) {
      return writable.write(bytes);
    },
    async file() {
      if (writable) {
        await writable.close();
        writable = null;
      }
      const file = await ts.getFile();
      return file.slice(0, file.size, 'video/mp2t');
    },
    async dispose() {
      await writable?.abort().catch(() => {});
      writable = null;
      await Promise.all([...files.keys()].map((filename) => directory.removeEntry(filename)));
      files.clear();
    },
  };
  let ts;
  try {
    ts = await storage.output('ts');
    writable = await ts.createWritable();
    return storage;
  } catch (error) {
    await storage.dispose().catch(() => {});
    throw error;
  }
}
