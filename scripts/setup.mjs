#!/usr/bin/env node
// One-time setup: seed the risk profile and register the MCP server with Claude
// Code. Safe to re-run; it never overwrites an existing profile and never adds
// a second MCP entry.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_NAME = "link-risk-gateway";
const SERVER_PATH = join(ROOT, "dist", "bin", "gateway.js");
const EXAMPLE_PROFILE = join(ROOT, "examples", "risk-profile.yaml");

const profilePath = resolve(
  process.env.LINK_RISK_PROFILE ?? join(homedir(), ".link-risk-gateway", "risk-profile.yaml"),
);

const done = [];
const todo = [];

// 1. Risk profile. Never overwrite: it holds the user's own limits.
if (existsSync(profilePath)) {
  done.push(`Kept your existing risk profile at ${profilePath}`);
} else {
  mkdirSync(dirname(profilePath), { recursive: true });
  copyFileSync(EXAMPLE_PROFILE, profilePath);
  done.push(`Wrote a starter risk profile to ${profilePath}`);
}

// 2. MCP registration. Needs the build output, since the entry is a path.
if (!existsSync(SERVER_PATH)) {
  todo.push("Run `npm run build`, then re-run `npm run setup` to register the MCP server.");
} else {
  const list = spawnSync("claude", ["mcp", "list"], { encoding: "utf8" });

  if (list.error) {
    todo.push(
      "Claude Code's `claude` command wasn't found. Once it's installed, register the server with:\n" +
        `    claude mcp add ${MCP_NAME} -- node ${SERVER_PATH}`,
    );
  } else if (list.stdout.includes(`${MCP_NAME}:`)) {
    done.push(`${MCP_NAME} is already registered with Claude Code`);
  } else {
    const add = spawnSync("claude", ["mcp", "add", MCP_NAME, "--", "node", SERVER_PATH], {
      encoding: "utf8",
    });

    if (add.status === 0) {
      done.push(`Registered ${MCP_NAME} with Claude Code (this project only)`);
    } else {
      todo.push(
        `Registering the MCP server failed: ${(add.stderr || add.stdout || "").trim()}\n` +
          `    Run it yourself with: claude mcp add ${MCP_NAME} -- node ${SERVER_PATH}`,
      );
    }
  }
}

// 3. Steps that can't be automated, reported so the list is complete.
todo.push("Connect your Link account in your own terminal: npx link-cli auth login");
todo.push('Close Claude\'s direct paths to link-cli. See "Keep Claude off the direct Link path" in the README.');

for (const line of done) process.stdout.write(`  done  ${line}\n`);
process.stdout.write("\n");
for (const line of todo) process.stdout.write(`  next  ${line}\n`);
