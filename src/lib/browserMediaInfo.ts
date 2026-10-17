import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';

/** Inspect local container tracks, including audio presence, without decoding or uploading. */
export async function browserMediaInfo(file: Blob): Promise<{duration:number;hasAudio:boolean;width?:number;height?:number}> {
  const input = new Input({formats:ALL_FORMATS,source:new BlobSource(file,{maxCacheSize:1024*1024})});
  try {
    const [audio,video,metadataDuration] = await Promise.all([input.getPrimaryAudioTrack(),input.getPrimaryVideoTrack(),input.getDurationFromMetadata()]);
    const duration = metadataDuration ?? await input.computeDuration();
    return {duration:Number.isFinite(duration) ? duration : 0,hasAudio:!!audio,...(video ? {width:video.displayWidth,height:video.displayHeight} : {})};
  } finally { input.dispose(); }
}
