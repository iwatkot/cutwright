import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { browserMediaInfo } from '../src/lib/browserMediaInfo';

const folder=mkdtempSync(path.join(tmpdir(),'cutwright-audio-info-'));
const files=[path.join(folder,'sound.mp4'),path.join(folder,'silent.mp4')];
beforeAll(()=>{
 for(const [i,file] of files.entries()){
  const result=spawnSync(ffmpeg!,['-y','-f','lavfi','-i','color=size=160x90:rate=24',...(i===0?['-f','lavfi','-i','sine=frequency=440:sample_rate=48000']:[]),'-t','1','-c:v','libx264','-pix_fmt','yuv420p',...(i===0?['-c:a','aac']:['-an']),file],{windowsHide:true,timeout:20000});
  expect(result.status).toBe(0);
 }
});
afterAll(()=>{for(const file of files)unlinkSync(file);rmdirSync(folder);});
describe('local browser audio detection',()=>{
 it.each([0,1])('detects audio presence without guessing from the video extension (%s)',async i=>{
  const info=await browserMediaInfo(new Blob([readFileSync(files[i])]));
  expect(info.hasAudio).toBe(i===0);expect(info.width).toBe(160);expect(info.height).toBe(90);expect(info.duration).toBeCloseTo(1,1);
 });
});
