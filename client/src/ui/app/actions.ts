import type { Action } from "svelte/action";

/**
 * Re-play a CSS keyframe animation whenever `dep` changes. The engine bumps a
 * counter store on the frame a combo lands / a KO flashes / the center banner
 * changes; this action restarts the matching class so the animation fires again
 * (the classic remove → reflow → add trick). Skips the initial value so nothing
 * animates on first mount.
 */
export const retrigger: Action<HTMLElement, { cls: string; dep: unknown }> = (node, params) => {
  let last = params.dep;
  return {
    update(p) {
      if (p.dep !== last) {
        last = p.dep;
        node.classList.remove(p.cls);
        void node.offsetWidth; // force reflow so the animation replays
        node.classList.add(p.cls);
      }
    },
  };
};

/** Focus the node once it mounts (modals that must catch Esc / arrow keys). */
export const focusOnMount: Action<HTMLElement> = (node) => {
  node.focus();
};
