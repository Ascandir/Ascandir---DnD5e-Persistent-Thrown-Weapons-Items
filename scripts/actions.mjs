import {
  MODULE_ID, L, setting, styleFor, isEligibleWeapon, ftToPx, tokenGapDistance, isGroundToken,
  getActingToken, tokenForActor, singleItemData, randomBetween
} from "./config.mjs";
import { requestGM, broadcast, gmHandlers, broadcastHandlers } from "./net.mjs";
import { playThrow, planFlight } from "./anim.mjs";
import { stuckIconAt, getStuckEntries } from "./overlay.mjs";

/** Item ids currently being used for a "pull out" attack (ignored by the throw hook). */
const pullingItems = new Set();

/* ============================================ */
/*  Throwing                                    */
/* ============================================ */

/**
 * Called from the dnd5e.rollAttack hook on the client that made the roll.
 * dnd5e 6.x itself reduces the quantity by 1 for attacks in a "thrown" mode (after this hook).
 */
export async function onRollAttack(rolls, { subject } = {}) {
  const item = subject?.item;
  const actor = subject?.actor ?? item?.actor;
  if ( !item || !actor || pullingItems.has(item.id) ) return;
  if ( !isEligibleWeapon(item) ) return;
  const roll = rolls?.[0];
  if ( !roll || !canvas?.ready ) return;

  const target = [...game.user.targets][0];
  const attacker = tokenForActor(actor);
  if ( !target || !attacker || (target === attacker) ) return;

  // Was it a throw?
  const mode = roll.options?.attackMode ?? "";
  let thrown = mode.startsWith("thrown");
  let improvised = false;
  if ( !thrown && setting("autoDetectRange") && (item.system.attackType === "melee") ) {
    const reach = item.system.range?.reach || canvas.dimensions.distance;
    if ( tokenGapDistance(attacker, target) > reach ) { thrown = true; improvised = true; }
  }
  if ( !thrown ) return;

  // Snapshot before dnd5e reduces the quantity
  const quantity = item.system.quantity ?? 1;
  if ( quantity <= 0 ) return;
  const itemData = singleItemData(item);
  const returning = !!item.system.properties?.has("ret");

  // Hit, miss or fumble?
  const ac = roll.options?.target ?? target.actor?.system?.attributes?.ac?.value;
  const isCrit = !!roll.isCritical;
  const isFumble = !!roll.isFumble;
  const hit = isCrit || (!isFumble && ((ac == null) || (roll.total >= ac)));
  const result = hit ? "hit" : (isFumble ? "fumble" : "miss");

  const style = styleFor(item);
  const from = { x: attacker.center.x, y: attacker.center.y };
  const towardAttacker = Math.atan2(from.y - target.center.y, from.x - target.center.x);
  let to;
  let stuckAngle = null;
  if ( hit ) {
    stuckAngle = towardAttacker + randomBetween(-0.6, 0.6);
    const r = (Math.min(target.w, target.h) / 2) * 0.55;
    to = { x: target.center.x + (Math.cos(stuckAngle) * r), y: target.center.y + (Math.sin(stuckAngle) * r) };
  } else {
    to = computeLanding(attacker, target, result);
  }

  const anim = { sceneId: canvas.scene.id, from, to, img: item.img, style, result, returning };
  const plan = planFlight(from, to, style);
  await broadcast("animate", anim);

  if ( returning ) return;
  if ( !game.users.activeGM ) return ui.notifications.warn(L("Warn.NoGM"));

  // Improvised throw detected by range: dnd5e did not reduce the quantity, so we do it.
  if ( improvised && item.isOwner && actor.items.has(item.id) ) {
    await item.update({ "system.quantity": Math.max(0, quantity - 1) });
  }

  const rotationDeg = Math.round(((plan.finalRotation * 180) / Math.PI) % 360);
  await requestGM("resolveThrow", {
    sceneId: canvas.scene.id,
    targetTokenId: target.id,
    attackerName: attacker.name,
    itemData, result, to, stuckAngle,
    rotationDeg: style === "straight" ? rotationDeg : Math.round(Math.random() * 360)
  }).catch(err => console.error(`${MODULE_ID} |`, err));
}

