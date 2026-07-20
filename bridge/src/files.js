import { chmod, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export async function atomicWriteJson(filePath, value, options = {}) {
  const mode = options.mode ?? 0o600;
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = `${filePath}.tmp`;
  const handle = await open(temporary, "w", mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await chmod(temporary, mode);
  await rename(temporary, filePath);
}

export async function removeIfPresent(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function modifiedTimeMs(filePath) {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
