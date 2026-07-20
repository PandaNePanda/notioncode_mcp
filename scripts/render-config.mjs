#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const [source, destination, projectRoot, userHome, serviceUser = ""] = process.argv.slice(2);
if (!source || !destination || !projectRoot || !userHome) {
  throw new Error("usage: render-config.mjs <source> <destination> <project-root> <user-home>");
}

const portable = (value) => {
  const normalized = value.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) {
    return normalized;
  }
  return path.resolve(value).replaceAll("\\", "/");
};
const rendered = fs.readFileSync(source, "utf8")
  .replaceAll("__NOTIONCODE_ROOT__", portable(projectRoot))
  .replaceAll("__USER_HOME__", portable(userHome))
  .replaceAll("__SERVICE_USER__", serviceUser);

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, rendered, "utf8");