/** Where a missed weapon lands. */
function computeLanding(attacker, target, result) {
  const t = target.center;
  const dir = Math.atan2(t.y - attacker.center.y, t.x - attacker.center.x);
  const tRad = Math.max(target.w, target.h) / 2;
  const gs = canvas.dimensions.size;
  const rect = canvas.dimensions.sceneRect;
  const backend = CONFIG.Canvas?.polygonBackends?.move;

  for ( let i = 0; i < 16; i++ ) {
    let ang;
    let dist;
    if ( result === "fumble" ) {
      const min = Math.min(setting("fumbleMin"), setting("fumbleMax"));
      const max = Math.max(setting("fumbleMin"), setting("fumbleMax"));
      ang = Math.random() < 0.75 ? dir + randomBetween(-1.0, 1.0) : Math.random() * Math.PI * 2;
      dist = tRad + ftToPx(randomBetween(min, max));
    } else {
      ang = dir + randomBetween(-1.3, 1.3);
      dist = tRad + (gs * 0.25) + (Math.random() * ftToPx(setting("missRadius")));
    }
    if ( i > 8 ) dist *= 0.6;
    let p = { x: t.x + (Math.cos(ang) * dist), y: t.y + (Math.sin(ang) * dist) };
    p = {
      x: Math.clamp(p.x, rect.x + (gs * 0.3), rect.x + rect.width - (gs * 0.3)),
      y: Math.clamp(p.y, rect.y + (gs * 0.3), rect.y + rect.height - (gs * 0.3))
    };
    let blocked = false;
    try {
      blocked = !!backend?.testCollision(t, p, { type: "move", mode: "any" });
    } catch { blocked = false; }
    if ( !blocked ) return p;
  }
  // Fallback: right behind the target
  return { x: t.x + (Math.cos(dir) * (tRad + (gs * 0.3))), y: t.y + (Math.sin(dir) * (tRad + (gs * 0.3))) };
}

broadcastHandlers.animate = data => playThrow(data);

/* ============================================ */
/*  GM side                                     */
/* ============================================ */

async function chat(content) {
  if ( !setting("chatMessages") ) return;
  await ChatMessage.create({ content: `<p>${content}</p>`, speaker: { alias: L("ChatAlias") } });
}

/** Give one piece of an item to an actor, stacking where it makes sense. */
async function giveItem(actor, itemData) {
  const src = itemData.flags?.[MODULE_ID] ?? {};
  const stuckIds = new Set(Object.keys(actor.getFlag(MODULE_ID, "stuck") ?? {}));
  let existing = null;
  if ( src.sourceActorUuid === actor.uuid ) existing = actor.items.get(src.sourceItemId);
  if ( existing && ((existing.name !== itemData.name) || stuckIds.has(existing.id)) ) existing = null;
  existing ??= actor.items.find(i => (i.type === itemData.type) && (i.name === itemData.name) && !stuckIds.has(i.id)
    && (i.img === itemData.img));
  if ( existing ) {
    await existing.update({ "system.quantity": (existing.system.quantity ?? 0) + 1 });
    return existing;
  }
  const data = foundry.utils.deepClone(itemData);
  data.system.quantity = 1;
  const [created] = await actor.createEmbeddedDocuments("Item", [data]);
  return created;
}

/** Remove one piece of an item from an actor. */
async function takeOne(actor, item) {
  const qty = item.system.quantity ?? 1;
  if ( qty > 1 ) await item.update({ "system.quantity": qty - 1 });
  else await item.delete();
}

async function createGroundToken(scene, point, itemData, rotationDeg, droppedBy) {
  const gs = scene.grid.size;
  const size = 0.5;
  const scale = Math.max(0.1, setting("groundSize") / size);
  const modes = CONST.TOKEN_DISPLAY_MODES;
  const data = {
    name: itemData.name,
    x: Math.round(point.x - ((gs * size) / 2)),
    y: Math.round(point.y - ((gs * size) / 2)),
    width: size,
    height: size,
    texture: { src: itemData.img, scaleX: scale, scaleY: scale },
    rotation: ((rotationDeg % 360) + 360) % 360,
    lockRotation: true,
    displayName: modes.HOVER,
    displayBars: modes.NONE,
    disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL,
    bar1: { attribute: null },
    bar2: { attribute: null },
    sight: { enabled: false },
    actorLink: false,
    flags: { [MODULE_ID]: { ground: { itemData, droppedBy: droppedBy ?? null } } }
  };
  const [doc] = await scene.createEmbeddedDocuments("Token", [data]);
  return doc;
}

