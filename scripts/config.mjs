export const MODULE_ID = "ascandir-persistent-thrown-weapons";
export const SOCKET = `module.${MODULE_ID}`;

/** Localize helper. */
export function L(key, data) {
  const full = `${MODULE_ID}.${key}`;
  return data ? game.i18n.format(full, data) : game.i18n.localize(full);
}

export function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

export function registerSettings() {
  const reg = (key, type, def, extra = {}) => game.settings.register(MODULE_ID, key, {
    name: `${MODULE_ID}.Settings.${key}.Name`,
    hint: `${MODULE_ID}.Settings.${key}.Hint`,
    scope: "world",
    config: true,
    type,
    default: def,
    ...extra
  });

  // --- Wichtigster Schalter für den SL: ganz oben ---
  reg("pullAutoDamage", Boolean, true);

  // --- Wurf-Erkennung ---
  reg("improvisedThrow", Boolean, true, { requiresReload: true });
  reg("autoDetectRange", Boolean, true);
  reg("excludeNames", String, "Dart, Wurfpfeil, Pfeil, Arrow, Bolzen, Bolt, Kugel, Bullet, Nadel, Needle");

  // --- Treffer / Fehlwurf ---
  reg("stickOnHit", Boolean, true);
  reg("removeEmpty", Boolean, true);
  reg("missRadius", Number, 5, { range: { min: 0, max: 30, step: 5 } });
  reg("fumbleMin", Number, 15, { range: { min: 5, max: 60, step: 5 } });
  reg("fumbleMax", Number, 30, { range: { min: 5, max: 90, step: 5 } });
  reg("groundSize", Number, 0.35, { range: { min: 0.15, max: 1, step: 0.05 } });
  reg("stuckIconSize", Number, 0.45, { range: { min: 0.2, max: 1, step: 0.05 } });

  // --- Gebundene Waffen ---
  reg("boundMode", String, "manual", {
    choices: {
      manual: `${MODULE_ID}.BoundMode.manual`,
      auto: `${MODULE_ID}.BoundMode.auto`
    }
  });
  reg("recallBonusAction", Boolean, true);

  // --- Aufheben / Herausziehen ---
  reg("pickupRange", Number, 5, { range: { min: 0, max: 30, step: 5 } });
  reg("pullRange", Number, 5, { range: { min: 0, max: 30, step: 5 } });
  reg("pullStaysOnMiss", Boolean, false);

  // --- Animation ---
  reg("animate", Boolean, true, { scope: "client" });
  reg("flightSpeed", Number, 14, { range: { min: 4, max: 40, step: 1 } });
  reg("iconAngle", Number, 45, { range: { min: -180, max: 180, step: 5 } });
  reg("defaultStyle", String, "spin", {
    choices: {
      spin: `${MODULE_ID}.Style.spin`,
      fastSpin: `${MODULE_ID}.Style.fastSpin`,
      straight: `${MODULE_ID}.Style.straight`
    }
  });
  reg("straightKeywords", String, "Speer, Spear, Wurfspeer, Javelin, Dreizack, Trident, Pike, Pieke, Lanze, Lance, Harpune, Harpoon, Hellebarde, Halberd, Glefe, Glaive");
  reg("spinKeywords", String, "Axt, Axe, Beil, Hammer, Hatchet, Keule, Club, Sichel, Sickle, Streitkolben, Mace, Morgenstern, Morningstar, Flegel, Flail, Knüppel");
  reg("fastSpinKeywords", String, "Dolch, Dagger, Messer, Knife, Kurzschwert, Shortsword, Wurfstern, Shuriken");

  // --- Hervorhebung ---
  reg("highlight", Boolean, true, { scope: "client", onChange: () => globalThis.aptwRefreshHighlights?.() });
  reg("highlightColor", String, "#ffffff", { scope: "client", onChange: () => globalThis.aptwRefreshHighlights?.() });

  // --- Chat ---
  reg("chatMessages", Boolean, true);
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

function keywordList(key) {
  return String(setting(key) ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function nameMatches(name, key) {
  const n = String(name ?? "").toLowerCase();
  return keywordList(key).some(k => n.includes(k));
}

/** Flight style for an item: "straight" | "spin" | "fastSpin". */
export function styleFor(item) {
  const name = item?.name;
  if ( nameMatches(name, "straightKeywords") ) return "straight";
  if ( nameMatches(name, "fastSpinKeywords") ) return "fastSpin";
  if ( nameMatches(name, "spinKeywords") ) return "spin";
  return setting("defaultStyle") || "spin";
}

/**
 * Whether a weapon (Item document or WeaponData) may persist after being thrown.
 * Ammunition and ammunition-based weapons are excluded, as are natural / siege weapons and excluded names.
 */
export function isEligibleWeapon(itemOrData) {
  const sys = itemOrData?.system ?? itemOrData;
  const item = itemOrData?.system ? itemOrData : itemOrData?.parent;
  if ( !sys ) return false;
  if ( item && (item.type !== "weapon") ) return false;
  if ( sys.properties?.has?.("amm") ) return false;
  if ( ["natural", "siege"].includes(sys.type?.value) ) return false;
  if ( nameMatches(item?.name, "excludeNames") ) return false;
  return true;
}

/** Feet → canvas pixels. */
export function ftToPx(ft) {
  return (ft / canvas.dimensions.distance) * canvas.dimensions.size;
}

/** Grid cells covered by a token: {r0, r1, c0, c1} (inclusive). */
function cellRect(token) {
  const b = token.bounds;
  const inset = Math.min(2, b.width / 4, b.height / 4);
  const a = canvas.grid.getOffset({ x: b.left + inset, y: b.top + inset });
  const z = canvas.grid.getOffset({ x: b.right - inset, y: b.bottom - inset });
  return { r0: Math.min(a.i, z.i), r1: Math.max(a.i, z.i), c0: Math.min(a.j, z.j), c1: Math.max(a.j, z.j) };
}

/**
 * Distance between two tokens the way it's counted at the table:
 * on a square grid by squares (neighbouring square, also diagonal = one grid step, e.g. 5 ft),
 * otherwise edge to edge plus one grid step.
 */
/** Height difference between two tokens in scene units (e.g. ft). */
function elevationGap(a, b) {
  const ea = Number(a?.document?.elevation ?? 0) || 0;
  const eb = Number(b?.document?.elevation ?? 0) || 0;
  return Math.abs(ea - eb);
}

/**
 * Combine horizontal and vertical steps (in grid squares) with the scene's diagonal rule,
 * so flying / elevated tokens count the same way the Foundry ruler does.
 */
function combineSteps(h, v) {
  if ( !v ) return h;
  if ( !h ) return v;
  const D = CONST.GRID_DIAGONALS ?? {};
  const rule = canvas.grid.diagonals;
  const lo = Math.min(h, v);
  const hi = Math.max(h, v);
  switch ( rule ) {
    case D.ALTERNATING_1: return hi + Math.floor(lo / 2);      // 5-10-5
    case D.ALTERNATING_2: return hi + Math.ceil(lo / 2);       // 10-5-10
    case D.APPROXIMATE: return hi + (lo / 2);                  // 1.5
    case D.EXACT: return Math.hypot(h, v);
    case D.RECTILINEAR:
    case D.ILLEGAL: return h + v;
    default: return hi;                                         // equidistant (5-5-5, dnd5e default)
  }
}

/**
 * Distance between two tokens the way it's counted at the table, including elevation:
 * on a square grid by squares (neighbouring square, also diagonal = one grid step, e.g. 5 ft),
 * otherwise edge to edge plus one grid step. Height differences are added with the scene's diagonal rule.
 */
export function tokenGapDistance(a, b) {
  const d = canvas.dimensions.distance;
  const vSteps = elevationGap(a, b) / d;
  if ( canvas.grid.isSquare ) {
    try {
      const A = cellRect(a);
      const B = cellRect(b);
      const dr = Math.max(0, B.r0 - A.r1, A.r0 - B.r1);
      const dc = Math.max(0, B.c0 - A.c1, A.c0 - B.c1);
      return combineSteps(Math.max(dr, dc), vSteps) * d;
    } catch(err) {
      console.warn(`${MODULE_ID} |`, err);
    }
  }
  const ab = a.bounds;
  const bb = b.bounds;
  const dx = Math.max(0, bb.left - ab.right, ab.left - bb.right);
  const dy = Math.max(0, bb.top - ab.bottom, ab.top - bb.bottom);
  const gap = (Math.hypot(dx, dy) / canvas.dimensions.size) * d;
  const horiz = gap + d;
  const vert = elevationGap(a, b);
  return vert ? Math.hypot(horiz, vert) : horiz;
}

/** Is the given token one of our ground item tokens? */
export function isGroundToken(token) {
  return !!(token?.document ?? token)?.getFlag?.(MODULE_ID, "ground");
}

/** The token the current user acts with (pick up / pull). */
let lastActingTokenId = null;
export function rememberActingToken(token, controlled) {
  if ( controlled && token?.actor && !isGroundToken(token) ) lastActingTokenId = token.id;
}

export function getActingToken() {
  const controlled = canvas.tokens.controlled.find(t => t.actor && !isGroundToken(t) && t.actor.isOwner);
  if ( controlled ) return controlled;
  if ( game.user.isGM ) return null; // the GM acts only with a selected token
  const last = lastActingTokenId ? canvas.tokens.get(lastActingTokenId) : null;
  if ( last?.actor?.isOwner ) return last;
  const own = game.user.character?.getActiveTokens?.(true)?.[0];
  return own ?? null;
}

/** The token on the current scene representing an actor. */
export function tokenForActor(actor) {
  if ( !actor ) return null;
  if ( actor.isToken ) return actor.token?.object ?? null;
  return actor.getActiveTokens?.(true)?.[0] ?? null;
}

/** Item data ready to be moved as a single piece somewhere else. */
export function singleItemData(item) {
  const data = item.toObject();
  delete data._id;
  data.system ??= {};
  data.system.quantity = 1;
  if ( "equipped" in data.system ) data.system.equipped = false;
  if ( "container" in data.system ) data.system.container = null;
  if ( data.flags?.dnd5e?.last ) delete data.flags.dnd5e.last;
  data.flags ??= {};
  const prev = data.flags[MODULE_ID] ?? {};
  data.flags[MODULE_ID] = {
    sourceItemId: prev.sourceItemId ?? item.id,
    sourceActorUuid: prev.sourceActorUuid ?? item.actor?.uuid ?? null
  };
  if ( prev.bound ) data.flags[MODULE_ID].bound = prev.bound;
  return data;
}

/** Bond data of a weapon (Item or item data): {key, ownerUuid} or null. */
export function boundOf(itemOrData) {
  const b = itemOrData?.flags?.[MODULE_ID]?.bound ?? itemOrData?._source?.flags?.[MODULE_ID]?.bound;
  return b?.key ? b : null;
}

export function loadTex(src) {
  const fn = foundry.canvas?.loadTexture ?? globalThis.loadTexture;
  return fn(src);
}

export function randomBetween(a, b) {
  return a + (Math.random() * (b - a));
}
