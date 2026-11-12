// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 三月七酱 <hakureiyuyuko>

/**
 * Chameleon Ultra 服务层：把 chameleon-ultra.js SDK 包一层，供 UI 调用。
 * 传输层用 Web Serial（USB CDC 虚拟串口，115200 8N1）。
 */
import {
  Buffer,
  ChameleonUltra,
  DeviceMode,
  DeviceModel,
  FreqType,
  Slot,
  TagType,
} from 'chameleon-ultra.js'
import WebserialAdapter from 'chameleon-ultra.js/plugin/WebserialAdapter'

export type LogKind = 'info' | 'ok' | 'warn' | 'err' | 'debug'
export type LogFn = (msg: string, kind?: LogKind) => void
export type ProgressFn = (msg: string, pct: number) => void

export interface CardScan {
  uid: string
  atqa: string
  sak: string
  ats: string
}

export interface DeviceInfo {
  model?: string
  appVersion?: string
  gitVersion?: string
  chipId?: string
  battery?: { voltage: number, level: number }
  mode?: string
  activeSlot?: number
}

export interface SlotInfo {
  slot: number
  hfTagType: TagType
  lfTagType: TagType
  hfName?: string
  lfName?: string
  hfEnabled: boolean
  lfEnabled: boolean
}

export interface LfScan {
  /** em410x / hidprox / viking */
  kind: 'em410x' | 'hidprox' | 'viking'
  type: string
  tagType: TagType
  /** 可读 ID（hex 或 "FC x / CN y"） */
  id: string
  /** 原始数据，写槽位时用 */
  raw?: any
}

export interface Mf1Dump {
  kind: 'mf1'
  tagType: TagType
  /** 每个元素 32 个 hex 字符，读失败为 null */
  blocks: (string | null)[]
  keys: Record<number, { a?: string, b?: string }>
  scan?: CardScan
  createdAt: string
}

export interface MfuDump {
  kind: 'mfu'
  tagType: TagType
  /** 连续 4 字节页数据 */
  data: string
  scan?: CardScan
  createdAt: string
}

export type Dump = Mf1Dump | MfuDump

export const SLOT_COUNT = 8

/** 把串口层的报错换成能直接操作的中文提示 */
function friendlySerialError (msg: string): string {
  if (/No port selected by the user/i.test(msg)) return '你取消了端口选择，再点一次「连接设备」并选 COM38'
  if (/Failed to open serial port|Access denied|Permission denied|Failed to execute 'open'/i.test(msg)) {
    return `${msg} —— 这个串口被占用了，先关掉 chameleon-cli、桌面版 GUI 或其他串口工具`
  }
  if (/device has been lost|disconnected/i.test(msg)) return `${msg} —— 设备掉线，重新插拔 USB 后再连接`
  return msg
}

/** Mifare Classic 扇区 → 起始块 / 块数 */
export function sectorLayout (sector: number): [start: number, count: number] {
  return sector < 32 ? [sector * 4, 4] : [128 + (sector - 32) * 16, 16]
}

/** 块数 → 最贴近的 MF1 容量类型 */
export function mf1TagTypeOf (blockCount: number): TagType {
  if (blockCount <= 20) return TagType.MIFARE_Mini
  if (blockCount <= 64) return TagType.MIFARE_1024
  if (blockCount <= 128) return TagType.MIFARE_2048
  return TagType.MIFARE_4096
}

export interface Mf1Geometry {
  sectors: number
  blocks: number
}

/**
 * 由 SAK 推算卡片真实容量。
 * 这一步很关键：固件 mf1_toolbox_check_keys_of_sectors() 固定遍历 40 个扇区，
 * 不存在的扇区每次认证都失败，1K 卡多扫 24 个扇区会让整条命令拖上几分钟。
 */
export function mf1GeometryFromSak (sak?: string): Mf1Geometry {
  const s = (parseInt(sak ?? '08', 16) || 0) & 0x7f
  if (s === 0x18) return { sectors: 40, blocks: 256 } // Classic 4K
  if (s === 0x09) return { sectors: 5, blocks: 20 }  // Classic Mini
  return { sectors: 16, blocks: 64 }                  // 0x08 1K，0x10/0x11 Plus 同构
}

