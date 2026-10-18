/** Recognize the same small transition vocabulary in all supported UI languages.
 * This normalizes matching only; a person's original description remains their name. */
const concepts: [string, string][] = [
  ['directional','gerichtet\\p{L}*|retningsbestemt\\p{L}*|usmjeren\\p{L}*|usmeren\\p{L}*|smerov\\p{L}*|gericht\\p{L}*|directionnel\\p{L}*|direccional\\p{L}*|направлен\\p{L}*|напрямлен\\p{L}*'],
  ['blur','kameraunscharf\\p{L}*|kamerauskarphed|rozostren\\p{L}*|camera-onscherpte|defocalis\\p{L}*|расфокус\\p{L}*|розфокус\\p{L}*'],
  ['black','schwarz|sort|crn\\p{L}*|cern\\p{L}*|zwart|noir\\p{L}*|negr\\p{L}*|черн\\p{L}*|чорн\\p{L}*'],
  ['white','wei[ßs]\\p{L}*|hvid\\p{L}*|bijel\\p{L}*|bel(?:a|e|i|o|u|og|oj|om|ih|im)|beo|bil\\p{L}*|wit(?:te)?|blanc\\p{L}*|бел\\p{L}*|бiл\\p{L}*|біл\\p{L}*'],
  ['slide','schieb\\p{L}*|gleit\\p{L}*|skub\\p{L}*|kliz\\p{L}*|posun\\p{L}*|schui[fv]\\p{L}*|gliss\\p{L}*|desliz\\p{L}*|сдвиг\\p{L}*|сдвин\\p{L}*|зсув\\p{L}*|зсун\\p{L}*'],
  ['wipe','wisch\\p{L}*|aftorr\\p{L}*|bris\\p{L}*|ster\\p{L}*|ve(?:eg|g)\\p{L}*|balay\\p{L}*|barrid\\p{L}*|шторк\\p{L}*'],
  ['right','rechts|h[øo]jre|u?desn\\p{L}*|vpravo|droite|derecha|вправо|праворуч'],
  ['left','links|venstre|u?lijev\\p{L}*|u?lev\\p{L}*|vlevo|gauche|izquierda|влево|ліворуч|лiворуч'],
  ['up','oben|aufwarts|opad|gore|nagore|nahoru|omhoog|haut|arriba|вверх|угору|вгору'],
  ['down','unten|abwarts|nedad|dolje|dole|nadole|dolu|omlaag|bas|abajo|вниз|униз'],
  ['zoom','vergro[ßs]er\\p{L}*|povec\\p{L}*|uve[cć]\\p{L}*|pribliz\\p{L}*|inzoom\\p{L}*|acerc\\p{L}*|масштаб\\p{L}*|наближен\\p{L}*|увеличен\\p{L}*|збільшен\\p{L}*|збiльшен\\p{L}*'],
  ['circle','kreis\\p{L}*|cirkel\\p{L}*|cirkl\\p{L}*|krug\\p{L}*|kruz\\p{L}*|kruh\\p{L}*|cercle\\p{L}*|circul\\p{L}*|круг\\p{L}*|коло\\p{L}*'],
  ['close','schlie[ßs]\\p{L}*|luk\\p{L}*|zatv[ao]r\\p{L}*|(?:u)?zavri\\p{L}*|sluit\\p{L}*|ferm\\p{L}*|(?:cerr|cierr)\\p{L}*|закр[ыо]\\p{L}*|закри\\p{L}*'],
  ['pixel','pixel\\p{L}*|piksel\\p{L}*|пиксел\\p{L}*|піксел\\p{L}*|пiксел\\p{L}*'],
  ['blur','unscharf\\p{L}*|weichzeichn\\p{L}*|sl[øo]r\\p{L}*|zamu[cć]\\p{L}*|rozmaz\\p{L}*|verva(?:ag|g)\\p{L}*|flou|desenfo\\p{L}*|размы\\p{L}*|розми\\p{L}*'],
  ['dissolve','uberblend\\p{L}*|toning|pretap\\p{L}*|preliv\\p{L}*|prolin\\p{L}*|overvloei\\p{L}*|fondu|fundido|раствор\\p{L}*|наплив\\p{L}*'],
  ['seconds','sekund\\p{L}*|seconden|secondes|segund\\p{L}*|секунд\\p{L}*|сек|с'],
];
const patterns=concepts.map(([replacement,words])=>({replacement,regex:new RegExp(`(?<!\\p{L})(?:${words})(?!\\p{L})`,'gu')}));
export function normalizeTransitionDescription(request: string): string {
  let text=request.toLowerCase().normalize('NFD').replace(/\p{M}/gu,'').replace(/(\d),(\d)/g,'$1.$2');
  for(const {regex,replacement} of patterns)text=text.replace(regex,replacement);
  return text;
}
