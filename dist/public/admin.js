/* Restart-Server - admin panel extension
 *
 * Injected into /~/admin/ by plugin.js (middleware).
 *
 * On the logout page (#/logout) it adds:
 *   1. a "Restart Server" button right below "Quit HFS";
 *   2. a "Scheduled restarts" panel: a list of daily restart times, each with
 *      its own weekday selection (the same idea as Prevent-Disk-Sleep Targets).
 *
 * The schedule list is stored by the backend in the plugin storage folder, so
 * it survives restarts and plugin updates.
 */
(function () {
    'use strict'

    if (window.__hfsRestartPluginLoaded) return
    window.__hfsRestartPluginLoaded = true

    if (!/\/~\/admin(?:\/|$)/.test(location.pathname)) return

    var PLUGIN_ID = 'Restart-Server'
    var BTN_ID = 'hfs-restart-server-btn'
    var PANEL_ID = 'hfs-restart-schedules'
    var LABEL = 'Restart Server'
    var LABEL_BUSY = 'Restarting…'
    var ICON_PATH = 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z'
    var DAY_DEFS = [
        ['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'],
        ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun'],
    ]

    var prefixPath = (function () {
        var i = location.pathname.indexOf('/~/admin')
        return i >= 0 ? location.pathname.slice(0, i) : ''
    })()
    var API_BASE = location.origin + prefixPath + '/~/api/'
    var PING_URL = prefixPath + '/~/plugins/' + PLUGIN_ID + '/ping.txt'

    var busy = false
    var debounceTimer = null
    var saveTimer = null
    var sched = {
        loaded: false,
        loading: false,
        saving: false,
        pending: false,
        schedules: [],
        serverTime: null,
        error: null,
    }

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms) })
    }

    function onLogoutPage() {
        var hash = location.hash || ''
        return hash === '#/logout' || hash.indexOf('#/logout') === 0
    }

    function normalize(text) {
        return String(text || '').replace(/\s+/g, ' ').trim()
    }

    async function apiCall(name, body) {
        var res = await fetch(API_BASE + name, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-hfs-anti-csrf': '1' },
            credentials: 'same-origin',
            body: JSON.stringify(body || {}),
        })
        var data = null
        try { data = await res.json() } catch (e) { }
        if (!res.ok) throw new Error((data && (data.message || data.error)) || ('HTTP ' + res.status))
        return data
    }

    // ---------------------------------------------------------------- theme

    function findQuitButton() {
        var buttons = document.querySelectorAll('button')
        for (var i = 0; i < buttons.length; i++) {
            var text = normalize(buttons[i].textContent)
            if (/^quit hfs$/i.test(text)) return buttons[i]
            if (/^(結束|退出|停止|終止|關閉)\s*HFS$/i.test(text)) return buttons[i]
        }
        return null
    }

    function parseColor(value) {
        var m = /^rgba?\(([^)]+)\)$/.exec(value || '')
        if (!m) return null
        var p = m[1].split(',').map(Number)
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
    }

    function colorfulness(c) {
        return c ? Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) : -1
    }

    function theme() {
        var accent = '#ff9900'
        try {
            // prefer the page's primary button (it matches the Restart Server
            // button); fall back to the warning-colored Quit HFS button
            var source = findPrimaryButton() || findQuitButton()
            if (source) {
                var cs = getComputedStyle(source)
                var fg = parseColor(cs.color)
                var bg = parseColor(cs.backgroundColor)
                // themes differ: some use a colored button with dark text, others a
                // dark button with colored text. Take the more saturated one.
                var pick = fg
                if (bg && bg.a > 0.2 && colorfulness(bg) >= colorfulness(fg)) pick = bg
                if (pick) accent = 'rgb(' + pick.r + ',' + pick.g + ',' + pick.b + ')'
            }
        } catch (e) { }
        function fade(alpha) {
            var c = parseColor(accent)
            if (!c) return accent
            return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')'
        }
        var rgb = parseColor(accent)
        var lum = rgb ? (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255 : 0
        return { accent: accent, ink: lum > 0.55 ? '#111' : '#fff', faint: fade(0.45), ghost: fade(0.18), bg: fade(0.05) }
    }

    // --------------------------------------------------------------- button

    function findPrimaryButton() {
        var buttons = document.querySelectorAll('button.MuiButton-contained.MuiButton-colorPrimary')
        for (var i = 0; i < buttons.length; i++) {
            if (buttons[i].id === BTN_ID) continue
            if (normalize(buttons[i].textContent) !== '') return buttons[i]
        }
        return null
    }

    function buildButton(template) {
        var btn = template ? template.cloneNode(true) : document.createElement('button')
        btn.id = BTN_ID
        btn.type = 'button'
        btn.setAttribute('aria-label', 'Restart the HFS server')
        btn.title = 'Full restart: the old process quits, a fresh hfs.exe starts, all memory is released'
        if (!template) {
            btn.className = 'MuiButtonBase-root MuiButton-root MuiButton-contained MuiButton-sizeLarge MuiButton-colorPrimary'
            btn.style.cssText = 'display:inline-flex;align-items:center;gap:8px;padding:8px 22px;border:0;border-radius:4px;background:#1976d2;color:#fff;font:inherit;font-size:0.9375rem;font-weight:500;letter-spacing:0.02857em;text-transform:uppercase;cursor:pointer;'
        }
        var icon = btn.querySelector('span.MuiButton-icon')
        if (icon) {
            var svg = icon.querySelector('svg')
            if (svg) {
                while (svg.firstChild) svg.removeChild(svg.firstChild)
                var path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
                path.setAttribute('d', ICON_PATH)
                svg.appendChild(path)
            }
        }
        while (btn.firstChild) btn.removeChild(btn.firstChild)
        if (icon) btn.appendChild(icon)
        var label = document.createElement('span')
        label.textContent = LABEL
        btn.appendChild(label)
        btn.addEventListener('click', onClick, true)
        return btn
    }

    function removeButton() {
        var btn = document.getElementById(BTN_ID)
        if (btn && btn.parentNode) btn.parentNode.removeChild(btn)
    }

    function ensureButton() {
        if (!onLogoutPage()) {
            removeButton()
            return
        }
        if (document.getElementById(BTN_ID)) return
        var quit = findQuitButton()
        if (!quit || !quit.parentNode) return
        var btn = buildButton(findPrimaryButton())
        quit.parentNode.insertBefore(btn, quit.nextSibling)
    }

    function setBusy(on, text) {
        var btn = document.getElementById(BTN_ID)
        if (!btn) return
        btn.disabled = !!on
        var label = btn.querySelector('span:last-child')
        if (label) label.textContent = text || (on ? LABEL_BUSY : LABEL)
    }

    async function doRestart() {
        if (busy) return
        busy = true
        setBusy(true, LABEL_BUSY)
        try {
            await apiCall('_restartServer_restart', {})
        } catch (err) {
            busy = false
            setBusy(false)
            window.alert('Restart request failed: ' + (err && err.message ? err.message : err))
            return
        }
        setBusy(true, 'Waiting for server…')
        waitForServer()
    }

    function onClick(ev) {
        ev.preventDefault()
        ev.stopPropagation()
        if (busy) return
        var ok = window.confirm('Restart the HFS server?\n\n• All downloads and streams will stop\n• The old process exits and all memory is released\n• The server is back in a few seconds')
        if (ok) doRestart()
    }

    async function fetchWithTimeout(url, ms) {
        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null
        var timer = controller ? setTimeout(function () { controller.abort() }, ms) : null
        try {
            return await fetch(url, {
                cache: 'no-store',
                credentials: 'same-origin',
                signal: controller ? controller.signal : undefined,
            })
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    async function waitForServer() {
        var started = Date.now()
        var sawDown = false
        await sleep(2500)
        while (Date.now() - started < 150000) {
            try {
                var res = await fetchWithTimeout(PING_URL + '?t=' + Date.now(), 3000)
                if (res.ok && (sawDown || Date.now() - started > 6000)) {
                    location.reload()
                    return
                }
            } catch (e) {
                sawDown = true
            }
            await sleep(700)
        }
        busy = false
        setBusy(false)
        window.alert('Timeout: the server did not come back within 2.5 minutes. Please check hfs.exe.')
    }

    // ------------------------------------------------------------- schedules

    function formatNext(iso) {
        if (!iso) return ''
        var date = new Date(iso)
        var now = new Date()
        var time = date.toTimeString().slice(0, 5)
        if (date.toDateString() === now.toDateString()) return 'today ' + time
        var tomorrow = new Date(now)
        tomorrow.setDate(tomorrow.getDate() + 1)
        if (date.toDateString() === tomorrow.toDateString()) return 'tomorrow ' + time
        return date.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + time
    }

    function applyState(data) {
        if (!data) return
        sched.schedules = Array.isArray(data.schedules) ? data.schedules : []
        sched.serverTime = data.serverTime || null
        sched.loaded = true
    }

    async function loadSchedules() {
        if (sched.loading) return
        sched.loading = true
        sched.error = null
        renderPanel()
        try {
            applyState(await apiCall('_restartServer_getSchedules', {}))
        } catch (err) {
            sched.error = 'Cannot load schedules: ' + (err && err.message ? err.message : err)
        } finally {
            sched.loading = false
            renderPanel()
        }
    }

    function scheduleSave() {
        clearTimeout(saveTimer)
        saveTimer = setTimeout(saveNow, 400)
    }

    async function saveNow() {
        if (sched.saving) {
            sched.pending = true
            return
        }
        sched.saving = true
        sched.error = null
        renderPanel()
        try {
            var payload = sched.schedules.map(function (s) {
                return { id: s.id, enabled: s.enabled, time: s.time, days: s.days }
            })
            applyState(await apiCall('_restartServer_saveSchedules', { schedules: payload }))
        } catch (err) {
            sched.error = 'Save failed: ' + (err && err.message ? err.message : err)
        } finally {
            sched.saving = false
            renderPanel()
            if (sched.pending) {
                sched.pending = false
                saveNow()
            }
        }
    }

    function el(tag, style, text) {
        var node = document.createElement(tag)
        if (style) node.style.cssText = style
        if (text != null) node.textContent = text
        return node
    }

    function inputStyle(c) {
        return 'background:transparent;color:' + c.accent + ';border:1px solid ' + c.faint +
            ';border-radius:4px;padding:2px 6px;font:inherit;font-size:13px;color-scheme:dark;'
    }

    function renderRow(schedule, c) {
        var row = el('div', 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:7px 0;border-top:1px solid ' + c.ghost + ';')

        var enableLabel = el('label', 'display:flex;align-items:center;gap:5px;font-size:12px;opacity:.9;cursor:pointer;')
        var enable = document.createElement('input')
        enable.type = 'checkbox'
        enable.checked = schedule.enabled !== false
        enable.style.accentColor = c.accent
        enable.addEventListener('change', function () {
            schedule.enabled = enable.checked
            scheduleSave()
        })
        enableLabel.appendChild(enable)
        enableLabel.appendChild(document.createTextNode('On'))
        row.appendChild(enableLabel)

        var timeInput = document.createElement('input')
        timeInput.type = 'time'
        timeInput.value = schedule.time
        timeInput.style.cssText = inputStyle(c) + 'width:92px;'
        timeInput.addEventListener('change', function () {
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeInput.value)) {
                timeInput.value = schedule.time
                return
            }
            schedule.time = timeInput.value
            scheduleSave()
        })
        row.appendChild(timeInput)

        var days = el('div', 'display:flex;gap:3px;')
        DAY_DEFS.forEach(function (def) {
            var key = def[0]
            var on = schedule.days && schedule.days[key] !== false
            var btn = el('button', 'font:inherit;font-size:11px;line-height:1;padding:4px 5px;border-radius:4px;cursor:pointer;border:1px solid ' +
                (on ? c.accent : c.ghost) + ';background:' + (on ? c.accent : 'transparent') + ';color:' + (on ? c.ink : c.accent) + ';', def[1])
            btn.type = 'button'
            btn.title = 'Restart on ' + def[1]
            btn.addEventListener('click', function (ev) {
                ev.preventDefault()
                schedule.days = schedule.days || {}
                schedule.days[key] = schedule.days[key] === false
                btn.style.background = schedule.days[key] ? c.accent : 'transparent'
                btn.style.color = schedule.days[key] ? c.ink : c.accent
                btn.style.borderColor = schedule.days[key] ? c.accent : c.ghost
                scheduleSave()
            })
            days.appendChild(btn)
        })
        row.appendChild(days)

        var nextText = schedule.enabled === false ? 'disabled'
            : (schedule.nextRun ? 'next: ' + formatNext(schedule.nextRun) : '')
        row.appendChild(el('span', 'font-size:11px;opacity:.65;margin-left:auto;', nextText))

        var del = el('button', 'font:inherit;font-size:13px;line-height:1;padding:3px 7px;border-radius:4px;cursor:pointer;border:1px solid ' + c.ghost + ';background:transparent;color:' + c.accent + ';', '✕')
        del.type = 'button'
        del.title = 'Delete this schedule'
        del.addEventListener('click', function (ev) {
            ev.preventDefault()
            if (!window.confirm('Delete the ' + schedule.time + ' schedule?')) return
            var i = sched.schedules.indexOf(schedule)
            if (i >= 0) sched.schedules.splice(i, 1)
            scheduleSave()
            renderPanel()
        })
        row.appendChild(del)
        return row
    }

    function renderPanel() {
        var panel = document.getElementById(PANEL_ID)
        if (!panel) return
        var c = theme()
        panel.innerHTML = ''
        panel.style.cssText = 'width:100%;max-width:640px;box-sizing:border-box;border:1px solid ' + c.ghost +
            ';border-radius:6px;padding:10px 12px;background:' + c.bg + ';margin-top:4px;'

        var header = el('div', 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;')
        header.appendChild(el('div', 'font-size:15px;font-weight:600;', 'Scheduled restarts'))
        var now = sched.serverTime ? 'server time ' + sched.serverTime : ''
        header.appendChild(el('div', 'font-size:11px;opacity:.6;margin-left:auto;', now))
        panel.appendChild(header)
        panel.appendChild(el('div', 'font-size:12px;opacity:.72;line-height:1.45;margin:4px 0 6px;',
            'HFS restarts itself once per day at each enabled time (server local time). Leave all days off to pause a schedule.'))

        if (sched.loading) {
            panel.appendChild(el('div', 'font-size:12px;opacity:.7;padding:6px 0;', 'Loading…'))
            return
        }

        var list = el('div', '')
        if (!sched.schedules.length) {
            list.appendChild(el('div', 'font-size:12px;opacity:.6;padding:8px 0;', 'No scheduled restarts yet.'))
        } else {
            sched.schedules.forEach(function (schedule) {
                list.appendChild(renderRow(schedule, c))
            })
        }
        panel.appendChild(list)

        var add = el('button', 'margin-top:8px;font:inherit;font-size:13px;padding:5px 12px;border-radius:4px;cursor:pointer;border:1px solid ' +
            c.faint + ';background:transparent;color:' + c.accent + ';', '+ Add schedule')
        add.type = 'button'
        add.addEventListener('click', function (ev) {
            ev.preventDefault()
            sched.schedules.push({
                id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                enabled: true,
                time: '03:00',
                days: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: true, sun: true },
            })
            renderPanel()
            scheduleSave()
        })
        panel.appendChild(add)

        if (sched.error) {
            panel.appendChild(el('div', 'font-size:12px;margin-top:6px;color:#ff6b6b;', sched.error))
        } else if (sched.saving) {
            panel.appendChild(el('div', 'font-size:11px;opacity:.6;margin-top:6px;', 'Saving…'))
        }
    }

    function removePanel() {
        var panel = document.getElementById(PANEL_ID)
        if (panel && panel.parentNode) panel.parentNode.removeChild(panel)
    }

    function ensurePanel() {
        if (!onLogoutPage()) {
            removePanel()
            return
        }
        if (document.getElementById(PANEL_ID)) return
        var quit = findQuitButton()
        if (!quit || !quit.parentNode) return
        var panel = document.createElement('div')
        panel.id = PANEL_ID
        var anchor = document.getElementById(BTN_ID) || quit
        anchor.parentNode.insertBefore(panel, anchor.nextSibling)
        if (!sched.loaded && !sched.loading) loadSchedules()
        else renderPanel()
    }

    function ensureAll() {
        ensureButton()
        ensurePanel()
    }

    function scheduleEnsure() {
        if (debounceTimer) return
        debounceTimer = setTimeout(function () {
            debounceTimer = null
            ensureAll()
        }, 120)
    }

    function start() {
        ensureAll()
        var root = document.getElementById('root') || document.body
        if (root && typeof MutationObserver !== 'undefined') {
            new MutationObserver(scheduleEnsure).observe(root, { childList: true, subtree: true })
        }
        window.addEventListener('hashchange', scheduleEnsure)
        window.addEventListener('popstate', scheduleEnsure)
        // safety net: React re-renders can remove foreign nodes without a useful mutation
        setInterval(function () { if (!busy) ensureAll() }, 1500)
        scheduleEnsure()
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start)
    } else {
        start()
    }
})()
