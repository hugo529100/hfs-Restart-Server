# Restart-Server (HFS plugin)

Adds a **Restart Server** button right below **Quit HFS** on the admin panel
logout page (`/~/admin/#/logout`).

There is **no configuration**: one click performs one clean restart.

## Install

```
C:\0THER\HFS3\plugins\Restart-Server\
    plugin.js
    public\admin.js
    public\ping.txt
```

Put the folder in the HFS `plugins` directory (next to `config.yaml`).
HFS detects it automatically; enable it at `/~/admin/#/plugins`.
Already installed and enabled on this machine.

## What a click does

1. The plugin starts a small PowerShell helper through **WMI**
   (`Win32_Process.Create`). This matters because HFS runs inside a Windows
   job: a process spawned directly by HFS would be killed together with HFS.
   A WMI-created process belongs to `WmiPrvSE`, survives the quit, and still
   runs in the user's interactive session.
2. HFS quits gracefully through its own shutdown path (`SIGINT`): HTTP/HTTPS
   servers closed, databases closed, timers released. **Active connections are
   not force-closed by this plugin** - HFS handles them during its shutdown.
3. The helper waits for the old PID to disappear, then starts a brand new
   `hfs.exe` with the same executable, arguments and working directory
   (console window minimized).
4. The new process starts from zero: every byte of memory (V8 heap, native
   buffers, caches, file handles, sockets) is released.

"One click = one restart": while a restart is pending, the endpoint is locked
and the button is disabled, so a second instance can never be started.

## Fixed behavior (not configurable)

| Behavior | Value |
| --- | --- |
| New process window | minimized |
| Safety force-kill if the old process cannot exit | 30 s |
| Restart overlap | locked (one at a time) |
| Disconnect clients | no (HFS shutdown handles it) |

## Diagnostics

- Restart history: `plugins/Restart-Server/storage/restart.log`
  (run id, waited PID, new PID for every restart)
- Current process information (admin only):
  `POST /~/api/_restartServer_info`
- Show the helper script that would run (admin only):
  `POST /~/api/_restartServer_preview`

## Notes

- Windows only.
- A restart interrupts ongoing downloads/uploads/streams - HFS closes them as
  part of its shutdown.
- If WMI is unavailable, the plugin falls back to spawning the helper
  directly; this still works on machines where HFS is not inside a job.
