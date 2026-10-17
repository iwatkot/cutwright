import { describe, expect, it } from 'vitest';
import { projectDownloadBasename } from '../src/lib/projectFileName';

describe('project download names', () => {
  it.each(['Мой фильм','Мій проєкт','Český příběh','Đorđe i Ana','Første klip','L’été à Paris','Música y vídeo','Mijn film 🎬'])('keeps the original language: %s',name=>{
    expect(projectDownloadBasename(name)).toBe(name);
  });
  it('excludes path separators and controls while retaining the name',()=>{
    expect(projectDownloadBasename('../Мій:проєкт/фільм?\u0000')).toBe('-Мій-проєкт-фільм--');
    expect(projectDownloadBasename(' ... ')).toBe('CutWright');
    expect(projectDownloadBasename('CON')).toBe('_CON');
    expect(projectDownloadBasename('LPT1.test')).toBe('_LPT1.test');
  });
  it('does not cut a surrogate pair when bounding the basename',()=>{
    const result=projectDownloadBasename('🎬'.repeat(125));
    expect(Array.from(result)).toHaveLength(120);expect(result).toBe('🎬'.repeat(120));
  });
});
