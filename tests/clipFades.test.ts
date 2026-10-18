import { describe, expect, it } from 'vitest';
import { clipVisualGain, envelopeGain, fadeCurveAtMidpoint, fadeShape, resolveVisualEnvelope, visualLastFrame } from '../src/lib/clipFades';
import { clipFadeEnvelope } from '../src/lib/audioEnv';
import { patchLinkedClips, splitLinkedClips } from '../src/lib/clipEdits';
import { emptyProject } from '../src/lib/store';
import { parseAgentOps, applyOpsToProject } from '../src/lib/agentOps';
import { validateProject } from '../src/lib/validate';
import { projectFontStyles, validProjectFonts } from '../src/lib/projectFonts';
import type { Clip } from '../src/lib/types';
import { resolvePreviewComposition } from '../src/lib/previewComposition';

const clip = (patch: Partial<Clip> = {}): Clip => ({ id:'picture',mediaId:'m',name:'Picture',trackId:'v1',start:0,duration:8,offset:0,color:'#112233',...patch });
const project = () => ({ ...emptyProject(), media:[{id:'m',name:'Picture',kind:'image' as const,src:'picture.png',duration:8,color:'#112233'}], clips:[clip({visualFadeIn:1,visualFadeOut:3,visualFadeInCurve:-.6,visualFadeOutCurve:.5})] });
describe('clip picture and sound envelopes', () => {
  it('keeps every curve monotonic and exact at its endpoints; center handles invert it', () => {
    for (const curve of [-1,-.5,0,.5,1]) {
      expect(fadeShape(0,curve)).toBe(0); expect(fadeShape(1,curve)).toBe(1);
      const samples = Array.from({length:101},(_,i)=>fadeShape(i/100,curve));
      expect(samples.every((value,i)=>i===0||value>=samples[i-1])).toBe(true);
      expect(fadeCurveAtMidpoint(fadeShape(.5,curve))).toBeCloseTo(curve);
    }
  });
  it('puts the last encoded frame at black for fractional boundaries and NTSC clocks', () => {
    for(const fps of [24,30,30000/1001])for(const start of [0,.019,.37]){
      const c=clip({start,duration:8.885,visualFadeOut:3});const end=visualLastFrame(c,fps);
      expect(clipVisualGain(c,end,fps)).toBe(0);expect(clipVisualGain(c,end-3,fps)).toBeCloseTo(1);
      expect(clipVisualGain(c,end-1.5,fps)).toBeCloseTo(.5);
    }
  });
  it('keeps existing sound ramps independent of picture fades', () => {
    const c=clip({fadeIn:2,fadeOut:3,visualFadeIn:1,visualFadeOut:1});
    expect(clipFadeEnvelope(c,1)).toBe(.5);expect(clipVisualGain(c,1,30)).toBe(1);
    expect(envelopeGain({offset:0,duration:2,fadeIn:4,fadeOut:0},.5)).toBe(.5);
  });
  it('uses the same last-frame visual clock in preview and export at fractional clip starts', () => {
    const p=project();p.clips=[clip({start:.019,duration:8.885,visualFadeOut:3})];
    const frame=Math.round((p.clips[0].start+p.clips[0].duration)*p.fps)-1;
    expect(resolvePreviewComposition(p,[],frame/p.fps)[0].layers[0].style.opacity).toBe(0);
  });
  it('preserves the original visual envelope on split and the untouched edge on edits', () => {
    const p=project(),original=p.clips[0];let counter=0;const result=splitLinkedClips(p,'picture',6,()=>`id-${++counter}`).project;
    expect(clipVisualGain(result.clips[1],.5,30)).toBeCloseTo(clipVisualGain(original,6.5,30));
    expect(result.clips[1].visualEnvelope?.fadeOutEnd).toBe(resolveVisualEnvelope(original,30).fadeOutEnd);
    const changed=patchLinkedClips(result,result.clips[1].id,{visualFadeIn:.2,visualFadeInCurve:.7});
    expect(changed.clips[1].visualEnvelope?.fadeOutEnd).toBe(result.clips[1].visualEnvelope?.fadeOutEnd);
    expect(changed.clips[1].visualEnvelope?.fadeOutCurve).toBe(.5);
  });
  it('accepts the same explicit visual/audio lengths and curves through atomic agent edits', () => {
    const parsed=parseAgentOps(JSON.stringify({ops:[{type:'setClipProps',clipId:'picture',visualFadeOut:3,visualFadeOutCurve:.4,fadeOut:3,fadeOutCurve:-.3}]}));
    expect(parsed.errors).toEqual([]);const result=applyOpsToProject(project(),[],parsed.ops);expect(result.rejected).toEqual([]);
    expect(result.project.clips[0]).toMatchObject({visualFadeOut:3,visualFadeOutCurve:.4,fadeOut:3,fadeOutCurve:-.3});
    expect(validateProject(result.project).ok).toBe(true);
    expect(parseAgentOps(JSON.stringify({ops:[{type:'setClipProps',clipId:'picture',visualFadeOutCurve:2}]})).errors.length).toBeGreaterThan(0);
  });
  it('limits embedded fonts to bounded original font data and escapes family style text', () => {
    const font={family:'Local </style>',weight:400,dataUrl:'data:font/ttf;base64,AAEAAAA='};
    expect(validProjectFonts([font])).toBe(true);expect(validProjectFonts([{...font,dataUrl:'https://remote.example/font.ttf'}])).toBe(false);
    expect(validProjectFonts([font,font])).toBe(false);expect(projectFontStyles([font],font.family)).not.toContain('</style>"');
    expect(projectFontStyles([font],font.family)).toContain('&lt;/style&gt;');
  });
});
