import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

/** Replace only after a complete flushed write; a failed save keeps the old file. */
export async function writeProjectFile(filePath: string, content: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const destination = path.resolve(filePath);
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.promises.open(temporary, 'wx');
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await fs.promises.rename(temporary, destination);
    return { ok: true, path: destination };
  } catch (err) {
    return { ok: false, error: `Could not save ${destination}: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await fs.promises.unlink(temporary).catch(() => {});
  }
}