function getSceneToken(sceneId, tokenId) {
  return game.scenes.get(sceneId)?.tokens.get(tokenId) ?? null;
}

gmHandlers.resolveThrow = async ({ sceneId, targetTokenId, attackerName, itemData, result, to, stuckAngle, rotationDeg }) => {
  const scene = game.scenes.get(sceneId);
  if ( !scene ) return null;
  const tDoc = scene.tokens.get(targetTokenId);
  const tActor = tDoc?.actor;

  if ( (result === "hit") && setting("stickOnHit") && tActor ) {
    const data = foundry.utils.deepClone(itemData);
    const [created] = await tActor.createEmbeddedDocuments("Item", [data]);
    await tActor.setFlag(MODULE_ID, `stuck.${created.id}`, { angle: stuckAngle ?? 0, by: attackerName ?? null });
    await chat(L("Chat.Stuck", { item: itemData.name, target: tDoc.name }));
    return { stuckItemId: created.id };
  }

  // Miss / fumble (or hit without a valid target actor): weapon lands on the ground
  const point = to ?? tDoc?.object?.center ?? { x: tDoc?.x ?? 0, y: tDoc?.y ?? 0 };
  await createGroundToken(scene, point, itemData, rotationDeg ?? 0, attackerName);
  if ( result === "fumble" ) await chat(L("Chat.Fumble", { item: itemData.name, actor: attackerName ?? "?" }));
  return { ground: true };
};

gmHandlers.pickup = async ({ sceneId, tokenId, actorUuid }, userId) => {
  const tDoc = getSceneToken(sceneId, tokenId);
  const ground = tDoc?.getFlag(MODULE_ID, "ground");
  if ( !ground ) return { ok: false, reason: "gone" };
  const actor = await fromUuid(actorUuid);
  const user = game.users.get(userId);
  if ( !actor || !user || !actor.testUserPermission(user, "OWNER") ) return { ok: false, reason: "permission" };
  await tDoc.delete();
  await giveItem(actor, ground.itemData);
  await chat(L("Chat.PickedUp", { actor: actor.name, item: ground.itemData.name }));
  return { ok: true };
};

gmHandlers.pullTake = async ({ sceneId, targetTokenId, itemId, removerActorUuid }, userId) => {
  const tDoc = getSceneToken(sceneId, targetTokenId);
  const tActor = tDoc?.actor;
  const item = tActor?.items.get(itemId);
  if ( !item ) return { ok: false, reason: "gone" };
  const remover = await fromUuid(removerActorUuid);
  const user = game.users.get(userId);
  if ( !remover || !user || !remover.testUserPermission(user, "OWNER") ) return { ok: false, reason: "permission" };
  const data = singleItemData(item);
  const angle = tActor.getFlag(MODULE_ID, `stuck.${itemId}`)?.angle ?? 0;
  await tActor.unsetFlag(MODULE_ID, `stuck.${itemId}`);
  await takeOne(tActor, item);
  const given = await giveItem(remover, data);
  return { ok: true, itemId: given.id, angle };
};

gmHandlers.pullReturn = async ({ sceneId, targetTokenId, removerActorUuid, itemId, angle }) => {
  const tDoc = getSceneToken(sceneId, targetTokenId);
  const tActor = tDoc?.actor;
  const remover = await fromUuid(removerActorUuid);
  const item = remover?.items.get(itemId);
  if ( !tActor || !item ) return { ok: false };
  const data = singleItemData(item);
  await takeOne(remover, item);
  const [created] = await tActor.createEmbeddedDocuments("Item", [data]);
  await tActor.setFlag(MODULE_ID, `stuck.${created.id}`, { angle: angle ?? 0 });
  return { ok: true };
};

gmHandlers.pullDrop = async ({ sceneId, targetTokenId, itemId }) => {
  const scene = game.scenes.get(sceneId);
  const tDoc = scene?.tokens.get(targetTokenId);
  const tActor = tDoc?.actor;
  const item = tActor?.items.get(itemId);
  if ( !item ) return { ok: false };
  const data = singleItemData(item);
  const angle = tActor.getFlag(MODULE_ID, `stuck.${itemId}`)?.angle ?? 0;
  await tActor.unsetFlag(MODULE_ID, `stuck.${itemId}`);
  await takeOne(tActor, item);
  const gs = scene.grid.size;
  const w = (tDoc.width * gs) / 2;
  const h = (tDoc.height * gs) / 2;
  const c = { x: tDoc.x + w, y: tDoc.y + h };
  const d = Math.max(w, h) + (gs * 0.35);
  await createGroundToken(scene, { x: c.x + (Math.cos(angle) * d), y: c.y + (Math.sin(angle) * d) }, data,
    Math.round(Math.random() * 360));
  return { ok: true };
};

