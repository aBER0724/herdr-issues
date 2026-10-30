import * as fs from "fs/promises";
import { appHome } from "herdr";

// Herdr draws icons only from real folders, and this mod's folder may be a
// symlink to its git checkout: they're written to its data folder instead.
const SVG = (paths) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICONS = {
  issue: SVG(`<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>`),
  refresh: SVG(`<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>`),
};

let written = null;

// Resolves once the icons are on disk; draw them only after that.
export function icons() {
  written ??= (async () => {
    const dir = `${appHome()}/data/issues/icons`;
    await fs.mkdir(dir, { recursive: true });
    for (const [name, svg] of Object.entries(ICONS)) await fs.writeFile(`${dir}/${name}.svg`, svg);
  })();
  return written;
}

export const icon = (name) => `data/issues/icons/${name}.svg`;
