// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 三月七酱 <hakureiyuyuko>

import { Buffer, FreqType, TagType } from 'chameleon-ultra.js'
import {
  DEFAULT_KEYS,
  HF_TAG_TYPE_OPTIONS,
  LF_TAG_TYPE_OPTIONS,
  UltraService,
  mf1TagTypeOf,
  sectorLayout,
  type CardScan,
  type Dump,
  type LfScan,
  type LogKind,
  type Mf1Dump,
  type SlotInfo,
  SLOT_COUNT,
} from './ultra'

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T
const $$ = (sel: string): HTMLElement[] => Array.from(document.querySelectorAll(sel))

const svc = new UltraService()

let currentDump: Dump | null = null
let scans: CardScan[] = []
let selectedScan: CardScan | null = null
let lfScans: LfScan[] = []
let selectedLf: LfScan | null = null
let showDebug = false
const logLines: Array<{ text: string, kind: LogKind }> = []

/* ------------------------------ 主题 ------------------------------ */

type Theme = 'dark' | 'light'

function currentTheme (): Theme {
  return (document.documentElement.dataset.theme as Theme) ?? 'dark'
}

function applyTheme (theme: Theme): void {
  document.documentElement.dataset.theme = theme
  try { localStorage.setItem('cu.theme', theme) } catch {}
  const btn = $('#btn-theme')
  btn.textContent = theme === 'dark' ? '☾' : '☀'
  btn.title = theme === 'dark' ? '切到日间模式' : '切到夜间模式'
}

function toggleTheme (): void {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark')
}

/* ------------------------------ 基础 UI ------------------------------ */

function toast (msg: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
  const el = $('#toast')
  el.textContent = msg
  el.className = `toast show ${kind === 'info' ? '' : kind}`
  clearTimeout((toast as any)._t)
  ;(toast as any)._t = setTimeout(() => { el.className = 'toast' }, 2600)
}

function addLog (msg: string, kind: LogKind = 'info'): void {
  logLines.push({ text: `${new Date().toLocaleTimeString()}  ${msg}`, kind })
  if (logLines.length > 800) logLines.shift()
  renderLog()
}

function renderLog (): void {
  const pre = $('#log')
  pre.innerHTML = logLines
    .filter(l => showDebug || l.kind !== 'debug')
    .map(l => `<span class="${l.kind}">${escapeHtml(l.text)}</span>`)
    .join('\n')
  pre.scrollTop = pre.scrollHeight
}

function escapeHtml (s: string): string {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as any)[c])
}

function setProgress (msg: string, pct: number): void {
  $('#progress-wrap').classList.remove('hidden')
  ;($('#progress-bar') as HTMLElement).style.width = `${Math.max(0, Math.min(100, pct))}%`
  $('#progress-text').textContent = msg
}

function hideProgress (): void {
  $('#progress-wrap').classList.add('hidden')
}

function setBusy (busy: boolean): void {
  const dot = $('#status-dot')
  if (busy) dot.classList.add('busy')
  else dot.classList.remove('busy')
  $$('button').forEach(b => {
    const id = b.id
    if (id === 'btn-connect' || id === 'btn-disconnect') return
    if (busy) b.setAttribute('data-was-disabled', b.hasAttribute('disabled') ? '1' : '0')
  })
  if (!busy) {
    $$('button[data-was-disabled]').forEach(b => b.removeAttribute('data-was-disabled'))
  }
}

function refreshButtons (): void {
  const online = svc.isConnected()
  $('#btn-connect').toggleAttribute('disabled', online || busyGlobal)
  $('#btn-disconnect').toggleAttribute('disabled', !online || busyGlobal)
  ;['#btn-scan', '#btn-read-mf1', '#btn-read-gen1a', '#btn-read-mfu', '#btn-lf-scan'].forEach(sel => {
    $(sel).toggleAttribute('disabled', !online || busyGlobal)
  })
  ;($('#btn-write') as HTMLButtonElement).disabled = !online || busyGlobal || !currentDump
  ;($('#btn-write-lf') as HTMLButtonElement).disabled = !online || busyGlobal || !selectedLf
  $('#btn-save-slots').toggleAttribute('disabled', !online || busyGlobal)
}