gmHandlers.clearStuck = async ({ sceneId, targetTokenId, itemId }) => {
  const tActor = getSceneToken(sceneId, targetTokenId)?.actor;
  if ( tActor ) await tActor.unsetFlag(MODULE_ID, `stuck.${itemId}`);
  return { ok: true };
};

gmHandlers.applyDamage = async ({ sceneId, targetTokenId, damages }) => {
  const tActor = getSceneToken(sceneId, targetTokenId)?.actor;
  if ( !tActor?.applyDamage ) return { ok: false };
  const list = damages.map(d => ({ value: d.value, type: d.type, properties: new Set(d.properties ?? []) }));
  await tActor.applyDamage(list);
  return { ok: true };
};

/** Clean up stale stuck flags when items leave an actor (e.g. looted). Active GM only. */
export function onDeleteItem(item) {
  const actor = item.parent;
  if ( !(actor instanceof Actor) || (game.users.activeGM?.id !== game.user.id) ) return;
  if ( actor.getFlag(MODULE_ID, `stuck.${item.id}`) ) actor.unsetFlag(MODULE_ID, `stuck.${item.id}`);
}

/* ============================================ */
/*  Picking up                                  */
/* ============================================ */

async function pickUp(groundToken) {
  const picker = getActingToken();
  if ( !picker ) return ui.notifications.warn(L("Warn.SelectToken"));
  if ( !game.user.isGM ) {
    const range = setting("pickupRange");
    if ( tokenGapDistance(picker, groundToken) > (range + 0.01) ) {
      return ui.notifications.warn(L("Warn.TooFar", { range }));
    }
  }
  const res = await requestGM("pickup", {
    sceneId: canvas.scene.id, tokenId: groundToken.id, actorUuid: picker.actor.uuid
  }).catch(err => { console.error(err); return null; });
  if ( res && !res.ok && (res.reason === "permission") ) ui.notifications.warn(L("Warn.NoPermission"));
}

/* ============================================ */
/*  Pulling out                                 */
/* ============================================ */

function meleeMode(item) {
  const modes = item.system.attackModes ?? [];
  return modes.find(m => m.value && !m.value.startsWith("thrown") && (m.value !== "ranged"))?.value;
}

async function pullOut(targetToken, itemId) {
  const item = targetToken.actor?.items.get(itemId);
  if ( !item ) return;
  const sceneId = canvas.scene.id;
  const remover = getActingToken();

  // GM without a token of their own: drop it next to the target.
  if ( !remover && game.user.isGM ) {
    return requestGM("pullDrop", { sceneId, targetTokenId: targetToken.id, itemId });
  }
  if ( !remover ) return ui.notifications.warn(L("Warn.SelectToken"));

  // The creature pulls its own weapon out: no attack, item stays in its inventory.
  if ( remover.actor === targetToken.actor ) {
    await requestGM("clearStuck", { sceneId, targetTokenId: targetToken.id, itemId });
    return chatLocal(L("Chat.PulledSelf", { actor: remover.name, item: item.name }));
  }

  if ( !game.user.isGM ) {
    const range = setting("pullRange");
    if ( tokenGapDistance(remover, targetToken) > (range + 0.01) ) {
      return ui.notifications.warn(L("Warn.TooFar", { range }));
    }
  }

  const taken = await requestGM("pullTake", {
    sceneId, targetTokenId: targetToken.id, itemId, removerActorUuid: remover.actor.uuid
  }).catch(err => { console.error(err); return null; });
  if ( !taken?.ok ) {
    if ( taken?.reason === "permission" ) ui.notifications.warn(L("Warn.NoPermission"));
    return;
  }

  let weapon = remover.actor.items.get(taken.itemId);
  for ( let i = 0; !weapon && (i < 20); i++ ) {
    await new Promise(r => setTimeout(r, 50));
    weapon = remover.actor.items.get(taken.itemId);
  }
  await chatLocal(L("Chat.Pulled", { actor: remover.name, item: weapon?.name ?? item.name, target: targetToken.name }));
  const activity = weapon?.system.activities?.getByType?.("attack")?.[0];
  if ( !activity ) return;

  // Make sure the target is targeted, so dnd5e shows hit/miss against its AC
  try { targetToken.setTarget(true, { releaseOthers: true, groupSelection: false }); } catch {}

  const attackMode = meleeMode(weapon);
  let rolls;
  pullingItems.add(weapon.id);
  try {
    rolls = await activity.rollAttack({ attackMode }, { configure: false });
  } finally {
    pullingItems.delete(weapon.id);
  }
  const roll = rolls?.[0];
  if ( !roll ) return;

  const ac = roll.options?.target ?? targetToken.actor?.system?.attributes?.ac?.value;
  const hit = roll.isCritical || (!roll.isFumble && ((ac == null) || (roll.total >= ac)));

  if ( hit ) {
    const dmg = await activity.rollDamage({ isCritical: roll.isCritical, attackMode }, { configure: false });
    if ( dmg?.length && setting("pullAutoDamage") ) {
      await requestGM("applyDamage", {
        sceneId, targetTokenId: targetToken.id,
        damages: dmg.map(r => ({ value: r.total, type: r.options?.type, properties: [...(r.options?.properties ?? [])] }))
      });
    }
  } else if ( setting("pullStaysOnMiss") ) {
    await requestGM("pullReturn", {
      sceneId, targetTokenId: targetToken.id, removerActorUuid: remover.actor.uuid, itemId: taken.itemId, angle: taken.angle
    });
    ui.notifications.info(L("Chat.StillStuck", { item: weapon.name }));
  }
}