const hex = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('hex').toUpperCase()

export class UltraService {
  ultra = new ChameleonUltra()
  info: DeviceInfo = {}
  slots: SlotInfo[] = []
  onLog: LogFn = () => {}

  #initPromise?: Promise<void>

  /** 幂等初始化：装载 Web Serial 适配器 + 日志钩子 */
  async ensureInit (): Promise<void> {
    if (!this.#initPromise) this.#initPromise = this.init()
    await this.#initPromise
  }

  async init (): Promise<void> {
    this.ultra.emitter.on('debug', (name: string, fmt: any, ...args: any[]) => {
      this.onLog(`[${name}] ${typeof fmt === 'string' ? fmt : JSON.stringify(fmt)} ${args.length ? JSON.stringify(args) : ''}`.trim(), 'debug')
    })
    // 帧级打点：每条响应都记下 cmd / 状态 / 长度，卡在哪个命令上一目了然
    this.ultra.emitter.on('resp', (frame: any) => {
      try {
        this.onLog(`← cmd ${frame.cmd} status ${frame.status} len ${frame.data?.length ?? 0}`, 'debug')
      } catch {}
    })
    this.ultra.emitter.on('disconnected', (at: Date, reason?: string) => {
      this.onLog(`串口读循环结束${reason ? `：${reason}` : ''}`, reason ? 'err' : 'warn')
    })
    this.ultra.emitter.on('error', (err: Error) => {
      this.onLog(`SDK 错误：${err?.message ?? err}`, 'err')
    })
    await this.ultra.use(new WebserialAdapter())
  }

  isSupported (): boolean {
    return !!(navigator as any).serial || ('usb' in navigator)
  }

  isConnected (): boolean {
    return this.ultra.isConnected()
  }

  /**
   * 两层修正：
   * 1. SDK 的 WebserialAdapter 里 requestPort 带了 VID/PID 过滤器（6868:8686），
   *    某些板子/改过 PID 的机器在选口对话框里会看不到。这里包一层忽略 filters。
   * 2. Chrome Web Serial 的 open() 不传 bufferSize 时默认只有 255 字节，
   *    而 Ultra 有些命令（如 MF1 批量查密钥）的响应接近 500 字节，容易大包被截断。
   *    这里统一把收发缓冲扩到 4KB。
   */
  #patchPortChooser (): void {
    const serial: any = (navigator as any).serial
    if (!serial || serial.__chatboxPatched) return
    const orig = serial.requestPort.bind(serial)
    serial.requestPort = async () => {
      const port = await orig()
      if (port && !port.__buffered) {
        const origOpen = port.open.bind(port)
        port.open = async (opts: any = {}) => {
          try {
            return await origOpen({ bufferSize: 4096, ...opts })
          } catch (err) {
            this.onLog(`bufferSize 设置失败，回退默认值：${(err as Error)?.message}`, 'warn')
            return await origOpen(opts)
          }
        }
        port.__buffered = true
      }
      return port
    }
    serial.__chatboxPatched = true
  }

  async connect (): Promise<DeviceInfo> {
    await this.ensureInit()
    this.#patchPortChooser()
    this.onLog('打开串口选择框…', 'info')
    try {
      await this.ultra.connect()
    } catch (err: any) {
      throw new Error(friendlySerialError(err?.message ?? String(err)))
    }
    this.onLog('串口已打开', 'ok')
    this.info = await this.readInfo()
    this.slots = await this.readSlots()
    return this.info
  }

  async disconnect (): Promise<void> {
    await this.ultra.disconnect().catch(() => {})
    this.info = {}
    this.slots = []
    this.onLog('已断开', 'info')
  }

