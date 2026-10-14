import { setting, loadTex } from "./config.mjs";

const SPIN_RATE = { spin: 2.4, fastSpin: 4.2, straight: 0 }; // rotations per second

/** Flight duration in ms for a given distance in px. */
export function flightDuration(distPx) {
  const gs = canvas.dimensions.size;
  const speed = Math.max(1, setting("flightSpeed")) * gs; // px per second
  return Math.clamp(Math.round((distPx / speed) * 1000), 220, 1600);
}

const deg2rad = d => (d * Math.PI) / 180;

/** Sprite rotation (rad) that makes the weapon's point face `dir`. */
export function pointRotation(dir) {
  return dir + deg2rad(setting("iconAngle"));
}

/**
 * Compute everything both the thrower and observers need to show the same flight.
 * @returns {{duration:number, finalRotation:number, spinDir:number}}
 */
export function planFlight(from, to, style) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const duration = flightDuration(dist);
  const dir = Math.atan2(to.y - from.y, to.x - from.x);
  const spinDir = (to.x >= from.x) ? 1 : -1;
  const turns = (SPIN_RATE[style] ?? 0) * (duration / 1000);
  const finalRotation = pointRotation(dir) + (spinDir * turns * Math.PI * 2);
  return { duration, finalRotation, spinDir, dir, dist };
}

/**
 * Play a throw animation on this client.
 * @param {object} data
 * @param {string} data.sceneId
 * @param {{x:number,y:number}} data.from
 * @param {{x:number,y:number}} data.to
 * @param {string} data.img
 * @param {"straight"|"spin"|"fastSpin"} data.style
 * @param {"hit"|"miss"|"fumble"} data.result
 * @param {boolean} [data.returning]
 * @returns {Promise<void>} resolves when the weapon arrives (or returns)
 */
export async function playThrow(data) {
  const plan = planFlight(data.from, data.to, data.style);
  const total = data.returning ? plan.duration * 2 : plan.duration;
  if ( !canvas?.ready || (canvas.scene?.id !== data.sceneId) || !setting("animate") ) {
    return new Promise(r => setTimeout(r, total));
  }

  let tex;
  try { tex = await loadTex(data.img); } catch { tex = null; }
  if ( !tex ) return new Promise(r => setTimeout(r, total));

  const gs = canvas.dimensions.size;
  const layer = canvas.interface ?? canvas.tokens;
  const container = new PIXI.Container();
  container.eventMode = "none";
  container.zIndex = 10000;

  const shadow = new PIXI.Graphics();
  shadow.beginFill(0x000000, 0.28).drawEllipse(0, 0, gs * 0.22, gs * 0.09).endFill();
  const sprite = new PIXI.Sprite(tex);
  sprite.anchor.set(0.5);
  const size = gs * 0.6;
  const baseScale = size / Math.max(tex.width, tex.height, 1);
  sprite.scale.set(baseScale);
  container.addChild(shadow, sprite);
  layer.addChild(container);

  const arc = Math.min(plan.dist * 0.18, gs * 0.9);
  const startRot = pointRotation(plan.dir);

  const leg = (from, to, rotFrom, rotTo, duration) => new Promise(resolve => {
    const t0 = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - t0) / duration);
      const x = from.x + ((to.x - from.x) * t);
      const y = from.y + ((to.y - from.y) * t);
      const h = Math.sin(Math.PI * t) * arc;
      shadow.position.set(x, y);
      shadow.alpha = 1 - (0.5 * Math.sin(Math.PI * t));
      sprite.position.set(x, y - h);
      sprite.scale.set(baseScale * (1 + (0.25 * Math.sin(Math.PI * t))));
      sprite.rotation = rotFrom + ((rotTo - rotFrom) * t);
      if ( t >= 1 ) {
        canvas.app.ticker.remove(tick);
        resolve();
      }
    };
    canvas.app.ticker.add(tick);
  });

  try {
    await leg(data.from, data.to, startRot, plan.finalRotation, plan.duration);
    if ( data.result !== "recall" ) impactEffect(data.to, data.result);
    if ( data.returning ) {
      await leg(data.to, data.from, plan.finalRotation, plan.finalRotation + (plan.finalRotation - startRot),
        plan.duration);
    }
  } finally {
    container.destroy({ children: true });
  }
}

/** Small burst (hit) or dust puff (miss) at the impact point. */
function impactEffect(point, result) {
  if ( !canvas?.ready ) return;
  const gs = canvas.dimensions.size;
  const layer = canvas.interface ?? canvas.tokens;
  const g = new PIXI.Graphics();
  g.eventMode = "none";
  g.position.set(point.x, point.y);
  layer.addChild(g);

  const isHit = result === "hit";
  const puffs = isHit ? [] : Array.from({ length: 6 }, () => ({
    a: Math.random() * Math.PI * 2, d: 0.15 + (Math.random() * 0.2), r: 0.05 + (Math.random() * 0.05)
  }));
  const duration = isHit ? 320 : 520;
  const t0 = performance.now();
  const tick = () => {
    const t = Math.min(1, (performance.now() - t0) / duration);
    g.clear();
    if ( isHit ) {
      g.lineStyle(gs * 0.05 * (1 - t), 0xb3261e, 0.9 * (1 - t));
      g.drawCircle(0, 0, gs * (0.1 + (0.35 * t)));
    } else {
      for ( const p of puffs ) {
        g.beginFill(0x8a7a5c, 0.55 * (1 - t));
        g.drawCircle(Math.cos(p.a) * p.d * gs * (0.4 + t), Math.sin(p.a) * p.d * gs * (0.4 + t), p.r * gs * (1 + t));
        g.endFill();
      }
    }
    if ( t >= 1 ) {
      canvas.app.ticker.remove(tick);
      g.destroy();
    }
  };
  canvas.app.ticker.add(tick);
}
