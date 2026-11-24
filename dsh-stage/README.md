# @popo/dsh-stage — PoPo 舞台 in the DSH right sidebar

A DSH (DeepSeek Harness) bundle that puts the PoPo 3D character stage — the web
process at `http://localhost:4000` that the PoPo MCP server pushes motions to —
into the right sidebar, with the character scaled down so it stays in frame.

## What it adds

| Where | What |
|---|---|
| Right sidebar → tab **PoPo 舞台** | The stage embedded from `http://localhost:4000/?embed=1&zoom=<n>`. A toolbar zooms the character (±, reset), replays the last motion, reloads the frame, or opens the full page. |
| Left sidebar foot, beside Settings | A **PoPo 舞台** trigger that opens (or reveals) the stage tab. |
| Settings → General | **PoPo 舞台** switch: open the stage automatically for every session (default on). Closing the tab turns auto-open off until the trigger is used again. |
| Right sidebar → Guide page | A **PoPo 舞台** entry capsule. |

## How the scaling works

`?embed=1` makes PoPo hide its header and chat box (the MCP bridge keeps running)
and `zoom` moves the camera back by that factor, so the whole body fits in a narrow
pane. Zoom changes are sent to the frame live with `postMessage`
(`{ type: 'popo:stage-zoom', zoom }`), so nothing reloads. The value is remembered
in `localStorage` (`popo-stage.zoom`).

**重播** asks PoPo to replay the last motion (`{ type: 'popo:stage-replay' }`): the
last one shown, or — right after the sidebar or DSH reloads — the latest motion the
PoPo MCP server pushed. PoPo reports `{ type: 'popo:stage-state', canReplay }`, and
the button stays disabled until there is something to replay.

## Stage server

The stage is served by the PoPo web process, and only that process receives the
motions the MCP server pushes — nothing else starts it, so it used to disappear with
every DSH restart. The Host half (`index.js`) now keeps it up:

- On activation it runs `next dev -p 4000` in the PoPo repository, unless something
  already listens on that port (a PoPo started by hand is used and left alone).
- On disposal it stops the server it started, together with the child process Next
  runs the server in.
- While the stage tab is visible the browser half probes the server every 5 s and
  reloads the frame once it answers again.

Row config of the `popo-stage` entry, all optional: `autoStart` (default `true`),
`popoDir` (default: the repository around this package), `port` (default `4000`; the
browser half embeds `http://localhost:4000/` regardless).

## Install

```
plugin_manager install_bundle  target=E:\PoPo\dsh-stage
```

The Host half loads when DSH starts (or when the plugin is toggled), so a change to
`index.js` needs one of the two; `client.js` is hot-replaced in the open page.