let busyGlobal = false
let cancelRequested = false
async function run<T> (label: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (busyGlobal) return
  busyGlobal = true
  cancelRequested = false
  refreshButtons()
  try {
    return await fn()
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    addLog(`${label}失败：${msg}`, 'err')
    toast(`${label}失败：${msg}`, 'err')
    return undefined
  } finally {
    busyGlobal = false
    hideProgress()
    refreshButtons()
  }
}

/* ------------------------------ 设备信息 / 连接 ------------------------------ */

function renderInfo (): void {
  const i = svc.info
  const parts: string[] = []
  if (i.model) parts.push(`型号 <b>${i.model}</b>`)
  if (i.appVersion) parts.push(`固件 <b>${i.appVersion}</b>`)
  if (i.gitVersion) parts.push(`git <b>${i.gitVersion.slice(0, 7)}</b>`)
  if (i.mode) parts.push(`模式 <b>${i.mode}</b>`)
  if (i.activeSlot !== undefined) parts.push(`激活槽 <b>#${i.activeSlot + 1}</b>`)
  if (i.battery) parts.push(`电量 <b>${i.battery.level}%</b> (${i.battery.voltage}mV)`)
  if (i.chipId) parts.push(`芯片 <b>${i.chipId}</b>`)
  $('#dev-info').innerHTML = parts.length ? parts.map(p => `<span>${p}</span>`).join('') : ''
  $('#conn-state').textContent = svc.isConnected() ? '已连接' : '未连接'
  $('#status-dot').classList.toggle('on', svc.isConnected())
  if (svc.isConnected() && i.model) $('#conn-state').textContent = `已连接 · ${i.model} ${i.appVersion ?? ''}`
}

async function doConnect (): Promise<void> {
  if (!svc.isSupported()) {
    toast('这个浏览器不支持 Web Serial，请用 Chrome / Edge 桌面版', 'err')
    return
  }
  await run('连接', async () => {
    setProgress('等待选择串口（选 COM38）…', 30)
    await svc.connect()
    setProgress('读取设备信息…', 80)
    renderInfo()
    renderSlots()
    fillWriteSlotSelect()
    toast(`已连接 ${svc.info.model ?? ''} ${svc.info.appVersion ?? ''}`, 'ok')
    addLog(`连接成功：${JSON.stringify(svc.info)}`, 'ok')
  })
}

async function doDisconnect (): Promise<void> {
  await run('断开', async () => {
    await svc.disconnect()
    renderInfo()
    renderSlots()
  })
}

/* ------------------------------ 槽位 ------------------------------ */

function tagTypeName (t: TagType): string {
  return TagType[t] ?? String(t)
}

function renderSlots (): void {
  const box = $('#slots')
  if (!svc.isConnected() || svc.slots.length === 0) {
    box.innerHTML = '<p class="muted small" style="padding:8px">连接后显示 8 个槽位</p>'
    return
  }
  box.innerHTML = svc.slots.map(s => slotHtml(s)).join('')
  box.querySelectorAll<HTMLElement>('.slot').forEach(el => {
    const slot = Number(el.dataset.slot)
    el.addEventListener('click', async ev => {
      if ((ev.target as HTMLElement).closest('select, input, label')) return
      await run('激活槽位', async () => {
        await svc.setActiveSlot(slot)
        renderInfo(); renderSlots()
      })
    })
    el.querySelectorAll<HTMLSelectElement>('select[data-freq]').forEach(sel => {
      sel.addEventListener('change', async ev => {
        ev.stopPropagation()
        const tagType = Number(sel.value)
        await run('修改类型', async () => {
          await svc.setSlotTagType(slot, tagType)
          renderSlots()
        })
      })
      sel.addEventListener('click', ev => ev.stopPropagation())
    })
    el.querySelectorAll<HTMLInputElement>('input[data-freq]').forEach(chk => {
      chk.addEventListener('change', async ev => {
        ev.stopPropagation()
        const freq = chk.dataset.freq === 'hf' ? FreqType.HF : FreqType.LF
        const checked = chk.checked
        await run('切换启用', async () => {
          await svc.setSlotEnable(slot, freq, checked)
          renderSlots()
        })
      })
      chk.addEventListener('click', ev => ev.stopPropagation())
    })
  })
}

