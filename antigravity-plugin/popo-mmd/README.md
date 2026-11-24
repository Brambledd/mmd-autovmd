# PoPo MMD Antigravity Plugin (Headless / No Right Sidebar)

This directory contains the Antigravity plugin definition for **PoPo MMD Workbench** (`popo-mmd`), exposing the 9 PoPo MCP tools (single-actor & duo choreography, analytical IK, per-frame ground-contact bake, orthographic PNG storyboards) and the `popo-blender-mmd` hybrid Skill without requiring DSH or the embedded `dsh-stage` right sidebar.

## Prerequisites

- **Node.js ≥ 22.18** (or Node 24/26+, supporting native TypeScript execution for `node src/mcp/popo-mcp-server.ts`).
- `.pmx` models placed under `<POPO_ROOT>/public/models/<modelId>/` (or pass `pmxPath` explicitly to MCP tools).
- *(Optional)* **Blender 4.2+ with `mmd_tools`** (either via a Blender MCP server or `blender -b --python <script.py>`) for Stage 2 mesh/cloth polish.

## Install into Antigravity

Copy this folder to `~/.gemini/config/plugins/popo-mmd/`, create `mcp_config.json` from `mcp_config.example.json` replacing `<POPO_ROOT>` with your absolute clone path (e.g. `E:/PoPo`), and copy `<POPO_ROOT>/.agents/skills/popo-blender-mmd/SKILL.md` into `~/.gemini/config/plugins/popo-mmd/skills/popo-blender-mmd/SKILL.md` if you want the workflow available outside the repository directory.
