import * as fs from "fs/promises";
import { appHome, exec } from "herdr";
import { dimensions } from "./pictures.js";

// The picture the comment box is about to take, when it is a file rather than a
// link: a file dropped on the box or an image the clipboard holds. It is kept
// in this mod's data folder, where `image()` can draw it and where gh can read
// it, and measured from its own header so the row can show its shape.

const EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|avif)$/i;
export const isImage = (path) => EXT.test(String(path ?? ""));

const folder = () => `${appHome()}/data/issues/images`;
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const nameOf = (path) => (String(path ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "image").replace(/[^\w.-]+/g, "-");

// { rel, file, name, width, height } for a file on this computer's disk, copied
// into the data folder; null when it can't be read.
export async function keep(path) {
  const bytes = await fs.readFile(path).catch(() => null);
  if (!bytes) return null;
  const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? "png").toLowerCase().replace(/^jpe?g$/, "jpg");
  const rel = `data/issues/images/image-${stamp()}.${ext}`;
  await fs.mkdir(folder(), { recursive: true });
  await fs.writeFile(`${appHome()}/${rel}`, bytes);
  const size = dimensions(bytes);
  return { rel, file: `${appHome()}/${rel}`, name: nameOf(path), width: size?.width ?? null, height: size?.height ?? null };
}

// The clipboard's image, written as a PNG at `${appHome()}/${rel}` and returned
// as `keep()` returns one; null when the clipboard holds no picture. macOS keeps
// one as PNG or as TIFF, which sips turns into a PNG; Linux goes through xclip.
export async function fromClipboard(rel) {
  const file = `${appHome()}/${rel}`;
  await fs.mkdir(folder(), { recursive: true });
  // macOS first, then Linux: whichever has nothing to say leaves `made` false.
  let made = false;
  const script = (cls) => [
    "on run argv",
    "set out to POSIX file (item 1 of argv)",
    "try",
    `set d to the clipboard as «class ${cls}»`,
    "on error",
    "return \"\"",
    "end try",
    "set fh to open for access out with write permission",
    "set eof fh to 0",
    "write d to fh",
    "close access fh",
    "return \"ok\"",
    "end run",
  ];
  const write = async (cls, to) => {
    const r = await exec("osascript", [...script(cls).flatMap((line) => ["-e", line]), "--", to]).catch(() => null);
    return r?.code === 0 && r.stdout.trim() === "ok";
  };
  made = await write("PNGf", file);
  if (!made) {
    const tiff = `${file}.tiff`;
    if (await write("TIFF", tiff)) {
      const r = await exec("sips", ["-s", "format", "png", tiff, "--out", file]).catch(() => null);
      made = r?.code === 0;
      await fs.rm(tiff, { force: true });
    }
  }
  if (!made) {
    const r = await exec("sh", ["-c", 'xclip -selection clipboard -t image/png -o > "$1"', "sh", file]).catch(() => null);
    made = r?.code === 0;
  }
  const bytes = made ? await fs.readFile(file).catch(() => null) : null;
  const size = bytes?.length ? dimensions(bytes) : null;
  if (!size?.width) { await fs.rm(file, { force: true }); return null; }
  return { rel, file, name: nameOf(rel), width: size.width, height: size.height };
}

// A file becomes a URL the platforms can fetch: `gh gist create` puts it in a
// secret gist on the person's own GitHub account and prints the link, whose raw
// form — `/raw` with no file named is the newest file of the gist, and there is
// only one — is the one markdown reads. It runs on this computer, where the file
// is: the token is this one's, as the panel's own reads fall back to it.
export async function upload({ file }) {
  const r = await exec("gh", ["gist", "create", "--desc", "Screenshot for an issue comment", file]);
  const link = /https:\/\/gist\.github\.com\/([\w-]+)\/([0-9a-f]+)/.exec(r.stdout ?? "");
  if (r.code !== 0 || !link) {
    const said = `${r.stderr}\n${r.stdout}`.trim().split("\n").map((line) => line.trim()).filter(Boolean);
    throw new Error(said.at(-1) ?? "gh could not make a gist");
  }
  return `https://gist.githubusercontent.com/${link[1]}/${link[2]}/raw`;
}