function slotHtml (s: SlotInfo): string {
  const active = svc.info.activeSlot === s.slot
  const label = s.hfName ?? s.lfName ?? `槽位 ${s.slot + 1}`
  const hfOptions = HF_TAG_TYPE_OPTIONS.map(t =>
    `<option value="${t}"${t === s.hfTagType ? ' selected' : ''}>${tagTypeName(t)}</option>`,
  ).join('')
  const lfOptions = LF_TAG_TYPE_OPTIONS.map(t =>
    `<option value="${t}"${t === s.lfTagType ? ' selected' : ''}>${tagTypeName(t)}</option>`,
  ).join('')
  return `
    <div class="slot${active ? ' active' : ''}" data-slot="${s.slot}">
      <div class="slot-top">
        <div><span class="num">#${s.slot + 1}</span><b>${escapeHtml(label)}</b></div>
        <div class="tag-en">
          <label><input type="checkbox" data-freq="hf"${s.hfEnabled ? ' checked' : ''}/> HF</label>
          <label><input type="checkbox" data-freq="lf"${s.lfEnabled ? ' checked' : ''}/> LF</label>
        </div>
      </div>
      <div class="slot-row${s.hfEnabled ? '' : ' off'}">
        <span class="freq">HF</span><select data-freq="hf">${hfOptions}</select>
      </div>
      <div class="slot-row${s.lfEnabled ? '' : ' off'}">
        <span class="freq">LF</span><select data-freq="lf">${lfOptions}</select>
      </div>
    </div>`
}

/* ------------------------------ 读卡 ------------------------------ */

function renderScan (): void {
  const box = $('#scan-result')
  if (scans.length === 0) { box.innerHTML = ''; return }
  box.innerHTML = scans.map((s, idx) => `
    <div class="found${selectedScan === s ? ' selected' : ''}" data-idx="${idx}">
      <div class="uid">${s.uid}</div>
      <div class="meta">ATQA ${s.atqa} · SAK ${s.sak}${s.ats ? ` · ATS ${s.ats}` : ''}</div>
      <div class="small">${UltraService.guessCardType(s)}</div>
    </div>`).join('')
  box.querySelectorAll<HTMLElement>('.found').forEach(el => {
    el.addEventListener('click', () => {
      selectedScan = scans[Number(el.dataset.idx)]
      renderScan()
      addLog(`选中卡片 UID=${selectedScan.uid}`, 'info')
    })
  })
}

function renderLf (): void {
  const box = $('#lf-result')
  if (lfScans.length === 0) { box.innerHTML = ''; return }
  box.innerHTML = lfScans.map((s, idx) => `
    <div class="found${selectedLf === s ? ' selected' : ''}" data-lf="${idx}">
      <div class="uid">${escapeHtml(s.id)}</div>
      <div class="meta">${s.type} · ${tagTypeName(s.tagType)}</div>
      <div class="small">125 kHz 低频卡</div>
    </div>`).join('')
  box.querySelectorAll<HTMLElement>('.found').forEach(el => {
    el.addEventListener('click', () => {
      selectedLf = lfScans[Number(el.dataset.lf)]
      renderLf()
      refreshButtons()
      addLog(`选中 LF 卡：${selectedLf?.type} ${selectedLf?.id}`, 'info')
    })
  })
}

function blockSector (block: number): number {
  return block < 128 ? Math.floor(block / 4) : 32 + Math.floor((block - 128) / 16)
}