  async readInfo (): Promise<DeviceInfo> {
    const u = this.ultra
    const out: DeviceInfo = {}
    const tryGet = async <T>(fn: () => Promise<T>, name: string): Promise<T | undefined> => {
      try {
        return await fn()
      } catch (err: any) {
        this.onLog(`${name} 读取失败：${err?.message ?? err}`, 'debug')
        return undefined
      }
    }
    const model = await tryGet(() => u.cmdGetDeviceModel(), '型号')
    if (model !== undefined) out.model = DeviceModel[model] ?? String(model)
    out.appVersion = await tryGet(() => u.cmdGetAppVersion(), '固件版本')
    out.gitVersion = await tryGet(() => u.cmdGetGitVersion(), 'git 版本')
    out.chipId = await tryGet(() => u.cmdGetDeviceChipId(), '芯片 ID')
    out.battery = await tryGet(() => u.cmdGetBatteryInfo(), '电量')
    const mode = await tryGet(() => u.cmdGetDeviceMode(), '当前模式')
    if (mode !== undefined) out.mode = DeviceMode[mode] ?? String(mode)
    const slot = await tryGet(() => u.cmdSlotGetActive(), '激活槽位')
    if (slot !== undefined) out.activeSlot = slot
    return out
  }

  async readSlots (): Promise<SlotInfo[]> {
    const u = this.ultra
    const [infos, enabled, names] = await (async () => {
      const a = await u.cmdSlotGetInfo()
      const b = await u.cmdSlotGetIsEnable()
      const c = await u.cmdSlotGetFreqNames().catch(() => [])
      return [a, b, c] as const
    })()
    return Array.from({ length: SLOT_COUNT }, (_, i) => ({
      slot: i,
      hfTagType: infos[i]?.hfTagType ?? TagType.UNDEFINED,
      lfTagType: infos[i]?.lfTagType ?? TagType.UNDEFINED,
      hfName: (names as any)?.[i]?.[FreqType.HF] ?? undefined,
      lfName: (names as any)?.[i]?.[FreqType.LF] ?? undefined,
      hfEnabled: !!enabled[i]?.hf,
      lfEnabled: !!enabled[i]?.lf,
    }))
  }

  async setActiveSlot (slot: number): Promise<void> {
    await this.ultra.cmdSlotSetActive(slot as Slot)
    this.info.activeSlot = slot
    this.onLog(`激活槽位 ${slot + 1}`, 'ok')
  }

  async setSlotTagType (slot: number, tagType: TagType): Promise<void> {
    await this.ultra.cmdSlotChangeTagType(slot as Slot, tagType)
    this.onLog(`槽位 ${slot + 1} 类型 → ${TagType[tagType]}`, 'ok')
    this.slots = await this.readSlots()
  }

  /** @deprecated 用 setSlotTagType，tagType 自己决定是 HF 还是 LF */
  async setSlotHfTagType (slot: number, tagType: TagType): Promise<void> {
    await this.setSlotTagType(slot, tagType)
  }

  async setSlotEnable (slot: number, freq: FreqType, enable: boolean): Promise<void> {
    await this.ultra.cmdSlotSetEnable(slot as Slot, freq, enable)
    this.slots = await this.readSlots()
  }

  async setSlotName (slot: number, freq: FreqType, name: string): Promise<void> {
    await this.ultra.cmdSlotSetFreqName(slot as Slot, freq, name)
    this.slots = await this.readSlots()
  }

  async saveSlotSettings (): Promise<void> {
    await this.ultra.cmdSlotSaveSettings()
    this.onLog('槽位设置已保存到设备', 'ok')
  }

  async assureReader (): Promise<void> {
    await this.ultra.assureDeviceMode(DeviceMode.READER)
    this.info.mode = 'READER'
  }

  async scanHf (): Promise<CardScan[]> {
    await this.assureReader()
    const tags = await this.ultra.cmdHf14aScan()
    return tags.map(t => ({
      uid: hex(t.uid),
      atqa: hex(t.atqa),
      sak: hex(t.sak),
      ats: hex(t.ats ?? Buffer.alloc(0)),
    }))
  }

  /** SAK → 猜测卡片类型 */
  static guessCardType (scan: CardScan): string {
    const sak = (parseInt(scan.sak || '0', 16) || 0) & 0x7f
    const uidLen = scan.uid.length / 2
    if (scan.atqa === '0044' && sak === 0x00) return 'Mifare Ultralight / NTAG (MF0)'
    if (sak === 0x00 && scan.atqa === '4403') return 'Mifare Ultralight C'
    if (sak === 0x08) return 'Mifare Classic 1K'
    if (sak === 0x18) return 'Mifare Classic 4K'
    if (sak === 0x09) return 'Mifare Mini'
    if (sak === 0x10 || sak === 0x11) return 'Mifare Plus'
    if (sak === 0x20) return 'ISO 14443-4 (DESFire/JCOP)'
    if (sak === 0x28) return 'SmartMX / JCOP'
    if (uidLen === 7) return `ISO14443-4 卡（7 字节 UID, SAK ${scan.sak}）`
    return `未知类型（SAK ${scan.sak}）`
  }

