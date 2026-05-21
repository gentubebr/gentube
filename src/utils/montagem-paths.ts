import path from "node:path";
import type { MontagemConfig } from "../config/montagem.js";

export function montagemRoot(projectPath: string, cfg: MontagemConfig): string {
  return path.join(projectPath, cfg.montagemDir);
}

export function montagemScenesDir(projectPath: string, blockNumber: number, cfg: MontagemConfig): string {
  const pad = String(blockNumber).padStart(2, "0");
  return path.join(montagemRoot(projectPath, cfg), cfg.scenesSubdir, `block${pad}`);
}

export function montagemBlocksDir(projectPath: string, cfg: MontagemConfig): string {
  return path.join(montagemRoot(projectPath, cfg), cfg.blocksSubdir);
}

export function narrationSceneMp3(projectPath: string, blockNumber: number, sceneId: string): string {
  const pad = String(blockNumber).padStart(2, "0");
  return path.join(projectPath, "02 - Narracao", `block${pad}`, `${sceneId}.mp3`);
}

export function rendersBlockDir(projectPath: string, blockNumber: number): string {
  const pad = String(blockNumber).padStart(2, "0");
  return path.join(projectPath, "03 - Imagens e Videos", "renders", `block${pad}`);
}

export function assetsJsonPath(projectPath: string, blockNumber: number): string {
  const pad = String(blockNumber).padStart(2, "0");
  return path.join(projectPath, "03 - Imagens e Videos", `block${pad}.assets.json`);
}

export function segmentFileName(blockNumber: number, firstId: string, lastId: string): string {
  const pad = String(blockNumber).padStart(2, "0");
  if (firstId === lastId) return `block${pad}_${firstId}.mp4`;
  return `block${pad}_${firstId}-${lastId}.mp4`;
}

export function fullBlockFileName(blockNumber: number): string {
  return `block${String(blockNumber).padStart(2, "0")}.mp4`;
}

export function blockErrFileName(blockNumber: number): string {
  return `block${String(blockNumber).padStart(2, "0")}.err.txt`;
}

export function blockAssemblyJsonName(blockNumber: number): string {
  return `block${String(blockNumber).padStart(2, "0")}.assembly.json`;
}