function isTrailerBlock (block: number): boolean {
  const sector = blockSector(block)
  const [start, count] = sectorLayout(sector)
  return block === start + count - 1
}

function renderDump (): void {
  const box = $('#dump-view')
  if (!currentDump) { box.innerHTML = ''; return }

  if (currentDump.kind === 'mf1') {
    const d = currentDump
    const readCount = d.blocks.filter(b => b !== null).length
    const rows: string[] = []
    let lastSector = -1
    d.blocks.forEach((blk, i) => {
      const sector = blockSector(i)
      if (sector !== lastSector) {
        lastSector = sector
        rows.push(`<div class="sector-head">── 扇区 ${sector} ──</div>`)
      }
      const cls = blk === null ? 'null' : isTrailerBlock(i) ? 'trailer' : ''
      const text = blk === null
        ? '?? '.repeat(16).trim()
        : (blk.match(/.{2}/g) ?? []).join(' ')
      rows.push(`<div class="${cls}"><span class="blk">${String(i).padStart(3, '0')}</span>  ${text}</div>`)
    })
    const uid = d.blocks[0]?.slice(0, 8) ?? '—'
    box.innerHTML = `
      <div class="dump-head">
        <b>MF1 dump</b>
        <span class="muted small">${tagTypeName(d.tagType)} · ${readCount}/${d.blocks.length} 块 · UID ${uid}</span>
        <button class="ghost mini" id="btn-export-json">导出 JSON</button>
        <button class="ghost mini" id="btn-export-bin">导出 .bin</button>
        <button class="ghost mini" id="btn-import">导入文件…</button>
      </div>
      <div class="dump-grid">${rows.join('')}</div>`
  } else {
    const d = currentDump
    const pages = d.data.match(/.{8}/g) ?? []
    box.innerHTML = `
      <div class="dump-head">
        <b>MF0 dump</b>
        <span class="muted small">${pages.length} 页 · ${d.data.length / 2} 字节</span>
        <button class="ghost mini" id="btn-export-json">导出 JSON</button>
        <button class="ghost mini" id="btn-export-bin">导出 .bin</button>
        <button class="ghost mini" id="btn-import">导入文件…</button>
      </div>
      <div class="dump-grid">${pages.map((p, i) =>
        `<div><span class="blk">页 ${String(i).padStart(3, '0')}</span>  ${(p.match(/.{2}/g) ?? []).join(' ')}</div>`,
      ).join('')}</div>`
  }

  $('#btn-export-json').addEventListener('click', exportJson)
  $('#btn-export-bin').addEventListener('click', exportBin)
  $('#btn-import').addEventListener('click', () => ($('#file-import') as HTMLInputElement).click())
  refreshButtons()
}

/* ------------------------------ 导入导出 ------------------------------ */

