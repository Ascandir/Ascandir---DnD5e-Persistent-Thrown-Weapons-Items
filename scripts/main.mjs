import { MODULE_ID, L, setting, registerSettings, isEligibleWeapon, rememberActingToken } from "./config.mjs";
import { registerSocket } from "./net.mjs";
import { registerOverlayHooks, refreshAllHighlights } from "./overlay.mjs";
import { registerRecall } from "./recall.mjs";
import { onRollAttack, onPreRollAttack, onPostRollAttack, onDeleteItem, registerInput, onRenderChatMessage } from "./actions.mjs";

Hooks.once("init", () => {
  registerSettings();
});

/**
 * Give every eligible melee weapon without the "Thrown" property an extra
 * "Thrown (improvised)" attack mode. It uses dnd5e's own "thrown" mode, so dnd5e
 * treats it as a ranged attack and reduces the quantity by one.
 */
function patchAttackModes() {
  if ( !setting("improvisedThrow") ) return;
  const WeaponData = CONFIG.Item.dataModels?.weapon;
  if ( !WeaponData ) return console.warn(`${MODULE_ID} | WeaponData not found, improvised throws disabled.`);
  let proto = WeaponData.prototype;
  let desc;
  while ( proto && !(desc = Object.getOwnPropertyDescriptor(proto, "attackModes")) ) proto = Object.getPrototypeOf(proto);
  if ( !desc?.get ) return console.warn(`${MODULE_ID} | attackModes getter not found.`);
  const original = desc.get;
  Object.defineProperty(WeaponData.prototype, "attackModes", {
    configurable: true,
    get() {
      const modes = original.call(this);
      try {
        if ( (this.attackType === "melee") && !this.properties?.has("thr") && isEligibleWeapon(this)
          && !modes.some(m => m.value?.startsWith?.("thrown")) ) {
          if ( modes.length ) modes.push({ rule: true });
          modes.push({ value: "thrown", label: L("ImprovisedThrow") });
        }
      } catch(err) {
        console.error(`${MODULE_ID} |`, err);
      }
      return modes;
    }
  });
}

Hooks.once("setup", () => {
  patchAttackModes();
  registerOverlayHooks();
  registerRecall();
  globalThis.aptwRefreshHighlights = refreshAllHighlights;
});

Hooks.on("renderChatMessageHTML", (message, html) => onRenderChatMessage(message, html));

Hooks.once("ready", () => {
  registerSocket();
  registerInput();
  Hooks.on("dnd5e.rollAttack", (rolls, data) => {
    onRollAttack(rolls, data).catch(err => console.error(`${MODULE_ID} |`, err));
  });
  Hooks.on("dnd5e.preRollAttackV2", config => onPreRollAttack(config));
  Hooks.on("dnd5e.postRollAttack", (rolls, data) => onPostRollAttack(rolls, data));
  Hooks.on("deleteItem", item => onDeleteItem(item));
  Hooks.on("controlToken", (token, controlled) => rememberActingToken(token, controlled));
  console.log(`${MODULE_ID} | ready`);
});