  /**
   * 用密钥字典读整张 Mifare Classic 卡。
   * 关键：先扫一次拿到 SAK，按真实容量限定扇区数（maxSectors），否则固件会把不存在的扇区也拖一遍。
   */
  async mf1ReadCard (
    keys: Buffer[],
    onProgress: ProgressFn = () => {},
    opts: { scan?: CardScan | null, shouldCancel?: () => boolean } = {},
  ): Promise<Mf1Dump> {
    const u = this.ultra
    const { shouldCancel } = opts
    const checkCancel = (): void => { if (shouldCancel?.()) throw new Error('已取消') }
    await this.assureReader()

    onProgress('扫描卡片确定容量…', 3)
    const scan = opts.scan ?? (await this.scanHf())[0]
    if (!scan) throw new Error('没扫到卡，把卡贴到天线上再试')
    const geo = mf1GeometryFromSak(scan.sak)
    this.onLog(`卡片：${scan.uid} SAK=${scan.sak} → ${geo.sectors} 扇区 / ${geo.blocks} 块`, 'info')
    checkCancel()

    // 预检：SAK 不像 Classic 时，先让设备自己判断一下，避免白白做几十次认证
    const sakByte = (parseInt(scan.sak || '00', 16) || 0) & 0x7f
    const looksMf1 = sakByte === 0x08 || sakByte === 0x09 || sakByte === 0x18
    if (!looksMf1) {
      onProgress('预检：确认是不是 MIFARE Classic…', 5)
      const ok = await u.cmdMf1IsSupport().catch(() => false)
      if (!ok) {
        throw new Error(`这张卡不是 MIFARE Classic（SAK=0x${sakByte.toString(16).padStart(2, '0')}），MIFARE 认证不可能成功。请改用「读取 MF0/NTAG」，或先 HF 扫描看卡型`)
      }
      this.onLog('SAK 不像 Classic，但设备预检通过，继续尝试', 'warn')
    }
    checkCancel()

    // 逐扇区检查密钥：用 MF1_CHECK_KEYS_ON_BLOCK(2015)，响应只有几个字节。
    // 不用 mf1CheckKeysOfSectors(2012) 是因为它的响应固定 490 字节，
    // Chrome Web Serial 默认 bufferSize=255，大包容易被截断导致读循环永远等不到完整帧。
    const blocks: (string | null)[] = new Array(geo.blocks).fill(null)
    const keyMap: Mf1Dump['keys'] = {}
    let sectorsOk = 0

    const findKey = async (block: number, keyType: number): Promise<Buffer | null> => {
      // MF1_CHECK_KEYS_ON_BLOCK 单次最多 (512-3)/6 = 84 个密钥，字典大了要分块
      const MAX_KEYS = 80
      for (let i = 0; i < keys.length; i += MAX_KEYS) {
        const chunk = keys.slice(i, i + MAX_KEYS)
        try {
          const found = await u.cmdMf1CheckKeysOfBlock({ block, keyType: keyType as any, keys: chunk })
          if (found && found.length >= 6) return Buffer.from(found.subarray(0, 6))
        } catch (err: any) {
          if (!u.isConnected()) throw err
        }
      }
      return null
    }

    for (let s = 0; s < geo.sectors; s++) {
      checkCancel()
      const [start, count] = sectorLayout(s)
      const trailer = Math.min(start + count - 1, geo.blocks - 1)

      onProgress(`扇区 ${s + 1}/${geo.sectors}：找密钥…`, 6 + Math.round((s / geo.sectors) * 84))
      let keyA = await findKey(trailer, 0x60)
      let keyB: Buffer | null = null
      if (keyA) {
        // 已经能读 trailer 了，直接从尾块取 key B，省一次爆破
        try {
          const t = await u.cmdMf1ReadBlock({ block: trailer, keyType: 0x60 as any, key: keyA })
          keyB = Buffer.from(t.subarray(10, 16))
          if (keyB.every((x: number) => x === 0)) keyB = null
        } catch {}
      } else {
        keyB = await findKey(trailer, 0x61)
      }
      if (!keyA && !keyB) continue

      sectorsOk++
      keyMap[s] = { a: keyA ? hex(keyA) : undefined, b: keyB ? hex(keyB) : undefined }
      this.onLog(`扇区 ${s}: KEY_A=${keyA ? hex(keyA) : '—'} KEY_B=${keyB ? hex(keyB) : '—'}`, 'debug')

      for (let i = 0; i < count; i++) {
        const block = start + i
        if (block >= geo.blocks) break
        checkCancel()
        for (const [keyType, key] of [[0x60, keyA], [0x61, keyB]] as const) {
          if (!key) continue
          try {
            blocks[block] = hex(await u.cmdMf1ReadBlock({ block, keyType: keyType as any, key }))
            break
          } catch (err: any) {
            if (!u.isConnected()) throw err
          }
        }
      }
    }

    if (sectorsOk === 0) throw new Error('一个密钥都没命中，换更大的字典或先试 Gen1a 快读')

    const readCount = blocks.filter(b => b !== null).length
    this.onLog(`读完：${readCount}/${geo.blocks} 块（${sectorsOk}/${geo.sectors} 扇区有密钥）`, 'ok')
    return {
      kind: 'mf1',
      tagType: mf1TagTypeOf(geo.blocks),
      blocks,
      keys: keyMap,
      scan,
      createdAt: new Date().toISOString(),
    }
  }