async function chatLocal(content) {
  if ( !setting("chatMessages") ) return;
  await ChatMessage.create({ content: `<p>${content}</p>`, speaker: { alias: L("ChatAlias") } });
}

/* ============================================ */
/*  Double-click handling on the canvas          */
/* ============================================ */

function groundTokenAt(point) {
  const hits = canvas.tokens.placeables.filter(t => isGroundToken(t) && t.visible && !t.document.hidden
    && (Math.hypot(point.x - t.center.x, point.y - t.center.y) <= Math.max(t.w, t.h, canvas.dimensions.size * 0.35) / 2));
  return hits.at(-1) ?? null;
}

function hitAt(point) {
  const stuck = stuckIconAt(point);
  if ( stuck ) return { kind: "stuck", ...stuck };
  const ground = groundTokenAt(point);
  if ( ground ) return { kind: "ground", token: ground };
  return null;
}

/** Whether we take over clicks on this hit (players always; the GM only while acting with a token). */
function shouldIntercept(hit) {
  if ( !game.user.isGM ) return true;
  if ( hit.kind === "stuck" ) return true;
  return !!getActingToken();
}

let lastDown = { t: 0, x: 0, y: 0 };
let swallowUp = false;

function canvasElement() {
  return canvas?.app?.canvas ?? canvas?.app?.view ?? null;
}

function onPointerDown(event) {
  if ( (event.button !== 0) || !canvas?.ready || (event.target !== canvasElement()) ) return;
  let point;
  try { point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY }); }
  catch { point = canvas.stage.worldTransform.applyInverse({ x: event.clientX, y: event.clientY }); }
  const hit = hitAt(point);
  if ( !hit || !shouldIntercept(hit) ) { lastDown = { t: 0, x: 0, y: 0 }; return; }

  // Keep Foundry from selecting / opening sheets for these clicks
  event.stopImmediatePropagation();
  event.preventDefault();
  swallowUp = true;

  const now = performance.now();
  const isDouble = ((now - lastDown.t) < 400) && (Math.hypot(event.clientX - lastDown.x, event.clientY - lastDown.y) < 14);
  lastDown = isDouble ? { t: 0, x: 0, y: 0 } : { t: now, x: event.clientX, y: event.clientY };
  if ( !isDouble ) return;

  if ( hit.kind === "ground" ) pickUp(hit.token);
  else pullOut(hit.token, hit.itemId);
}

function onPointerUp(event) {
  if ( !swallowUp || (event.button !== 0) ) return;
  swallowUp = false;
  if ( event.target === canvasElement() ) event.stopImmediatePropagation();
}

export function registerInput() {
  window.addEventListener("pointerdown", onPointerDown, { capture: true });
  window.addEventListener("pointerup", onPointerUp, { capture: true });
}

export { getStuckEntries };
