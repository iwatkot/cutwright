import { beforeEach, describe, expect, it } from 'vitest';
import { addLinkedAudio, canDetachAudio, detachClipAudio, materializeLinkedAudio } from '../src/lib/linkedAudio';
import { deleteLinkedClips, patchLinkedClips, splitLinkedClips } from '../src/lib/clipEdits';
import { useStore } from '../src/lib/store';
import type { Project } from '../src/lib/types';

const fixture = (): Project => ({version:1,name:'sound separation',width:320,height:180,fps:24,
  media:[{id:'m',name:'Camera.mp4',src:'camera.mp4',kind:'video',hasAudio:true,duration:20,color:'#60a5fa'}],
  clips:[{id:'v',mediaId:'m',name:'Camera',trackId:'v1',start:2,duration:4,offset:1,speed:2,volume:.7,fadeIn:.4,fadeOut:.6,color:'#60a5fa',posX:10}],transitions:[],subtitles:[],customTransitions:[]});
let serial=0;
const id=()=>`linked-${serial++}`;
beforeEach(()=>{serial=0;useStore.setState({past:[],future:[],selectedClipId:null});});

describe('default linked audio and explicit separation',()=>{
 it('creates aligned video/audio blocks from the same source, with no visual properties on the audio',()=>{
  const p=addLinkedAudio(fixture(),'v',id),[v,a]=p.clips;
  expect([v.mutedAudio,v.linkGroup,a.linkGroup]).toEqual([true,'linked-0','linked-0']);
  expect([a.trackId,a.start,a.duration,a.offset,a.speed,a.volume,a.fadeIn,a.fadeOut]).toEqual(['a1',2,4,1,2,.7,.4,.6]);
  expect(a.mediaId).toBe(v.mediaId);expect(a.posX).toBeUndefined();expect(v.posX).toBe(10);
  expect(materializeLinkedAudio(p,id)).toEqual(p);
 });
 it('leaves silent videos, images, unknown audio metadata and already detached clips unchanged',()=>{
  for(const patch of [{hasAudio:false},{hasAudio:undefined},{kind:'image' as const}]){
   const p=fixture();Object.assign(p.media[0],patch);expect(materializeLinkedAudio(p,id)).toBe(p);
  }
  const p=detachClipAudio(materializeLinkedAudio(fixture(),id),'v',id);
  const deleted=deleteLinkedClips(p,p.clips[1].id);
  expect(materializeLinkedAudio(JSON.parse(JSON.stringify(deleted)),id).clips).toHaveLength(1);
  expect(deleted.clips[0].mutedAudio).toBe(true);
  expect(canDetachAudio(deleted,'v')).toBe(false);
 });
 it('avoids occupied or muted audio lanes and preserves a non-default source track mix',()=>{
  const p=fixture();p.clips.push({...p.clips[0],id:'music',trackId:'a1'});p.trackSettings={a2:{muted:true}};
  expect(addLinkedAudio(p,'v',id).clips.at(-1)?.trackId).toBe('a3');
  p.trackSettings.v1={volume:2,muted:true};
  const result=addLinkedAudio(p,'v',id),audio=result.clips.at(-1)!;
  expect(audio.volume).toBe(.7);expect(result.trackSettings?.[audio.trackId]).toEqual({volume:2,muted:true});
 });
 it('splits both blocks at the same source time and detaches only the chosen half',()=>{
  const p=splitLinkedClips(materializeLinkedAudio(fixture(),id),'v',4,id).project;
  const right=p.clips.filter(c=>c.start===4);expect(right).toHaveLength(2);
  expect(right.map(c=>c.offset)).toEqual([5,5]);
  const detached=detachClipAudio(p,right[0].id,id);
  expect(detached.clips.filter(c=>c.start===2).every(c=>!!c.linkGroup)).toBe(true);
  expect(detached.clips.filter(c=>c.start===4).every(c=>c.linkGroup===null)).toBe(true);
  const moved=patchLinkedClips(detached,right[1].id,{start:8,duration:1});
  expect(moved.clips.find(c=>c.id===right[0].id)?.start).toBe(4);
 });
 it('can detach a legacy video as one operation without discarding fades or source timing',()=>{
  const p=fixture();p.media[0].hasAudio=undefined;p.clips[0].audioEnvelope={offset:1,duration:8,fadeIn:2,fadeOut:1};
  const result=detachClipAudio(p,'v',id);
  expect(result.clips).toHaveLength(2);expect(result.clips.every(c=>c.linkGroup===null)).toBe(true);
  expect(result.clips[1].audioEnvelope).toEqual(p.clips[0].audioEnvelope);
  expect(result.clips[0].mutedAudio).toBe(true);
 });
 it('adds a linked pair and undoes it as one timeline edit',()=>{
  const p=fixture();p.clips=[];useStore.getState().setProject(p,true);useStore.setState({past:[],future:[]});
  const s=useStore.getState();s.addClipFromMedia('m');
  expect(useStore.getState().project.clips).toHaveLength(2);expect(useStore.getState().past).toHaveLength(1);
  s.undo();expect(useStore.getState().project.clips).toHaveLength(0);
  s.redo();expect(useStore.getState().project.clips).toHaveLength(2);
 });
 it('keeps edits linked, detaches with one undo step, and deleting detached audio leaves the video silent after saving',()=>{
  const s=useStore.getState();s.setProject(fixture(),true);useStore.setState({past:[],future:[]});
  s.updateClip('v',{start:3});expect(useStore.getState().project.clips.map(c=>c.start)).toEqual([3,3]);
  s.detachAudio('v');expect(useStore.getState().past).toHaveLength(2);
  s.undo();expect(useStore.getState().project.clips.every(c=>!!c.linkGroup)).toBe(true);
  s.redo();const a=useStore.getState().project.clips[1];s.selectClip(a.id);s.deleteSelected();
  const saved=JSON.parse(JSON.stringify(useStore.getState().project));s.setProject(saved,true);
  expect(useStore.getState().project.clips).toHaveLength(1);expect(useStore.getState().project.clips[0].mutedAudio).toBe(true);
 });
});
