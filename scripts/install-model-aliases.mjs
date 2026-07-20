#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const [templatePath, destinationPath] = process.argv.slice(2);
if (!templatePath || !destinationPath) {
  throw new Error("usage: install-model-aliases.mjs <template> <destination>");
}

const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
let installed = {};
if (fs.existsSync(destinationPath)) {
  installed = JSON.parse(fs.readFileSync(destinationPath, "utf8"));
}
installed.friendly_aliases = {
  ...(installed.friendly_aliases || {}),
  ...(template.friendly_aliases || {}),
};
installed.updated_at = template.updated_at;

fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
fs.writeFileSync(destinationPath, `${JSON.stringify(installed, null, 2)}\n`, "utf8");
