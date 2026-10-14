import { MODULE_ID, L, setting, styleFor, isEligibleWeapon, tokenForActor, singleItemData, boundOf } from "./config.mjs";
import { requestGM, broadcast, gmHandlers } from "./net.mjs";
import { giveItem, takeOne, chat } from "./actions.mjs";

/* ============================================ */
/*  Binding (item context menu)                 */
/* ============================================ */

async function toggleBond(item) {
  if ( boundOf(item) ) {
    await item.unsetFlag(MODULE_ID, "bound");
    return ui.notifications.info(L("Bound.Unbound", { item: item.name }));
  }
  await item.setFlag(MODULE_ID, "bound", { key: foundry.utils.randomID(), ownerUuid: item.actor?.uuid ?? null });
  ui.notifications.info(L("Bound.Bound", { item: item.name, actor: item.actor?.name ?? "?" }));
}

function addContextOptions(item, options) {
  if ( !item?.isOwner || (item.type !== "weapon") || !item.actor || !isEligibleWeapon(item) ) return;
  const bound = !!boundOf(item);
  options.push({
    label: bound ? L("Bound.Unbind") : L("Bound.Bind"),
    icon: bound ? "fa-solid fa-link-slash" : "fa-solid fa-link",
    visible: () => true,
    onClick: () => toggleBond(item)
  });
}

/* ============================================ */
/*  Recall                                      */
/* ============================================ */

/** Recall a bound weapon of an actor (client side). */
export async function recall(actor, key) {
  if ( !actor?.isOwner ) return ui.notifications.warn(L("Warn.NoPermission"));
  const entry = actor.getFlag(MODULE_ID, `boundAway.${key}`) ?? {};
  const token = canvas?.ready ? tokenForActor(actor) : null;
  const res = await requestGM("recall", {
    actorUuid: actor.uuid, key, sceneId: canvas.scene?.id ?? null, tokenId: token?.id ?? null
  }).catch(err => { console.error(err); return null; });
  if ( res?.ok === false && (res.reason === "notFound") ) {
    await actor.unsetFlag(MODULE_ID, `boundAway.${key}`);
    ui.notifications.warn(L("Bound.NotFound", { item: entry.name ?? "?" }));
  } else if ( res?.ok === false && (res.reason === "permission") ) {
    ui.notifications.warn(L("Warn.NoPermission"));
  }
}

function docCenter(tDoc) {
  const gs = tDoc.parent.grid.size;
  return { x: tDoc.x + ((tDoc.width * gs) / 2), y: tDoc.y + ((tDoc.height * gs) / 2) };
}

/** Find where a bound weapon is right now (GM side). Never on the owner itself. */
function findBound(key, owner) {
  const matches = data => boundOf(data)?.key === key;
  const isOwner = a => a && ((a === owner) || (a.uuid === owner.uuid) || (!a.isToken && (a.id === owner.id)));

  // 1. On a scene: lying on the ground, or stuck in / carried by an unlinked token
  for ( const scene of game.scenes ) {
    for ( const tDoc of scene.tokens ) {
      const ground = tDoc.flags?.[MODULE_ID]?.ground;
      if ( ground?.itemData && matches(ground.itemData) ) return { kind: "ground", scene, tDoc, itemData: ground.itemData };
      if ( tDoc.actorLink ) continue;
      const a = tDoc.actor;
      if ( !a || isOwner(a) ) continue;
      const item = a.items.find(i => matches(i));
      if ( item ) return { kind: "actor", scene, tDoc, actor: a, item };
    }
  }

  // 2. Carried by a world actor (looted, picked up by someone else …)
  for ( const a of game.actors ) {
    if ( isOwner(a) ) continue;
    const item = a.items.find(i => matches(i));
    if ( !item ) continue;
    const tDoc = a.getActiveTokens?.(false, true)?.[0] ?? null;
    return { kind: "actor", scene: tDoc?.parent ?? null, tDoc, actor: a, item };
  }
  return null;
}

gmHandlers.recall = async ({ actorUuid, key, sceneId, tokenId }, userId) => {
  const owner = await fromUuid(actorUuid);
  const user = game.users.get(userId);
  if ( !owner || !user || !owner.testUserPermission(user, "OWNER") ) return { ok: false, reason: "permission" };

  const found = findBound(key, owner);
  if ( !found ) return { ok: false, reason: "notFound" };

  // Take it away from where it is
  let data;
  if ( found.kind === "ground" ) {
    data = foundry.utils.deepClone(found.itemData);
    await found.tDoc.delete();
  } else {
    data = singleItemData(found.item);
    if ( found.tDoc?.getFlag(MODULE_ID, `stuck.${found.item.id}`) ) await found.tDoc.unsetFlag(MODULE_ID, `stuck.${found.item.id}`);
    await takeOne(found.actor, found.item);
  }

  // Fly back into the hand (only when both are on the scene the owner is on)
  const ownerDoc = sceneId && tokenId ? game.scenes.get(sceneId)?.tokens.get(tokenId) : null;
  if ( ownerDoc && found.tDoc && (found.scene?.id === sceneId) ) {
    await broadcast("animate", {
      sceneId, from: docCenter(found.tDoc), to: docCenter(ownerDoc),
      img: data.img, style: styleFor({ name: data.name }), result: "recall", returning: false
    });
  }

  await giveItem(owner, data);
  if ( owner.getFlag(MODULE_ID, `boundAway.${key}`) ) await owner.unsetFlag(MODULE_ID, `boundAway.${key}`);
  const bonus = setting("recallBonusAction") ? L("Chat.BonusAction") : "";
  await chat(L("Chat.Recalled", { actor: ownerDoc?.name ?? owner.name, item: data.name }) + bonus);
  return { ok: true };
};

/* ============================================ */
/*  Token HUD button                            */
/* ============================================ */

function onRenderTokenHUD(hud, html) {
  const token = hud.object;
  const actor = token?.actor;
  if ( !actor?.isOwner ) return;
  const away = Object.entries(actor.getFlag(MODULE_ID, "boundAway") ?? {});
  if ( !away.length ) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const col = root?.querySelector(".col.right") ?? root?.querySelector(".right");
  if ( !col ) return;
  for ( const [key, entry] of away ) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add("control-icon", "aptw-recall");
    btn.dataset.tooltip = L("Bound.Recall", { item: entry.name ?? "?" });
    btn.innerHTML = `<img src="${entry.img ?? "icons/svg/sword.svg"}" width="36" height="36" alt="">`;
    btn.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      btn.disabled = true;
      try { await recall(actor, key); } finally { hud.render?.(); }
    });
    col.appendChild(btn);
  }
}

export function registerRecall() {
  Hooks.on("dnd5e.getItemContextOptions", (item, options) => addContextOptions(item, options));
  Hooks.on("renderTokenHUD", (hud, html) => onRenderTokenHUD(hud, html));
  const mod = game.modules.get(MODULE_ID);
  if ( mod ) mod.api = { ...(mod.api ?? {}), recall };
}
