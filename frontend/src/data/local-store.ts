import { SEED_ROWS, SEED_VERSION } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'drainage-pump:entries'
const BACKUP_KEY = 'drainage-pump:entries:backup'
// 同一份真实数据最多留几份备份，避免「越初始化越多」也发生在备份上。
const BACKUP_LIMIT = 5

// 各模块的业务编号字段：初始化前要做唯一性校验，重复的冲突记录直接挡回。
const CODE_FIELDS: Record<string, string> = {
  pumpstation: '站名',
  pumprun: '运行编号',
  drainpipe: '管段编号',
  manhole: '井编号',
  dredge: '清淤编号',
  waterlevel: '监测编号',
  rainfall: '监测编号',
  waterlog: '内涝编号',
  floodgate: '调度编号',
  pumpmaint: '检修编号',
  sluice: '检修编号',
  screen: '清污编号',
  outfallpatrol: '巡查编号',
  floodwarn: '预警编号',
  rescueteam: '任务编号',
  drainequipment: '设备编号',
  cctvinspect: '检测编号',
  dispatchplan: '方案编号',
}

// 落盘信封：带版本号与初始化时间，重复执行初始化时据此判断是否需要重灌。
export type EntriesEnvelope = {
  version: string
  seededAt: string
  entries: Record<string, EntryRow[]>
}

export type InitReport = {
  action: 'seeded' | 'reseeded' | 'skipped'
  modules: number
  records: number
  backupKey: string | null
  reason: string
}

// 初始化失败：包含被挡回的冲突记录，方便交代清楚后重试。
export class SeedConflictError extends Error {
  conflicts: { module: string; field: string; code: string; rowIds: number[] }[]
  constructor(conflicts: { module: string; field: string; code: string; rowIds: number[] }[]) {
    const lines = conflicts.map(
      (item) =>
        `模块「${item.module}」字段「${item.field}」的编号「${item.code}」同时出现在记录 ${item.rowIds.join(
          '、',
        )} 上`,
    )
    super(`示例数据编号冲突，已挡回未写入：\n${lines.join('\n')}`)
    this.name = 'SeedConflictError'
    this.conflicts = conflicts
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 存储端口：浏览器里走 localStorage，Node/测试里可注入内存实现，同一条初始化路径两边都能跑。
export interface StoragePort {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
  readonly length?: number
  key?(index: number): string | null
}

class MemoryStorage implements StoragePort {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  get length(): number {
    return this.map.size
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
}

function defaultStorage(): StoragePort {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage
  }
  // SSR / Node（如初始化自检脚本）下落内存，调用方仍能完整走一遍幂等流程。
  return new MemoryStorage()
}

let storage: StoragePort = defaultStorage()
let cache: EntriesEnvelope | null = null

// 仅供测试/自检切换存储实现；切回真实存储时清空内存缓存强制重读。
export function bindStorage(port: StoragePort | null): void {
  storage = port ?? defaultStorage()
  cache = null
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function seedVersion(): string {
  return SEED_VERSION
}

function canonicalEnvelope(): EntriesEnvelope {
  return {
    version: SEED_VERSION,
    seededAt: new Date().toISOString(),
    entries: clone(SEED_ROWS),
  }
}

// 初始化前校验示例数据本身：编号字段不允许两条记录同时重复，重复则整条初始化挡回。
export function validateSeed(
  rows: Record<string, EntryRow[]>,
): { module: string; field: string; code: string; rowIds: number[] }[] {
  const conflicts: { module: string; field: string; code: string; rowIds: number[] }[] = []
  for (const [key, list] of Object.entries(rows)) {
    const field = CODE_FIELDS[key]
    const seen = new Map<string, number[]>()
    for (const row of list) {
      const code = field ? String(row[field] ?? '').trim() : String(row.id)
      if (!code) {
        continue
      }
      const ids = seen.get(code) ?? []
      ids.push(Number(row.id))
      seen.set(code, ids)
    }
    for (const [code, ids] of seen) {
      if (ids.length > 1) {
        conflicts.push({ module: key, field: field ?? 'id', code, rowIds: ids })
      }
    }
  }
  return conflicts
}

function sameCanonical(entries: Record<string, EntryRow[]>): boolean {
  const seed = SEED_ROWS
  const seedKeys = Object.keys(seed)
  if (Object.keys(entries).length !== seedKeys.length) {
    return false
  }
  return seedKeys.every((key) => JSON.stringify(entries[key] ?? null) === JSON.stringify(seed[key]))
}

// 覆盖前先把现有真实数据备份下来；初始化失败时靠它回滚，之后也能找回。
function backupExisting(raw: string | null): string | null {
  if (raw === null) {
    return null
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const key = `${BACKUP_KEY}:${stamp}`
  storage.setItem(key, raw)
  pruneBackups()
  return key
}

function pruneBackups(): void {
  if (typeof storage.length !== 'number' || typeof storage.removeItem !== 'function') {
    return
  }
  const keys: string[] = []
  for (let i = 0; i < storage.length; i += 1) {
    const name = storage.key?.(i)
    if (name && name.startsWith(`${BACKUP_KEY}:`)) {
      keys.push(name)
    }
  }
  keys.sort()
  for (const stale of keys.slice(0, Math.max(0, keys.length - BACKUP_LIMIT))) {
    storage.removeItem(stale)
  }
}

function writeEnvelope(envelope: EntriesEnvelope, previousRaw: string | null): void {
  const serialized = JSON.stringify(envelope)
  // 先写一个草稿键，读回比对一致才提交：写入半截时旧数据原封不动，可直接重试。
  const draftKey = `${STORAGE_KEY}:draft`
  try {
    storage.setItem(draftKey, serialized)
    const readback = storage.getItem(draftKey)
    if (readback !== serialized) {
      throw new Error('写入后读回的示例数据与待写入内容不一致，已保留原数据，可重试初始化')
    }
    storage.setItem(STORAGE_KEY, serialized)
    const committed = storage.getItem(STORAGE_KEY)
    if (committed !== serialized) {
      throw new Error('示例数据提交后读回校验失败，已保留原数据，可重试初始化')
    }
    storage.removeItem?.(draftKey)
  } catch (error) {
    storage.removeItem?.(draftKey)
    if (previousRaw !== null && storage.getItem(STORAGE_KEY) !== previousRaw) {
      try {
        storage.setItem(STORAGE_KEY, previousRaw)
      } catch {
        // 回滚也失败时保留错误继续抛出，调用方据提示重试。
      }
    }
    // 统一包成「可重试」错误：底层原因（如配额已满）交代清楚，原数据保持不动。
    if (error instanceof Error && /可重试/.test(error.message)) {
      throw error
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`示例数据写入失败：${detail}；原有数据已保留，可重试初始化`)
  }
}

function loadEnvelope(): { envelope: EntriesEnvelope | null; raw: string | null; corrupted: boolean } {
  const raw = storage.getItem(STORAGE_KEY)
  if (raw === null) {
    return { envelope: null, raw: null, corrupted: false }
  }
  try {
    const parsed = JSON.parse(raw) as
      | EntriesEnvelope
      | Record<string, EntryRow[]>
      | EntryRow[]
      | null
    // 新信封：{ version, seededAt, entries }
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as EntriesEnvelope).version === 'string' &&
      (parsed as EntriesEnvelope).entries &&
      typeof (parsed as EntriesEnvelope).entries === 'object'
    ) {
      return { envelope: parsed as EntriesEnvelope, raw, corrupted: false }
    }
    // 旧格式（裸 Record<模块, 行[]>，含早期非幂等初始化残留）：按整组数据处理，不与新种子合并。
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        envelope: { version: 'legacy', seededAt: '', entries: parsed as Record<string, EntryRow[]> },
        raw,
        corrupted: false,
      }
    }
    return { envelope: null, raw, corrupted: true }
  } catch {
    return { envelope: null, raw, corrupted: true }
  }
}