function download (name: string, data: BlobPart, type = 'application/octet-stream'): void {
  const blob = new Blob([data], { type })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

function stamp (): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

function exportJson (): void {
  if (!currentDump) return
  const payload = { format: 'chameleon-web-dump', version: 1, ...currentDump }
  download(`dump-${currentDump.kind}-${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json')
  addLog('dump 已导出 JSON', 'ok')
}

function exportBin (): void {
  const d = currentDump
  if (!d) return
  if (d.kind === 'mf1') {
    const buf = Buffer.concat(d.blocks.map(b => (b ? Buffer.from(b, 'hex') : Buffer.alloc(16))))
    download(`dump-mf1-${stamp()}.bin`, new Uint8Array(buf))
  } else {
    download(`dump-mf0-${stamp()}.bin`, new Uint8Array(Buffer.from(d.data, 'hex')))
  }
  addLog('dump 已导出 .bin', 'ok')
}

function importDump (text: string, raw: ArrayBuffer): void {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed)
    if (obj.kind === 'mf1') {
      currentDump = { kind: 'mf1', tagType: obj.tagType ?? mf1TagTypeOf(obj.blocks.length), blocks: obj.blocks, keys: obj.keys ?? {}, scan: obj.scan, createdAt: obj.createdAt ?? new Date().toISOString() } as Mf1Dump
    } else if (obj.kind === 'mfu') {
      currentDump = obj
    } else {
      throw new Error('无法识别的 dump 格式')
    }
  } else {
    const bytes = new Uint8Array(raw)
    if (bytes.length < 64) throw new Error('文件太小，不是有效的 dump')
    const blockCount = Math.floor(bytes.length / 16) * 16 === bytes.length ? bytes.length / 16 : 0
    if (blockCount === 64 || blockCount === 128 || blockCount === 256) {
      const blocks: string[] = []
      for (let i = 0; i < blockCount; i++) {
        blocks.push(Buffer.from(bytes.subarray(i * 16, i * 16 + 16)).toString('hex').toUpperCase())
      }
      currentDump = { kind: 'mf1', tagType: mf1TagTypeOf(blockCount), blocks, keys: {}, createdAt: new Date().toISOString() }
    } else {
      currentDump = {
        kind: 'mfu',
        tagType: TagType.NTAG_215,
        data: Buffer.from(bytes).toString('hex').toUpperCase(),
        createdAt: new Date().toISOString(),
      }
    }
  }
  renderDump()
  toast('dump 已导入', 'ok')
  addLog(`导入 dump：${currentDump.kind}`, 'ok')
}

/* ------------------------------ 写卡 ------------------------------ */

function fillWriteSlotSelect (): void {
  const sel = $('#write-slot') as HTMLSelectElement
  sel.innerHTML = Array.from({ length: SLOT_COUNT }, (_, i) => {
    const s = svc.slots[i]
    const label = s?.hfName ? `#${i + 1} ${escapeHtml(s.hfName)}` : `槽位 #${i + 1}`
    return `<option value="${i}">${label}</option>`
  }).join('')
  if (svc.info.activeSlot !== undefined) sel.value = String(svc.info.activeSlot)

  const mfuSel = $('#write-mfu-type') as HTMLSelectElement
  const mfuTypes = [
    TagType.MF0_ICU1, TagType.MF0_ICU2, TagType.MF0_UL11, TagType.MF0_UL21,
    TagType.NTAG_210, TagType.NTAG_212, TagType.NTAG_213, TagType.NTAG_215, TagType.NTAG_216,
  ]
  mfuSel.innerHTML = mfuTypes
    .map(t => `<option value="${t}">${tagTypeName(t)}</option>`).join('')
  mfuSel.value = String(TagType.NTAG_215)
}

async function doWriteLf (): Promise<void> {
  if (!selectedLf) return
  const slot = Number(($('#write-slot') as HTMLSelectElement).value)
  const scan = selectedLf
  await run('写入 LF 槽位', async () => {
    setProgress('写入 LF…', 5)
    await svc.writeLfToSlot(slot, scan, setProgress)
    renderSlots(); renderInfo(); fillWriteSlotSelect()
    $('#write-result').innerHTML = `<p class="small" style="color:var(--ok)">已把 ${escapeHtml(scan.type)} ${escapeHtml(scan.id)} 写入槽位 #${slot + 1}</p>`
    toast('LF 写入完成', 'ok')
  })
}

async function doWrite (): Promise<void> {
  if (!currentDump) return
  const slot = Number(($('#write-slot') as HTMLSelectElement).value)
  const d = currentDump
  await run('写入槽位', async () => {
    if (d.kind === 'mf1') {
      if (d.blocks.every(b => b === null)) throw new Error('dump 是空的')
      if (!d.scan && d.blocks[0]) {
        // 没有扫描信息时，用块 0 里的 UID 兜底
        d.scan = { uid: d.blocks[0].slice(0, 8), atqa: '0400', sak: '08', ats: '' }
      }
      setProgress('准备写入…', 2)
      await svc.writeMf1ToSlot(slot, d, setProgress)
    } else {
      const tagType = Number(($('#write-mfu-type') as HTMLSelectElement).value)
      await svc.writeMfuToSlot(slot, d, tagType, setProgress)
    }
    renderSlots(); renderInfo(); fillWriteSlotSelect()
    $('#write-result').innerHTML = `<p class="small" style="color:var(--ok)">已写入槽位 #${slot + 1}，设备已切到该槽。把它切到 TAG 模式即可被读卡器识别。</p>`
    toast('写入完成', 'ok')
  })
}

