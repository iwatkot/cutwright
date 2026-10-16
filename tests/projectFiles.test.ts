import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeProjectFile } from '../electron/projectFiles';

describe('project disk writes', () => {
  it('replaces a previous project completely and keeps it on a failed save', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cutwright-save-test-'));
    try {
      const file = path.join(dir, 'Episode #1.cutwright.json');
      await writeFile(file, '{"old":true}');
      const content = JSON.stringify({ name: 'Кредиты', clips: Array.from({ length: 83 }, (_, id) => ({ id })) });
      expect((await writeProjectFile(file, content)).ok).toBe(true);
      expect(await readFile(file, 'utf8')).toBe(content);
      expect((await writeProjectFile(path.join(dir, 'missing', 'project.json'), 'bad')).ok).toBe(false);
      expect(await readFile(file, 'utf8')).toBe(content);
      expect(await readdir(dir)).toEqual(['Episode #1.cutwright.json']);
    } finally {
      const relative = path.relative(path.resolve(tmpdir()), path.resolve(dir));
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await rm(dir, { recursive: true, force: true });
    }
  });
});
