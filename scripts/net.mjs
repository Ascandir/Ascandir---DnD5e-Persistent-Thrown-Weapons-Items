import { SOCKET, L } from "./config.mjs";

/** Handlers that run on the active GM's client. Filled by actions.mjs. */
export const gmHandlers = {};

/** Handlers that run on every client when broadcast. */
export const broadcastHandlers = {};

const pending = new Map();

/**
 * Ask the active GM to perform an action. If this user is the GM, it runs locally.
 * @returns {Promise<any>}
 */
export async function requestGM(action, data) {
  const handler = gmHandlers[action];
  if ( !handler ) throw new Error(`Unknown action ${action}`);
  if ( game.user.isGM ) return handler(data, game.user.id);
  const gm = game.users.activeGM;
  if ( !gm ) {
    ui.notifications.warn(L("Warn.NoGM"));
    return null;
  }
  const id = foundry.utils.randomID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for GM (${action})`));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    game.socket.emit(SOCKET, { type: "request", id, action, data, userId: game.user.id, gmId: gm.id });
  });
}

/** Run something on all clients (including this one). */
export function broadcast(action, data) {
  game.socket.emit(SOCKET, { type: "broadcast", action, data });
  return broadcastHandlers[action]?.(data);
}

export function registerSocket() {
  game.socket.on(SOCKET, async msg => {
    if ( !msg?.type ) return;

    if ( msg.type === "broadcast" ) {
      try { await broadcastHandlers[msg.action]?.(msg.data); } catch(err) { console.error(err); }
      return;
    }

    if ( (msg.type === "request") && (msg.gmId === game.user.id) ) {
      let result = null;
      let error = null;
      try { result = await gmHandlers[msg.action]?.(msg.data, msg.userId); }
      catch(err) { console.error(err); error = err?.message ?? String(err); }
      game.socket.emit(SOCKET, { type: "response", id: msg.id, userId: msg.userId, result, error });
      return;
    }

    if ( (msg.type === "response") && (msg.userId === game.user.id) ) {
      const p = pending.get(msg.id);
      if ( !p ) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if ( msg.error ) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  });
}