  /** Gen1a 后门卡（UID 卡/魔术卡）绕过密钥直接全卡读 */
  async mf1Gen1aReadCard (
    onProgress: ProgressFn = () => {},
    opts: { shouldCancel?: () => boolean } = {},
  ): Promise<Mf1Dump> {
    const u = this.ultra
    const checkCancel = (): void => { if (opts.shouldCancel?.()) throw new Error('已取消') }
    await this.assureReader()
    const blockCount = 256
    const blocks: (string | null)[] = new Array(blockCount).fill(null)
    for (let b = 0; b < blockCount; b++) {
      checkCancel()
      try {
        blocks[b] = hex(await u.mf1Gen1aReadBlocks(b, 1))
      } catch (err: any) {
        if (!u.isConnected()) throw err
        // 4096 卡在 256 块之后会报错，1K 卡读到 64 块后报错
        if (b >= 64 && blocks.slice(0, b).some(x => x !== null)) break
      }
      if (b % 16 === 0) onProgress(`Gen1a 读取 ${b}/${blockCount}`, 5 + Math.round((b / blockCount) * 90))
    }
    const readCount = blocks.filter(b => b !== null).length
    if (readCount === 0) throw new Error('Gen1a 读取失败：这张卡不是后门卡，或未开启 Gen1a 模式')
    // 找出真实块数
    let realCount = 64
    if (blocks.slice(128).some(x => x !== null)) realCount = 256
    else if (blocks.slice(64, 128).some(x => x !== null)) realCount = 128
    this.onLog(`Gen1a 读完：${readCount} 块`, 'ok')
    return {
      kind: 'mf1',
      tagType: mf1TagTypeOf(realCount),
      blocks: blocks.slice(0, realCount),
      keys: {},
      createdAt: new Date().toISOString(),
    }
  }

  /** 读 Mifare Ultralight / NTAG */
  async mfuReadCard (onProgress: ProgressFn = () => {}): Promise<MfuDump> {
    const u = this.ultra
    await this.assureReader()
    onProgress('读取 MF0/NTAG…', 20)
    const dump = await u.mfuReadDump()
    if (dump.length === 0) throw new Error('MF0 读取失败：不是 Ultralight/NTAG 卡？')
    onProgress('完成', 100)
    this.onLog(`MF0 dump ${dump.length} 字节（${dump.length / 4} 页）`, 'ok')
    return {
      kind: 'mfu',
      tagType: TagType.NTAG_215,
      data: hex(dump),
      createdAt: new Date().toISOString(),
    }
  }

