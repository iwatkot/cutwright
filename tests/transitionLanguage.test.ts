import { describe, expect, it } from 'vitest';
import { synthesizeTransition } from '../src/lib/transitions';

describe('localized transition descriptions', () => {
  it.each([
    'Überblendung nach Schwarz 0,8 Sekunden', 'Toning til sort 0,8 sekunder',
    'Pretapanje u crno 0,8 sekundi', 'Prelivanje u crno 0,8 sekundi',
    'Prolnutí do černé 0,8 sekundy', 'Overvloeien naar zwart 0,8 seconden',
    'Fondu au noir 0,8 secondes', 'Fundido a negro 0,8 segundos',
    'Растворение в чёрный 0,8 секунды', 'Наплив у чорний 0,8 секунди',
  ])('recognizes the localized color and decimal duration: %s', request => {
    const result=synthesizeTransition(request);
    expect(result.xfade).toBe('fadeblack'); expect(result.color).toBe('#000000'); expect(result.duration).toBe(.8);
    expect(result.name).toBe(request); expect(result.description).toContain(request);
  });
  it.each(['Nach rechts schieben','Skub mod højre','Klizanje desno','Klizanje desno','Posun vpravo','Schuif naar rechts','Glisser à droite','Deslizar a la derecha','Сдвиг вправо','Зсув праворуч'])('recognizes localized movement: %s', request => {
    expect(synthesizeTransition(request).xfade).toBe('slideright');
  });
  it('retains explicit technical names and does not override a black fade with generic fade', () => {
    expect(synthesizeTransition('fade to black 0.8s').xfade).toBe('fadeblack');
    expect(synthesizeTransition('fadeblack 0.8s').xfade).toBe('fadeblack');
    expect(synthesizeTransition('hblur 0.8s').xfade).toBe('hblur');
  });
  it.each(['Kreis schließen','Luk en cirkel','Zatvori krug','Zatvori krug','Uzavři kruh','Sluit de cirkel','Fermer le cercle','Cierra el círculo','Закрой круг','Закрий коло'])('recognizes a closing circle in a supported language: %s',request=>{
    expect(synthesizeTransition(request).xfade).toBe('circleclose');
  });
  it('does not interpret Belgrade as a request for a white fade',()=>{
    const result=synthesizeTransition('Belgrade 0,8 seconds');
    expect(result.xfade).not.toBe('fadewhite');expect(result.duration).toBe(.8);expect(result.name).toContain('Belgrade');
  });
  it('accepts ordinary inflections in localized descriptions',()=>{
    expect(synthesizeTransition('Een witte overgang').xfade).toBe('fadewhite');
    expect(synthesizeTransition('Luk cirklen').xfade).toBe('circleclose');
    expect(synthesizeTransition('Fermer les cercles').xfade).toBe('circleclose');
  });
  it.each([
    ['Naar rechts schuiven 0,8 seconden','slideright',.8],
    ['Omhoog vegen 0,5 seconden','wipeup',.5],
    ['Vervagen 1,2 seconden','hblur',1.2],
  ] as const)('recognizes the Dutch infinitive used by the guide: %s',(request,xfade,duration)=>{
    const result=synthesizeTransition(request);
    expect(result.xfade).toBe(xfade);expect(result.duration).toBe(duration);
  });
  it.each([
    ['Klizanje udesno 0,8 sekundi','slideright'],
    ['Brisanje udesno 0,8 sekundi','wiperight'],
  ])('recognizes a natural Serbian/Croatian direction: %s',(request,xfade)=>{
    const result=synthesizeTransition(request);
    expect(result.xfade).toBe(xfade);expect(result.duration).toBe(.8);
  });
});