/* ------------------------------ 密钥字典 ------------------------------ */

function loadKeys (): string[] {
  try {
    const raw = localStorage.getItem('cu.keys')
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr) && arr.length) return arr
    }
  } catch {}
  return [...DEFAULT_KEYS]
}

function saveKeys (keys: string[]): void {
  localStorage.setItem('cu.keys', JSON.stringify(keys))
}

function keysFromInput (): Buffer[] {
  const txt = ($('#keys-input') as HTMLTextAreaElement).value
  const keys = txt.split(/[\s,;]+/).map(k => k.replace(/[^0-9a-fA-F]/g, '').toUpperCase()).filter(k => k.length === 12)
  return keys.map(k => Buffer.from(k, 'hex'))
}

function renderKeys (): void {
  const keys = loadKeys()
  ;($('#keys-input') as HTMLTextAreaElement).value = keys.join('\n')
  $('#keys-count').textContent = `${keys.length} 个密钥`
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bind (): void {
  $('#btn-theme').addEventListener('click', toggleTheme)
  $('#btn-cancel').addEventListener('click', () => {
    cancelRequested = true
    addLog('已请求取消，当前命令结束后停止…', 'warn')
    if (busyGlobal) {
      // 单条串口命令是没法中途打断的，所以给个后手：4 秒后还没退出就拔电
      setTimeout(async () => {
        if (!busyGlobal) return
        addLog('命令无响应，强制断开串口（重新连接即可继续）', 'err')
        toast('已强制断开', 'err')
        await svc.disconnect().catch(() => {})
        renderInfo(); renderSlots()
      }, 4000)
    }
  })
  $('#btn-connect').addEventListener('click', doConnect)
  $('#btn-disconnect').addEventListener('click', doDisconnect)
  $('#btn-save-slots').addEventListener('click', () => run('保存槽位设置', async () => { await svc.saveSlotSettings() }))
  $('#btn-write').addEventListener('click', doWrite)
  $('#btn-write-lf').addEventListener('click', doWriteLf)

  $$('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tabs button').forEach(b => b.classList.toggle('active', b === btn))
      $$('.tab-body').forEach(b => b.classList.toggle('hidden', b.dataset.tab !== (btn as HTMLElement).dataset.tab))
    })
  })

  $('#btn-scan').addEventListener('click', () => run('HF 扫描', async () => {
    setProgress('扫描中（把卡贴到天线上）…', 40)
    scans = await svc.scanHf()
    selectedScan = scans[0] ?? null
    setProgress(`发现 ${scans.length} 张卡`, 100)
    renderScan()
    if (scans.length === 0) toast('没检测到卡', 'err')
  }))

  $('#btn-lf-scan').addEventListener('click', () => run('LF 扫描', async () => {
    setProgress('LF 扫描中（低频卡贴天线）…', 10)
    lfScans = await svc.scanLf(setProgress)
    selectedLf = lfScans[0] ?? null
    setProgress(`发现 ${lfScans.length} 张 LF 卡`, 100)
    renderLf()
    refreshButtons()
    if (lfScans.length === 0) toast('没检测到 125kHz 卡（EM410x / HID / Viking）', 'err')
  }))

  $('#btn-read-mf1').addEventListener('click', () => run('读取 MF1', async () => {
    const keys = keysFromInput()
    if (keys.length === 0) throw new Error('密钥字典是空的')
    setProgress('开始读取…', 2)
    const dump = await svc.mf1ReadCard(keys, setProgress, {
      shouldCancel: () => cancelRequested,
      bruteKeyB: ($('#chk-brute-b') as HTMLInputElement).checked,
    })
    currentDump = dump
    renderDump()
    toast('读取完成', 'ok')
    refreshButtons()
  }))

  $('#btn-read-gen1a').addEventListener('click', () => run('Gen1a 快读', async () => {
    setProgress('Gen1a 读取…', 2)
    const dump = await svc.mf1Gen1aReadCard(setProgress, { shouldCancel: () => cancelRequested })
    if (selectedScan) dump.scan = selectedScan
    currentDump = dump
    renderDump()
    toast('Gen1a 读取完成', 'ok')
    refreshButtons()
  }))

  $('#btn-read-mfu').addEventListener('click', () => run('读取 MF0', async () => {
    setProgress('读取 MF0/NTAG…', 10)
    const dump = await svc.mfuReadCard(setProgress)
    if (selectedScan) dump.scan = selectedScan
    currentDump = dump
    renderDump()
    toast('MF0 读取完成', 'ok')
    refreshButtons()
  }))

  $('#btn-keys-save').addEventListener('click', () => {
    const keys = ($('#keys-input') as HTMLTextAreaElement).value
      .split(/[\s,;]+/).map(k => k.replace(/[^0-9a-fA-F]/g, '').toUpperCase()).filter(k => k.length === 12)
    saveKeys(keys)
    renderKeys()
    toast(`已保存 ${keys.length} 个密钥`, 'ok')
  })
  $('#btn-keys-reset').addEventListener('click', () => {
    saveKeys([...DEFAULT_KEYS]); renderKeys(); toast('已恢复默认字典', 'ok')
  })

  $('#btn-log-clear').addEventListener('click', () => { logLines.length = 0; renderLog() })
  $('#btn-log-copy').addEventListener('click', async () => {
    const text = logLines.filter(l => showDebug || l.kind !== 'debug').map(l => l.text).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast('日志已复制', 'ok')
    } catch {
      toast('复制失败，手动选中日志文本吧', 'err')
    }
  })
  ;($('#chk-debug') as HTMLInputElement).addEventListener('change', ev => {
    showDebug = (ev.target as HTMLInputElement).checked
    renderLog()
  })

  ;($('#file-import') as HTMLInputElement).addEventListener('change', async ev => {
    const file = (ev.target as HTMLInputElement).files?.[0]
    if (!file) return
    try {
      const buf = await file.arrayBuffer()
      importDump(new TextDecoder().decode(buf), buf)
      refreshButtons()
    } catch (err: any) {
      toast(`导入失败：${err?.message ?? err}`, 'err')
    } finally {
      ;(ev.target as HTMLInputElement).value = ''
    }
  })

  svc.onLog = (msg, kind) => addLog(msg, kind)
}

/* ------------------------------ 启动 ------------------------------ */

bind()
applyTheme(currentTheme())
renderKeys()
renderInfo()
renderSlots()
fillWriteSlotSelect()
refreshButtons()
addLog('页面就绪。点「连接设备」→ 在弹窗里选 COM38。', 'info')
void svc.ensureInit().then(() => {
  addLog('SDK 适配器已就绪（Web Serial）', 'debug')
}).catch((err: any) => {
  addLog(`SDK 初始化失败：${err?.message ?? err}`, 'err')
})
if (!svc.isSupported()) {
  addLog('当前浏览器没有 Web Serial。请用 Chrome 或 Edge 桌面版打开 http://localhost:5173', 'err')
}

// 仅开发模式：方便在 Console 里造假数据调 UI
if (import.meta.env.DEV) {
  ;(window as any).__cu = {
    svc,
    renderSlots,
    renderScan,
    renderLf,
    renderInfo,
    renderDump,
    setDump (d: Dump | null) { currentDump = d; renderDump() },
    setLf (arr: LfScan[]) { lfScans = arr; selectedLf = arr[0] ?? null; renderLf() },
    get state () { return { scans, lfScans, currentDump, selectedLf } },
  }
}