  /** LF 扫描：依次试 EM410x / HID Prox / Viking（没卡会超时，属正常） */
  async scanLf (onProgress: ProgressFn = () => {}): Promise<LfScan[]> {
    const u = this.ultra
    await this.assureReader()
    const out: LfScan[] = []

    onProgress('LF：试 EM410x…', 20)
    try {
      const r = await u.cmdEm410xScan()
      out.push({ kind: 'em410x', type: TagType[r.tagType] ?? 'EM410X', tagType: r.tagType, id: hex(r.id), raw: r })
      this.onLog(`EM410x: ${hex(r.id)}`, 'ok')
    } catch (err: any) {
      if (!u.isConnected()) throw err
      this.onLog(`EM410x 未检到：${err?.message ?? err}`, 'debug')
    }

    onProgress('LF：试 HID Prox…', 50)
    try {
      const t = await u.cmdHidProxScan()
      out.push({ kind: 'hidprox', type: 'HID Prox', tagType: TagType.HIDProx, id: `FC ${t.fc} / CN ${t.cn} / IL ${t.il}`, raw: t })
      this.onLog(`HID Prox: FC ${t.fc} CN ${t.cn}`, 'ok')
    } catch (err: any) {
      if (!u.isConnected()) throw err
      this.onLog(`HID Prox 未检到：${err?.message ?? err}`, 'debug')
    }

    onProgress('LF：试 Viking…', 80)
    try {
      const v = await u.cmdVikingScan()
      if (v.length > 0) {
        out.push({ kind: 'viking', type: 'Viking', tagType: TagType.Viking, id: hex(v), raw: v })
        this.onLog(`Viking: ${hex(v)}`, 'ok')
      }
    } catch (err: any) {
      if (!u.isConnected()) throw err
      this.onLog(`Viking 未检到：${err?.message ?? err}`, 'debug')
    }
    return out
  }

  /** 把扫到的 LF 卡号写入槽位当模拟卡 */
  async writeLfToSlot (slot: number, scan: LfScan, onProgress: ProgressFn = () => {}): Promise<void> {
    const u = this.ultra
    onProgress(`切换到槽位 ${slot + 1}`, 10)
    await u.cmdSlotSetActive(slot as Slot)
    await u.cmdSlotChangeTagType(slot as Slot, scan.tagType)
    onProgress('写入 LF 模拟 ID', 50)
    if (scan.kind === 'hidprox') {
      await u.cmdHidProxSetEmu(scan.raw)
    } else if (scan.kind === 'viking') {
      await u.cmdVikingSetEmuId(scan.raw)
    } else {
      await u.cmdEm410xSetEmuId(scan.raw)
    }
    onProgress('保存设置', 90)
    await this.saveSlotSettings()
    this.slots = await this.readSlots()
    this.info.activeSlot = slot
    onProgress('完成', 100)
  }

  /** 把 MF1 dump 写进某个槽位当模拟卡用 */
  async writeMf1ToSlot (slot: number, dump: Mf1Dump, onProgress: ProgressFn = () => {}): Promise<void> {
    const u = this.ultra
    const blocks = dump.blocks.map(b => (b ? Buffer.from(b, 'hex') : Buffer.alloc(16)))
    const tagType = mf1TagTypeOf(blocks.length)
    onProgress(`切换到槽位 ${slot + 1}`, 5)
    await u.cmdSlotSetActive(slot as Slot)
    await u.cmdSlotChangeTagType(slot as Slot, tagType)
    await u.cmdSlotResetTagType(slot as Slot, tagType)
    const CHUNK = 32
    for (let i = 0; i < blocks.length; i += CHUNK) {
      const chunk = Buffer.concat(blocks.slice(i, i + CHUNK))
      await u.cmdMf1EmuWriteBlock(i, chunk)
      onProgress(`写入块 ${i}–${Math.min(i + CHUNK, blocks.length) - 1}`, 5 + Math.round((i / blocks.length) * 80))
    }
    // UID / ATQA / SAK 不在块 0 里，必须单独写防冲突数据（固件默认 use_mf1_coll_res=false）
    if (dump.scan) {
      try {
        const uid = Buffer.from(dump.scan.uid, 'hex')
        if ([4, 7, 10].includes(uid.length)) {
          await u.cmdHf14aSetAntiCollData({
            uid,
            atqa: Buffer.from(dump.scan.atqa, 'hex'),
            sak: Buffer.from(dump.scan.sak, 'hex'),
            ats: dump.scan.ats ? Buffer.from(dump.scan.ats, 'hex') : undefined,
          })
          this.onLog('已写入 UID/ATQA/SAK', 'ok')
        }
      } catch (err: any) {
        this.onLog(`写防冲突数据失败：${err?.message ?? err}`, 'warn')
      }
    }
    onProgress('保存设置', 95)
    await this.saveSlotSettings()
    this.slots = await this.readSlots()
    this.info.activeSlot = slot
    onProgress('完成', 100)
  }

