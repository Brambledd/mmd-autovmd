# PoPo MMD Antigravity Plugin (Headless / No Right Sidebar)

This directory contains the Antigravity plugin definition for **PoPo MMD Workbench** (`popo-mmd`), exposing all 12 PoPo MCP tools (single-actor & duo choreography, analytical IK, per-frame ground-contact bake, orthographic PNG storyboards, plus built-in local Blender GUI control via `get_blender_scene_info`, `execute_blender_code`, and `get_blender_viewport`) and the `popo-blender-mmd` hybrid Skill without requiring DSH or the embedded `dsh-stage` right sidebar.

## Prerequisites

- **Node.js ≥ 22.18** (or Node 24/26+, supporting native TypeScript execution for `node src/mcp/popo-mcp-server.ts`).
- `.pmx` models placed under `<POPO_ROOT>/public/models/<modelId>/` (or pass `pmxPath` explicitly to MCP tools).
- *(Optional, for live Blender GUI polish)* **Blender 4.2+** with **`mmd_tools`** and **`blender_mcp.py`** (`MCP for Blender` addon listening on `127.0.0.1:9876`, configurable via `BLENDER_HOST` / `BLENDER_PORT`).

## Install into Antigravity

Copy this folder to `~/.gemini/config/plugins/popo-mmd/`, create `mcp_config.json` from `mcp_config.example.json` replacing `<POPO_ROOT>` with your absolute clone path (e.g. `E:/PoPo`), and copy `<POPO_ROOT>/.agents/skills/popo-blender-mmd/SKILL.md` into `~/.gemini/config/plugins/popo-mmd/skills/popo-blender-mmd/SKILL.md` if you want the workflow available outside the repository directory.
