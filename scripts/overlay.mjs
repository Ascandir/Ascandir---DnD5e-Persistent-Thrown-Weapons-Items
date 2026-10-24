import { MODULE_ID, setting, loadTex, isGroundToken } from "./config.mjs";
import { pointRotation } from "./anim.mjs";

const OVERLAY = Symbol("aptwStuckOverlay");
const GROUND = Symbol("aptwGroundHighlight");

/* -------------------------------------------- */
/*  Highlight (outline around the weapon image)  */
/* -------------------------------------------- */

function highlightOn() {
  try { return !!setting("highlight"); } catch { return true; }
}

/** RGB (0..1) of the highlight color setting. */
function highlightRGB() {
  let hex = "#ffffff";
  try { hex = String(setting("highlightColor") || hex); } catch {}
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Filter that turns every visible pixel into the highlight color (keeps alpha). */
function silhouetteFilter() {
  const f = new PIXI.ColorMatrixFilter();
  const [r, g, b] = highlightRGB();
  f.matrix = [
    0, 0, 0, 0, r,
    0, 0, 0, 0, g,
    0, 0, 0, 0, b,
    0, 0, 0, 1, 0
  ];
  return f;
}

/**
 * A weapon image with a colored outline: 8 slightly shifted silhouettes behind the image.
 * Returns a container centered on (0,0); set position/rotation on it.
 */
function outlinedSprite(tex, size) {
  const c = new PIXI.Container();
  c.eventMode = "none";
  const scale = size / Math.max(tex.width, tex.height, 1);
  if ( highlightOn() ) {
    const outline = new PIXI.Container();
    const t = Math.max(1.5, size * 0.045);
    for ( let i = 0; i < 8; i++ ) {
      const a = (i / 8) * Math.PI * 2;
      const s = new PIXI.Sprite(tex);
      s.anchor.set(0.5);
      s.scale.set(scale);
      s.position.set(Math.cos(a) * t, Math.sin(a) * t);
      outline.addChild(s);
    }
    outline.filters = [silhouetteFilter()];
    outline.alpha = 0.95;
    c.addChild(outline);
  }
  const main = new PIXI.Sprite(tex);
  main.anchor.set(0.5);
  main.scale.set(scale);
  c.addChild(main);
  return c;
}

/** Outline for a weapon lying on the ground (drawn over the token's own image). */
export async function refreshGroundHighlight(token) {
  if ( !token || token.destroyed ) return;
  let c = token[GROUND];
  if ( c?.destroyed ) c = token[GROUND] = null;
  const doc = token.document;
  if ( !highlightOn() || !isGroundToken(token) || !doc?.texture?.src ) {
    if ( c ) { c.destroy({ children: true }); token[GROUND] = null; }
    return;
  }
  const size = token.w * Math.abs(doc.texture.scaleX ?? 1);
  const signature = JSON.stringify([doc.texture.src, size.toFixed(1), token.w, token.h, highlightRGB()]);
  if ( c && (c._aptwSignature === signature) ) {
    c.rotation = doc.lockRotation ? 0 : (((doc.rotation ?? 0) * Math.PI) / 180);
    return;
  }
  let tex;
  try { tex = await loadTex(doc.texture.src); } catch { tex = null; }
  if ( !tex || token.destroyed ) return;
  if ( c ) c.destroy({ children: true });
  c = outlinedSprite(tex, size);
  c._aptwSignature = signature;
  c.position.set(token.w / 2, token.h / 2);
  c.rotation = doc.lockRotation ? 0 : (((doc.rotation ?? 0) * Math.PI) / 180);
  token[GROUND] = c;
  token.addChildAt(c, 0);
}

/** Redraw every highlight on the scene (after a settings change). */
export function refreshAllHighlights() {
  if ( !canvas?.ready ) return;
  for ( const t of canvas.tokens.placeables ) {
    if ( t[OVERLAY] ) t[OVERLAY]._aptwSignature = null;
    refreshStuckOverlay(t);
    if ( t[GROUND] ) t[GROUND]._aptwSignature = null;
    refreshGroundHighlight(t);
  }
}

/**
 * Weapons stuck in a token: [{itemId, angle, img, name}].
 * Stored on the TokenDocument (not the actor), because players often have no access to a foreign NPC's actor.
 */
export function getStuckEntries(tokenOrDoc) {
  const doc = tokenOrDoc?.document ?? tokenOrDoc;
  const stuck = doc?.getFlag?.(MODULE_ID, "stuck") ?? {};
  const actor = doc?.actor;
  return Object.entries(stuck)
    .filter(([id, v]) => v && (!actor?.items || actor.items.has(id)))
    .map(([itemId, v]) => {
      const item = actor?.items?.get(itemId);
      return { itemId, angle: v.angle ?? 0, img: item?.img ?? v.img, name: item?.name ?? v.name ?? "?" };
    })
    .filter(e => e.img);
}

/** Geometry of the stuck icons of a token, in token-local coordinates. */
function iconLayout(token, entries) {
  const gs = canvas.dimensions.size;
  const size = gs * setting("stuckIconSize");
  const cx = token.w / 2;
  const cy = token.h / 2;
  const r = (Math.min(token.w, token.h) / 2) * 0.8;
  return entries.map(e => {
    const a = Number(e.angle) || 0;
    // Icon center sits slightly outside the edge, point facing the token center
    const dist = r + (size * 0.18);
    return {
      itemId: e.itemId,
      img: e.img,
      x: cx + (Math.cos(a) * dist),
      y: cy + (Math.sin(a) * dist),
      rotation: pointRotation(a + Math.PI),
      size
    };
  });
}

/** (Re)build the stuck-weapon icons on a token. */
export async function refreshStuckOverlay(token) {
  if ( !token || token.destroyed ) return;
  const entries = getStuckEntries(token);
  let c = token[OVERLAY];
  if ( c?.destroyed ) c = token[OVERLAY] = null;

  if ( !entries.length ) {
    if ( c ) { c.destroy({ children: true }); token[OVERLAY] = null; }
    return;
  }

  const layout = iconLayout(token, entries);
  const signature = JSON.stringify([token.w, token.h, highlightOn(), highlightRGB(),
    layout.map(l => [l.itemId, l.img, l.x.toFixed(1), l.y.toFixed(1)])]);
  if ( c && (c._aptwSignature === signature) ) return;

  if ( !c ) {
    c = new PIXI.Container();
    c.eventMode = "none";
    c.sortableChildren = true;
    token[OVERLAY] = c;
    token.addChild(c);
  }
  c._aptwSignature = signature;
  c._aptwLayout = layout;
  for ( const child of c.removeChildren() ) child.destroy();

  for ( const l of layout ) {
    let tex;
    try { tex = await loadTex(l.img); } catch { tex = null; }
    if ( !tex || c.destroyed || (c._aptwSignature !== signature) ) continue;
    const s = outlinedSprite(tex, l.size);
    s.position.set(l.x, l.y);
    s.rotation = l.rotation;
    c.addChild(s);
  }
}

/** Find a stuck icon at a canvas point. */
export function stuckIconAt(point) {
  for ( const token of canvas.tokens.placeables ) {
    const c = token[OVERLAY];
    if ( !c || c.destroyed || !token.visible || !c._aptwLayout ) continue;
    for ( const l of c._aptwLayout ) {
      const x = token.x + l.x;
      const y = token.y + l.y;
      if ( Math.hypot(point.x - x, point.y - y) <= (l.size * 0.6) ) return { token, itemId: l.itemId };
    }
  }
  return null;
}

/** Refresh overlays of every token belonging to an actor. */
export function refreshActorTokens(actor) {
  if ( !canvas?.ready || !actor ) return;
  const tokens = actor.isToken ? [actor.token?.object] : actor.getActiveTokens?.(true) ?? [];
  for ( const t of tokens ) if ( t ) refreshStuckOverlay(t);
}

export function registerOverlayHooks() {
  Hooks.on("drawToken", token => { refreshStuckOverlay(token); refreshGroundHighlight(token); });
  Hooks.on("refreshToken", (token, flags) => {
    if ( flags?.refreshSize || flags?.refreshShape ) refreshStuckOverlay(token);
    if ( flags?.refreshSize || flags?.refreshShape || flags?.refreshRotation || flags?.refreshMesh ) refreshGroundHighlight(token);
  });
  Hooks.on("updateToken", doc => {
    if ( !doc.object ) return;
    refreshStuckOverlay(doc.object);
    refreshGroundHighlight(doc.object);
  });
  for ( const hook of ["createItem", "deleteItem"] ) {
    Hooks.on(hook, item => { if ( item.parent instanceof Actor ) refreshActorTokens(item.parent); });
  }
  Hooks.on("canvasReady", () => {
    for ( const t of canvas.tokens.placeables ) { refreshStuckOverlay(t); refreshGroundHighlight(t); }
  });
}