  /** 把 MF0 dump 写进槽位 */
  async writeMfuToSlot (slot: number, dump: MfuDump, tagType: TagType, onProgress: ProgressFn = () => {}): Promise<void> {
    const u = this.ultra
    onProgress(`切换到槽位 ${slot + 1}`, 10)
    await u.cmdSlotSetActive(slot as Slot)
    await u.cmdSlotChangeTagType(slot as Slot, tagType)
    await u.cmdSlotResetTagType(slot as Slot, tagType)
    onProgress('写入页数据', 50)
    await u.mfuWriteEmuDump(Buffer.from(dump.data, 'hex'))
    if (dump.scan) {
      try {
        const uid = Buffer.from(dump.scan.uid, 'hex')
        if ([4, 7, 10].includes(uid.length)) {
          await u.cmdHf14aSetAntiCollData({
            uid,
            atqa: Buffer.from(dump.scan.atqa, 'hex'),
            sak: Buffer.from(dump.scan.sak, 'hex'),
          })
        }
      } catch (err: any) {
        this.onLog(`写防冲突数据失败：${err?.message ?? err}`, 'warn')
      }
    }
    onProgress('保存设置', 90)
    await this.saveSlotSettings()
    this.slots = await this.readSlots()
    this.info.activeSlot = slot
    onProgress('完成', 100)
  }
}

/** 常用 MF1 密钥字典 */
export const DEFAULT_KEYS: string[] = [
  'FFFFFFFFFFFF', '000000000000', 'A0A1A2A3A4A5', 'D3F7D3F7D3F7',
  '4D3A99C351DD', '1A982C7E459A', 'AABBCCDDEEFF', '714C5C886E97',
  '587EE5F9350F', 'A0478CC39091', '533CB6C723F6', '8FD0A4F256E9',
  'B0B1B2B3B4B5', '000000000001', 'A0A1A2A3A4A6', 'AAFFFFFFFFFFFF',
  '5C8FF9990DA2', 'D01AFEEB890A', '75CCB59C9BED', '010203040506',
  '123456789012', 'ABCDEF123456', '0A0B0C0D0E0F', 'BABECAFEBABE',
  '44464952455A', 'CAFEBABE0000', '3456789ABCDE', '998877665544',
  'A64598765432', 'FC00018778F7', '0297927C0F77', '5A7A7D7B7C7D',
]

export const LF_TAG_TYPE_OPTIONS: TagType[] = [
  TagType.UNDEFINED,
  TagType.EM410X,
  TagType.EM410X_16,
  TagType.EM410X_32,
  TagType.EM410X_64,
  TagType.EM410X_ELECTRA,
  TagType.Viking,
  TagType.HIDProx,
]

export const HF_TAG_TYPE_OPTIONS: TagType[] = [
  TagType.UNDEFINED,
  TagType.MIFARE_Mini,
  TagType.MIFARE_1024,
  TagType.MIFARE_2048,
  TagType.MIFARE_4096,
  TagType.MF0_ICU1,
  TagType.MF0_ICU2,
  TagType.MF0_UL11,
  TagType.MF0_UL21,
  TagType.NTAG_210,
  TagType.NTAG_212,
  TagType.NTAG_213,
  TagType.NTAG_215,
  TagType.NTAG_216,
]