/**
 * 幂等初始化（本地开发这条初始化路径的唯一入口）：
 * - 先校验编号唯一性，冲突整条挡回，不写任何数据；
 * - 已是同一版示例数据则跳过，重复执行不产生重复记录；
 * - 旧数据/旧版本/损坏数据先备份再按模块整组覆盖；
 * - 写入做读回校验，失败自动回滚并允许重试。
 */
export function initializeSeedData(options: { force?: boolean } = {}): InitReport {
  const force = options.force === true
  const conflicts = validateSeed(SEED_ROWS)
  if (conflicts.length > 0) {
    throw new SeedConflictError(conflicts)
  }

  const { envelope, raw, corrupted } = loadEnvelope()

  if (!force && envelope && envelope.version === SEED_VERSION && sameCanonical(envelope.entries)) {
    cache = envelope
    return {
      action: 'skipped',
      modules: Object.keys(envelope.entries).length,
      records: Object.values(envelope.entries).reduce((sum, list) => sum + list.length, 0),
      backupKey: null,
      reason: '本地保存的示例数据与当前版本一致，无需重新灌入',
    }
  }

  let backupKey: string | null = null
  if (raw !== null) {
    backupKey = backupExisting(raw)
  }

  const next = canonicalEnvelope()
  writeEnvelope(next, raw)
  cache = next

  return {
    action: force || envelope !== null || corrupted ? 'reseeded' : 'seeded',
    modules: Object.keys(next.entries).length,
    records: Object.values(next.entries).reduce((sum, list) => sum + list.length, 0),
    backupKey,
    reason: corrupted
      ? '原有示例数据已损坏，已备份后按当前版本重新灌入'
      : backupKey
        ? '原有数据已备份，示例数据已按当前版本重新灌入'
        : '示例数据已首次灌入',
  }
}

function allEnvelope(): EntriesEnvelope {
  if (cache === null) {
    // 读路径只取数据，绝不落盘：损坏时退回内存种子，等初始化入口走「备份 + 覆盖 + 校验」。
    const loaded = loadEnvelope()
    cache = loaded.envelope ?? canonicalEnvelope()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return allEnvelope().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function getRow(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === Number(id))
}

export function statusCounts(key: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of listRows(key)) {
    const name = String(row.status)
    counts[name] = (counts[name] ?? 0) + 1
  }
  return counts
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const envelope = allEnvelope()
  const next: EntriesEnvelope = {
    ...envelope,
    entries: { ...envelope.entries, [key]: rows },
  }
  cache = next
  storage.setItem(STORAGE_KEY, JSON.stringify(next))
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// 备份清单：初始化覆盖过真实数据时，可以在控制台里据此找回。
export function listBackups(): string[] {
  if (typeof storage.length !== 'number') {
    return []
  }
  const keys: string[] = []
  for (let i = 0; i < storage.length; i += 1) {
    const name = storage.key?.(i)
    if (name && name.startsWith(`${BACKUP_KEY}:`)) {
      keys.push(name)
    }
  }
  return keys.sort()
}
