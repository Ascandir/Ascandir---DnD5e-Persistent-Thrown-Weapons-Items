import { MODULE_ID, setting, loadTex } from "./config.mjs";
import { pointRotation } from "./anim.mjs";

const OVERLAY = Symbol("aptwStuckOverlay");

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
  const signature = JSON.stringify([token.w, token.h, layout.map(l => [l.itemId, l.img, l.x.toFixed(1), l.y.toFixed(1)])]);
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
    const s = new PIXI.Sprite(tex);
    s.anchor.set(0.5);
    s.scale.set(l.size / Math.max(tex.width, tex.height, 1));
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
  Hooks.on("drawToken", token => refreshStuckOverlay(token));
  Hooks.on("refreshToken", (token, flags) => {
    if ( flags?.refreshSize || flags?.refreshShape ) refreshStuckOverlay(token);
  });
  Hooks.on("updateToken", doc => { if ( doc.object ) refreshStuckOverlay(doc.object); });
  for ( const hook of ["createItem", "deleteItem"] ) {
    Hooks.on(hook, item => { if ( item.parent instanceof Actor ) refreshActorTokens(item.parent); });
  }
  Hooks.on("canvasReady", () => {
    for ( const t of canvas.tokens.placeables ) refreshStuckOverlay(t);
  });
}
