#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveConfig } from "../config.js";
import { launchEditor } from "../editor/launch.js";

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    port: { type: "string", default: "4319" },
    "no-open": { type: "boolean", default: false },
  },
});

// Both src/bin and dist/bin sit two levels below the project root.
const staticDir = fileURLToPath(new URL("../../dist/editor-ui", import.meta.url));
if (!existsSync(staticDir)) {
  console.error(`Editor UI not built. Run "npm run build" first (looked in ${staticDir}).`);
  process.exit(1);
}

const { profilePath } = resolveConfig({ profilePath: values.profile });
const stopSignal = new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});

try {
  const { savedPolicyVersion } = await launchEditor({
    profilePath,
    staticDir,
    port: Number(values.port),
    noOpen: values["no-open"],
    stopSignal,
  });
  console.log(
    savedPolicyVersion
      ? `Editor closed. Saved changes are live (policy ${savedPolicyVersion}).`
      : "Editor closed. No changes were saved.",
  );
  process.exit(0);
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  console.error(
    e.code === "EADDRINUSE"
      ? `Port ${values.port} is in use. Is the editor already open? Otherwise try --port <n>.`
      : `Editor failed: ${e.message}`,
  );
  process.exit(1);
}
