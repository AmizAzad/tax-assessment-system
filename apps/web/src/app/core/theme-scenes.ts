/**
 * The backgrounds that ship with the product.
 *
 * Nothing here covers the canvas opaquely and every fill is under 0.18 alpha,
 * so the page background token shows through: a scene is a *tint* of the
 * active theme rather than a picture with its own brightness. That is why
 * these are generated SVG rather than photographs. A photograph carries its
 * own light and dark regions, and no veil setting makes one safe in both
 * themes at once.
 *
 * The hues are deliberately close to the light page colour. Measured on the
 * register in Chromium, muted body text on the page background is 4.69:1 in
 * the light theme against a 4.5 floor, which is 4% of headroom; the dark theme
 * has 8.15:1. A scene is only visible when it moves the page luminance away
 * from the page colour, so a saturated tint that reads well on the light page
 * spends headroom the light theme does not have. Each tint below is the page
 * colour blended a quarter of the way towards its hue. That is the darkest
 * blend measured at which all four scenes hold 4.5:1 in both themes at the
 * default veil; blending a third of the way costs the light theme its floor
 * on three of them. `theme.spec.ts` pins the alpha ceiling so a later scene
 * cannot quietly undo it.
 */

export interface Scene {
  readonly id: string;
  readonly name: string;
  readonly dataUrl: string;
}

const MIST = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="mistSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(212,219,228)" stop-opacity="0.17"/><stop offset="1" stop-color="rgb(212,219,228)" stop-opacity="0.02"/></linearGradient></defs><rect width="1600" height="640" fill="url(#mistSky)"/><path d="M0 470q240-90 470-40t520-70 610 30v510H0z" fill="rgba(212,219,228,0.09)"/><path d="M0 590q300-70 560-10t1040-40v360H0z" fill="rgba(212,219,228,0.11)"/><path d="M0 712q380 48 800-16t800 8v196H0z" fill="rgba(212,219,228,0.14)"/><rect y="536" width="1600" height="26" rx="13" fill="rgba(212,219,228,0.06)"/><rect x="180" y="628" width="1240" height="20" rx="10" fill="rgba(212,219,228,0.05)"/></svg>`;

const WATER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="waterDeep" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(215,222,225)" stop-opacity="0.14"/><stop offset="1" stop-color="rgb(215,222,225)" stop-opacity="0.04"/></linearGradient></defs><circle cx="1120" cy="322" r="96" fill="rgba(215,222,225,0.10)"/><path d="M0 452q260-58 520-24t1080-26v44H0z" fill="rgba(215,222,225,0.13)"/><rect y="470" width="1600" height="430" fill="url(#waterDeep)"/><g fill="rgba(215,222,225,0.10)"><rect x="180" y="548" width="520" height="12" rx="6"/><rect x="820" y="602" width="620" height="12" rx="6"/><rect x="300" y="676" width="900" height="12" rx="6"/><rect x="120" y="762" width="640" height="12" rx="6"/></g></svg>`;

const PINES = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="pineHaze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(209,216,212)" stop-opacity="0.13"/><stop offset="1" stop-color="rgb(209,216,212)" stop-opacity="0.03"/></linearGradient></defs><rect width="1600" height="660" fill="url(#pineHaze)"/><path d="M0 596q280-116 520-44t1080-72v420H0z" fill="rgba(209,216,212,0.09)"/><g fill="rgba(209,216,212,0.15)"><path d="M96 792l46-176 46 176z"/><path d="M214 806l58-222 58 222z"/><path d="M352 798l40-158 40 158z"/><path d="M470 812l62-238 62 238z"/><path d="M632 800l44-170 44 170z"/><path d="M772 810l56-214 56 214z"/><path d="M922 796l42-164 42 164z"/><path d="M1056 812l60-232 60 232z"/><path d="M1212 800l44-172 44 172z"/><path d="M1352 808l58-220 58 220z"/></g><rect y="790" width="1600" height="110" fill="rgba(209,216,212,0.11)"/></svg>`;

const DUNES = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="duneSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(227,222,215)" stop-opacity="0.14"/><stop offset="1" stop-color="rgb(227,222,215)" stop-opacity="0.03"/></linearGradient></defs><rect width="1600" height="560" fill="url(#duneSky)"/><path d="M0 520q420-150 820-40t780-36v456H0z" fill="rgba(227,222,215,0.10)"/><path d="M0 646q340-118 700-18t900-44v316H0z" fill="rgba(227,222,215,0.13)"/><path d="M0 772q420-96 860-12t740-42v182H0z" fill="rgba(227,222,215,0.15)"/><path d="M0 596q380-94 720-4" fill="none" stroke="rgba(227,222,215,0.06)" stroke-width="10"/></svg>`;

function toDataUrl(svg: string): string {
  // Encoded at module load rather than pasted in as a pre-encoded blob, so the
  // markup above stays readable and editable by whoever has to adjust a hue.
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

export const SCENES: readonly Scene[] = [
  { id: 'mist', name: 'Morning mist', dataUrl: toDataUrl(MIST) },
  { id: 'water', name: 'Still water', dataUrl: toDataUrl(WATER) },
  { id: 'pines', name: 'Pine ridge', dataUrl: toDataUrl(PINES) },
  { id: 'dunes', name: 'Dunes', dataUrl: toDataUrl(DUNES) },
];

export function findScene(id: string): Scene | undefined {
  return SCENES.find((scene) => scene.id === id);
}
