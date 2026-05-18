import fs from "node:fs/promises";
import path from "node:path";

export async function sceneRenderOutputExists(
  rendersDir: string,
  sceneId: string,
  type: "image" | "video"
): Promise<boolean> {
  const exts = type === "image" ? [".jpg", ".jpeg", ".png", ".webp"] : [".mp4", ".mov"];
  for (const ext of exts) {
    try {
      await fs.access(path.join(rendersDir, `${sceneId}${ext}`));
      return true;
    } catch {
      /* ausente */
    }
  }
  return false;
}
