
'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const PLUGIN_ID = 'Restart-Server'
const PUBLIC_DIR = path.join(__dirname, 'public')

// fixed behavior, no configuration needed
const WINDOW_MODE = 'minimized'   // how the fresh hfs.exe window is shown
const FORCE_KILL_SECONDS = 30     // safety net if the old process cannot exit

// scheduled restarts (the list is edited from the admin logout page, stored in
// the plugin storage folder so it survives restarts and plugin updates)
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const SCHEDULE_TICK_MS = 20000
const MIN_UPTIME_FOR_SCHEDULE = 120000 // don't auto-restart right after a (re)start

exports.version = 1.4
exports.apiRequired = 13
exports.description = "Adds a 'Restart Server' button beside 'Quit HFS' in the admin panel. One click restarts HFS: the old process exits, a fresh hfs.exe starts, and all memory, caches and handles are released."
exports.repo = "hugo529100/hfs-Restart-Server"
exports.init = api => {
    let restarting = false
    let helperPid = null
    let lastRestart = null
    let schedules = []
    let lastRuns = {}
    let scheduleTimer = null
    let lastCheckAt = null
    let lastCheckInfo = null

    const SCHEDULES_FILE = path.join(api.storageDir, 'schedules.json')
    const LASTRUNS_FILE = path.join(api.storageDir, 'last-runs.json')

    // ------------------------------------------------------------------ utils

    function log(...args) {
        const line = args.map(a => (a && a.stack) ? a.stack : String(a)).join(' ')
        try { api.log('[Restart-Server]', line) }
        catch { }
        try {
            const file = path.join(api.storageDir, 'plugin.log')
            if (fs.existsSync(file) && fs.statSync(file).size > 200 * 1024)
                fs.writeFileSync(file, '', 'utf8')
            fs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\r\n', 'utf8')
        } catch { }
    }

    function isAdminRequest(ctx) {
        if (!ctx) return false
        try {
            if (api.ctxBelongsTo(ctx, ['admin'])) return true
        } catch { }
        try {
            const username = api.getCurrentUsername(ctx)
            if (username && api.getAccount(username)?.admin) return true
        } catch { }
        try {
            if (ctx.state?.account?.admin) return true
        } catch { }
        return false
    }

    function assertAdmin(ctx) {
        if (!isAdminRequest(ctx)) throw Error('admin only')
    }

    // Windows command line quoting for the relaunch arguments.
    function quoteArg(value) {
        const s = String(value)
        if (!/[ \t"]/.test(s)) return s
        return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
    }

    // PowerShell single-quoted literal (single quotes are doubled).
    function psQuote(value) {
        return "'" + String(value).replace(/'/g, "''") + "'"
    }

    function collectLaunchInfo() {
        // HFS is shipped with pkg: process.argv is
        //   [ "C:\\...\\hfs.exe", "C:\\snapshot\\hfs\\dist\\src\\index.js", ...userArgs ]
        // while HFS itself parses minimist(process.argv.slice(2)).
        const raw = process.argv || []
        const skip = process.pkg ? 2 : 1
        const args = raw.slice(skip).filter(a => typeof a === 'string' && a !== '')
            .filter(a => !/snapshot[\\/]/i.test(a))
        return {
            pid: process.pid,
            exe: process.execPath,
            args,
            cwd: process.cwd(),
            pkg: Boolean(process.pkg),
        }
    }

    // ------------------------------------------------------- scheduled restarts

    function readJson(file, fallback) {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
    }

    function writeJson(file, data) {
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true })
            fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
        } catch (err) {
            log('cannot write', file, ':', err?.message || err)
        }
    }

    const pad2 = n => String(n).padStart(2, '0')

    // "YYYY-MM-DDTHH:MM" in server local time
    function localStamp(date) {
        return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    function genId() {
        return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    }

    function normalizeSchedule(raw) {
        if (!raw || typeof raw !== 'object') return null
        const time = typeof raw.time === 'string' ? raw.time.trim() : ''
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null
        const days = {}
        for (const key of DAY_KEYS) days[key] = !raw.days || raw.days[key] !== false
        return {
            id: typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : genId(),
            enabled: raw.enabled !== false,
            time,
            days,
        }
    }

    function loadSchedules() {
        const raw = readJson(SCHEDULES_FILE, [])
        return Array.isArray(raw) ? raw.map(normalizeSchedule).filter(Boolean) : []
    }

    function nextRunIso(schedule, from) {
        if (!schedule.enabled) return null
        const [hours, minutes] = schedule.time.split(':').map(Number)
        for (let offset = 0; offset <= 7; offset++) {
            const candidate = new Date(from)
            candidate.setDate(candidate.getDate() + offset)
            candidate.setHours(hours, minutes, 0, 0)
            if (candidate.getTime() <= from.getTime()) continue
            if (schedule.days[DAY_KEYS[candidate.getDay()]] === false) continue
            return candidate.toISOString()
        }
        return null
    }

    function scheduleState() {
        const now = new Date()
        return {
            schedules: schedules.map(schedule => ({
                ...schedule,
                nextRun: nextRunIso(schedule, now),
                lastRun: lastRuns[schedule.id] || null,
            })),
            now: now.toISOString(),
            serverTime: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
            debug: {
                pid: process.pid,
                uptimeSeconds: Math.round(process.uptime()),
                timerActive: Boolean(scheduleTimer),
                lastCheckAt,
                lastCheckInfo,
                minUptimeMs: MIN_UPTIME_FOR_SCHEDULE,
            },
        }
    }

    function checkSchedules() {
        lastCheckAt = new Date().toISOString()
        try {
            // Always re-read from disk: HFS can hot-reload the plugin, and a request
            // may be served by an instance whose in-memory list is older than the file.
            schedules = loadSchedules()
            const storedRuns = readJson(LASTRUNS_FILE, {})
            if (storedRuns && typeof storedRuns === 'object' && !Array.isArray(storedRuns))
                lastRuns = storedRuns
            const infoNow = new Date()
            lastCheckInfo = {
                at: lastCheckAt,
                hhmm: `${pad2(infoNow.getHours())}:${pad2(infoNow.getMinutes())}`,
                dayKey: DAY_KEYS[infoNow.getDay()],
                schedules: schedules.length,
                uptimeSeconds: Math.round(process.uptime()),
                restarting,
            }
            if (restarting) return
            // avoid an immediate restart right after boot / a previous restart
            if (process.uptime() * 1000 < MIN_UPTIME_FOR_SCHEDULE) return
            const now = new Date()
            const stamp = localStamp(now)
            const hhmm = stamp.slice(11)
            const dayKey = DAY_KEYS[now.getDay()]
            for (const schedule of schedules) {
                if (!schedule.enabled) continue
                if (schedule.days[dayKey] === false) continue
                if (schedule.time !== hhmm) continue
                if (lastRuns[schedule.id] === stamp) continue
                log('scheduled restart due:', schedule.time, dayKey)
                performRestart('schedule ' + schedule.time).then(result => {
                    if (!result || !result.ok) return
                    lastRuns[schedule.id] = stamp
                    writeJson(LASTRUNS_FILE, lastRuns)
                }).catch(err => log('scheduled restart failed:', err?.message || err))
                return
            }
        } catch (err) {
            log('schedule check failed:', err?.message || err)
        }
    }

    // ------------------------------------------------------------- helper

    function buildHelperScript(info, options) {
        const argLine = info.args.map(quoteArg).join(' ')
        const line = [
            "$ErrorActionPreference = 'SilentlyContinue'",
            '$oldPid = ' + info.pid,
            '$exe = ' + psQuote(info.exe),
            '$arguments = ' + psQuote(argLine),
            '$workDir = ' + psQuote(info.cwd),
            '$logFile = ' + psQuote(options.logFile),
            '$windowMode = ' + psQuote(options.windowMode),
            '$forceKillSeconds = ' + options.forceKillSeconds,
            '$hfsProcessName = ' + psQuote(path.basename(info.exe, path.extname(info.exe))),
            '$runId = ' + psQuote(options.runId || ''),
            '',
            'function Write-Log([string]$msg) {',
            '    try {',
            "        $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $msg",
            '        $line | Out-File -LiteralPath $logFile -Append -Encoding utf8',
            '    } catch {}',
            '}',
            '',
            'function Get-TargetProcess {',
            '    $p = Get-Process -Id $oldPid -ErrorAction SilentlyContinue',
            '    if (-not $p) { return $null }',
            '    if ($oldStartTicks -gt 0 -and $p.StartTime.Ticks -ne $oldStartTicks) { return $null }',
            '    return $p',
            '}',
            '',
            '$target = Get-Process -Id $oldPid -ErrorAction SilentlyContinue',
            '$oldStartTicks = 0',
            'if ($target) { try { $oldStartTicks = $target.StartTime.Ticks } catch {} }',
            'Write-Log ("helper started: " + $runId + "; waiting for pid " + $oldPid + " (" + $exe + ")")',
            '',
            '$deadline = (Get-Date).AddSeconds($forceKillSeconds)',
            'while ((Get-TargetProcess) -and ((Get-Date) -lt $deadline)) {',
            '    Start-Sleep -Milliseconds 400',
            '}',
            'if (Get-TargetProcess) {',
            '    Write-Log "old process did not exit in time; forcing termination"',
            '    $p = Get-TargetProcess',
            '    if ($p) { try { Stop-Process -Id $p.Id -Force } catch { Write-Log ("force kill failed: " + $_.Exception.Message) } }',
            '    Start-Sleep -Seconds 2',
            '}',
            'Write-Log "old process is gone"',
            'Start-Sleep -Seconds 2',
            '',
            '$others = @(Get-Process -Name $hfsProcessName -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $oldPid })',
            'if ($others.Count -gt 0) {',
            '    $ids = ($others | ForEach-Object { $_.Id }) -join ","',
            '    Write-Log ("another " + $hfsProcessName + " is already running (" + $ids + "); not starting a new one")',
            '    exit 0',
            '}',
            '',
            '$started = $false',
            'try {',
            '    $psi = New-Object System.Diagnostics.ProcessStartInfo',
            '    $psi.FileName = $exe',
            '    $psi.Arguments = $arguments',
            '    $psi.WorkingDirectory = $workDir',
            "    if ($windowMode -eq 'hidden') {",
            '        $psi.UseShellExecute = $false',
            '        $psi.CreateNoWindow = $true',
            '    } else {',
            '        $psi.UseShellExecute = $true',
            "        if ($windowMode -eq 'minimized') { $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Minimized }",
            '        else { $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal }',
            '    }',
            '    $proc = [System.Diagnostics.Process]::Start($psi)',
            '    Write-Log ("started hfs pid " + $proc.Id + " (window " + $windowMode + ")")',
            '    $started = $true',
            '}',
            'catch {',
            '    Write-Log ("failed to start hfs: " + $_.Exception.Message)',
            '}',
            'if (-not $started) { exit 2 }',
            'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force',
            'exit 0',
        ]
        return line.join('\r\n') + '\r\n'
    }

    function writeHelper(info, runId) {
        const storage = api.storageDir
        fs.mkdirSync(storage, { recursive: true })
        const logFile = path.join(storage, 'restart.log')
        const helper = path.join(storage, 'restart-helper.ps1')
        const windowMode = WINDOW_MODE
        const forceKillSeconds = FORCE_KILL_SECONDS
        const script = buildHelperScript(info, { logFile, windowMode, forceKillSeconds, runId })
        fs.writeFileSync(helper, '\ufeff' + script, 'utf8')
        return { helper, logFile }
    }

    function psPath() {
        return path.join(process.env.SystemRoot || 'C:\\Windows',
            'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    }

    function waitChild(child, ms) {
        return new Promise(resolve => {
            let settled = false
            const done = value => { if (!settled) { settled = true; resolve(value) } }
            child.once('exit', code => done(code))
            child.once('error', err => {
                log('child process error:', err?.message || err)
                done(-1)
            })
            setTimeout(() => done(null), ms)
        })
    }

    function readTextIfExists(file) {
        try { return fs.readFileSync(file, 'utf8') } catch { return '' }
    }

    async function waitForLog(logFile, needle, timeoutMs) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            if (readTextIfExists(logFile).includes(needle)) return true
            await new Promise(resolve => setTimeout(resolve, 200))
        }
        return false
    }

    function writeLauncher(storage, helperPath, statusFile) {
        const launcher = path.join(storage, 'restart-launcher.ps1')
        const ps = psPath()
        const cmdLine = `"${ps}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${helperPath}"`
        const script = [
            "$ErrorActionPreference = 'Stop'",
            'try {',
            '    $cmd = ' + psQuote(cmdLine),
            '    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }',
            "    if ($r.ReturnValue -ne 0) { throw ('Win32_Process.Create returned ' + $r.ReturnValue) }",
            '    Set-Content -LiteralPath ' + psQuote(statusFile) + " -Value ('ok ' + $r.ProcessId) -Encoding utf8",
            '    exit 0',
            '} catch {',
            '    Set-Content -LiteralPath ' + psQuote(statusFile) + " -Value ('fail ' + $_.Exception.Message) -Encoding utf8",
            '    exit 1',
            '}',
        ].join('\r\n')
        fs.writeFileSync(launcher, '\ufeff' + script, 'utf8')
        return launcher
    }

    async function launchHelper(helperPath, logFile, runId) {
        const storage = path.dirname(helperPath)
        const ps = psPath()
        // Preferred path: let WMI create the helper. A process created by WmiPrvSE is
        // not part of HFS's Windows job, so it survives the quit, and it is created in
        // the same interactive session (verified on Windows 11).
        try {
            const statusFile = path.join(storage, 'restart-status.txt')
            fs.rmSync(statusFile, { force: true })
            const launcher = writeLauncher(storage, helperPath, statusFile)
            const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', launcher], {
                stdio: 'ignore',
                windowsHide: true,
            })
            const code = await waitChild(child, 25000)
            const status = readTextIfExists(statusFile).trim()
            if (code === 0 && status.startsWith('ok ')) {
                const pid = Number(status.split(/\s+/)[1])
                const confirmed = await waitForLog(logFile, runId, 12000)
                log('helper launched via WMI', 'pid', pid, 'confirmed', confirmed)
                return { ok: true, method: 'wmi', helperPid: Number.isFinite(pid) ? pid : null }
            }
            log('WMI launcher failed:', 'exit', code, 'status', status)
        } catch (err) {
            log('WMI launcher error:', err?.message || err)
        }
        // Fallback: spawn the helper directly. This survives the quit whenever HFS is
        // not inside a kill-on-close job (most non-sandboxed installs).
        try {
            const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helperPath], {
                stdio: 'ignore',
                windowsHide: true,
            })
            if (await waitForLog(logFile, runId, 15000)) {
                log('helper launched directly', 'pid', child.pid)
                return { ok: true, method: 'direct', helperPid: child.pid || null }
            }
            log('direct helper launch did not report start')
        } catch (err) {
            log('direct helper spawn error:', err?.message || err)
        }
        return { ok: false, error: 'restart helper could not be started' }
    }

    // ------------------------------------------------------------- shutdown

    function beginShutdown() {
        const delay = 700 // let the HTTP response reach the browser first
        setTimeout(() => {
            try {
                try {
                    if (typeof global.gc === 'function') {
                        global.gc()
                        global.gc()
                    }
                } catch { }
                const rss = (process.memoryUsage().rss / 1048576).toFixed(1)
                log(`quitting HFS for restart (pid ${process.pid}, rss ${rss} MB)`)
                try {
                    const first = api.require('./first')
                    if (typeof first?.quit === 'function') first.quit(0)
                    else process.emit('SIGINT')
                } catch (err) {
                    log('quit() unavailable, emitting SIGINT:', err?.message || err)
                    process.emit('SIGINT')
                }
                // last resort if the graceful path is stuck on some handle
                setTimeout(() => {
                    log('graceful shutdown timed out, forcing process exit')
                    process.exit(0)
                }, 30000)
            } catch (err) {
                log('shutdown failed:', err?.message || err)
                process.exit(1)
            }
        }, delay)
    }

    // ------------------------------------------------------------- rest api

    async function performRestart(reason) {
        if (process.platform !== 'win32')
            throw Error('Restart-Server currently supports Windows only')
        if (restarting) return { ok: true, already: true, pid: process.pid }
        restarting = true
        const info = collectLaunchInfo()
        const runId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
        let launched
        try {
            const files = writeHelper(info, runId)
            launched = await launchHelper(files.helper, files.logFile, runId)
            if (!launched.ok) throw Error(launched.error || 'helper launch failed')
            helperPid = launched.helperPid
        } catch (err) {
            restarting = false
            log('cannot prepare restart helper:', err?.message || err)
            throw Error('cannot prepare restart helper: ' + (err?.message || err))
        }
        lastRestart = new Date().toISOString()
        log(`restart (${reason}); helper ${helperPid} via ${launched.method}`)
        beginShutdown()
        return {
            ok: true,
            pid: process.pid,
            helperPid,
            method: launched.method,
            reason,
            exe: info.exe,
            args: info.args,
            cwd: info.cwd,
        }
    }

    async function restartServer(params, ctx) {
        assertAdmin(ctx)
        return performRestart('manual from ' + (ctx.ip || 'unknown'))
    }

    function getSchedules(params, ctx) {
        assertAdmin(ctx)
        return scheduleState()
    }

    function saveSchedules(params, ctx) {
        assertAdmin(ctx)
        const list = Array.isArray(params?.schedules) ? params.schedules : []
        const normalized = []
        const seen = new Set()
        for (const raw of list.slice(0, 100)) {
            const schedule = normalizeSchedule(raw)
            if (!schedule) continue
            if (seen.has(schedule.id)) schedule.id = genId()
            seen.add(schedule.id)
            normalized.push(schedule)
        }
        schedules = normalized
        writeJson(SCHEDULES_FILE, schedules)
        // pick up a schedule saved for the current minute without waiting for the tick
        api.setTimeout(checkSchedules, 1500)
        return scheduleState()
    }

    function getInfo(params, ctx) {
        assertAdmin(ctx)
        const rss = process.memoryUsage()
        const launch = collectLaunchInfo()
        return {
            pid: process.pid,
            exe: launch.exe,
            args: launch.args,
            pkg: launch.pkg,
            cwd: launch.cwd,
            uptimeSeconds: Math.round(process.uptime()),
            memory: {
                rssMb: +(rss.rss / 1048576).toFixed(1),
                heapUsedMb: +(rss.heapUsed / 1048576).toFixed(1),
            },
            restarting,
            helperPid,
            lastRestart,
            windowMode: WINDOW_MODE,
        }
    }

    // Diagnostic: show exactly what the restart helper will run, without restarting.
    function previewHelper(params, ctx) {
        assertAdmin(ctx)
        const info = collectLaunchInfo()
        return {
            launch: info,
            windowMode: WINDOW_MODE,
            forceKillSeconds: FORCE_KILL_SECONDS,
            logFile: path.join(api.storageDir, 'restart.log'),
            script: buildHelperScript(info, {
                logFile: path.join(api.storageDir, 'restart.log'),
                windowMode: WINDOW_MODE,
                forceKillSeconds: FORCE_KILL_SECONDS,
                runId: 'preview',
            }),
        }
    }

    // ------------------------------------------------------------- frontend

    function middleware(ctx) {
        if (ctx.method !== 'GET') return

        // assets of this plugin, served with no-cache so a plugin update is picked up immediately
        const asset = /^\/~\/plugins\/Restart-Server\/(admin\.js|ping\.txt)$/.exec(ctx.path)
        if (asset) {
            return () => {
                const file = path.join(PUBLIC_DIR, asset[1])
                ctx.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
                ctx.set('Pragma', 'no-cache')
                ctx.type = asset[1].endsWith('.js')
                    ? 'application/javascript; charset=utf-8'
                    : 'text/plain; charset=utf-8'
                ctx.body = fs.existsSync(file) ? fs.readFileSync(file) : ''
            }
        }

        // inject the admin script into the admin panel page
        if (ctx.path !== '/~/admin' && ctx.path !== '/~/admin/') return
        return () => {
            if (typeof ctx.body !== 'string') return
            if (ctx.body.includes('hfs-restart-admin')) return
            const prefix = ctx.state?.revProxyPath || ''
            const base = prefix + '/~/plugins/' + PLUGIN_ID + '/'
            const tag = `<script id="hfs-restart-admin" src="${base}admin.js?v=${exports.version}"></script>`
            if (ctx.body.includes('</head>')) ctx.body = ctx.body.replace('</head>', tag + '</head>')
            else if (ctx.body.includes('</body>')) ctx.body = ctx.body.replace('</body>', tag + '</body>')
        }
    }

    // ------------------------------------------------------------- startup

    schedules = loadSchedules()
    const storedRuns = readJson(LASTRUNS_FILE, {})
    if (storedRuns && typeof storedRuns === 'object' && !Array.isArray(storedRuns)) {
        const entries = Object.entries(storedRuns).slice(-200)
        for (const [id, stamp] of entries)
            if (typeof stamp === 'string') lastRuns[id] = stamp
    }
    scheduleTimer = api.setInterval(checkSchedules, SCHEDULE_TICK_MS)
    api.setTimeout(checkSchedules, 5000)

    return {
        middleware,
        customRest: {
            restartServer_restart: restartServer,
            restartServer_info: getInfo,
            restartServer_preview: previewHelper,
            restartServer_getSchedules: getSchedules,
            restartServer_saveSchedules: saveSchedules,
        },
        unload() {
            if (scheduleTimer) {
                clearInterval(scheduleTimer)
                scheduleTimer = null
            }
        },
    }
}
