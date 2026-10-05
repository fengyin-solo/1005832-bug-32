import { MODULES } from './modules'
import { SEED_ROWS, SEED_VERSION } from './seed'
import type { BackupMeta, EntryRow, InitConflict, InitMode, InitReport } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'drainage-pump:entries'
const META_KEY = 'drainage-pump:entries:meta'
const BACKUP_PREFIX = 'drainage-pump:entries:backup:'
// 只保留最近若干份备份，避免反复初始化把 localStorage 撑爆。
const BACKUP_LIMIT = 5

/** 键值存储抽象：浏览器走 localStorage，自测脚本可注入内存实现。 */
export interface KVStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  keyNames(): string[]
}

class MemoryStore implements KVStore {
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
  keyNames(): string[] {
    return [...this.map.keys()]
  }
}

function defaultStore(): KVStore {
  if (typeof window !== 'undefined' && window.localStorage) {
    const native = window.localStorage
    return {
      getItem: (key) => native.getItem(key),
      setItem: (key, value) => native.setItem(key, value),
      removeItem: (key) => native.removeItem(key),
      keyNames: () => {
        const names: string[] = []
        for (let i = 0; i < native.length; i += 1) {
          const name = native.key(i)
          if (name !== null) {
            names.push(name)
          }
        }
        return names
      },
    }
  }
  // 极个别禁用 localStorage 的环境：降级到内存，至少本次会话可用。
  return new MemoryStore()
}

let adapter: KVStore | null = null
let cache: Record<string, EntryRow[]> | null = null

/** 自测入口：替换示例数据源（模拟 seed 文件里被写入重复编号）。 */
export function __setSeedForTest(custom: Record<string, EntryRow[]>): void {
  seedOverride = custom
}
let seedOverride: Record<string, EntryRow[]> | null = null

function seedRows(): Record<string, EntryRow[]> {
  return seedOverride ?? SEED_ROWS
}

function store(): KVStore {
  if (adapter === null) {
    adapter = defaultStore()
  }
  return adapter
}

/** 自测入口：换一套存储从头跑初始化。 */
export function __setStorageForTest(custom: KVStore): void {
  adapter = custom
  cache = null
}

export function storageKey(): string {
  return STORAGE_KEY
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type StoredMeta = { version: number | null; initializedAt: string | null }

function readMeta(): StoredMeta {
  const raw = store().getItem(META_KEY)
  if (!raw) {
    return { version: null, initializedAt: null }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredMeta>
    return {
      version: typeof parsed.version === 'number' ? parsed.version : null,
      initializedAt: typeof parsed.initializedAt === 'string' ? parsed.initializedAt : null,
    }
  } catch {
    return { version: null, initializedAt: null }
  }
}

function tagSeedRows(rows: EntryRow[]): EntryRow[] {
  return rows.map((row) => ({ ...row, __seed: true, __seedVersion: SEED_VERSION }))
}

function seedSnapshot(): Record<string, EntryRow[]> {
  const snapshot: Record<string, EntryRow[]> = {}
  for (const meta of MODULES) {
    snapshot[meta.key] = tagSeedRows(seedRows()[meta.key] ?? [])
  }
  return snapshot
}

/** 取记录里最适合给人看的名称字段与归属字段，冲突提示里要用。 */
function describeRow(
  fields: string[],
  row: EntryRow,
): { name: string; scope: string } {
  const nameField =
    fields.find((field) => field.endsWith('名称')) ??
    fields.find((field) => field.endsWith('编号')) ??
    fields[0]
  const scopeField = fields.find((field) =>
    /河渠|河段|片区|泵站|管段|区域|点位/.test(field),
  )
  return {
    name: nameField ? String(row[nameField] ?? `记录#${row.id}`) : `记录#${row.id}`,
    scope: scopeField ? String(row[scopeField] ?? '未填写归属') : '未填写归属',
  }
}

/**
 * 初始化前的硬校验：示例数据自身不允许有重复业务编号。
 * 命中就抛 SeedConflictError，整批挡回、一条都不写入。
 */
export class SeedConflictError extends Error {
  conflicts: InitConflict[]
  constructor(conflicts: InitConflict[]) {
    super(buildConflictMessage(conflicts))
    this.name = 'SeedConflictError'
    this.conflicts = conflicts
  }
}

function buildConflictMessage(conflicts: InitConflict[]): string {
  const lines = conflicts.map((conflict) => {
    const detail = conflict.records
      .map((record) => `#${record.id} ${record.name}（${record.scope}）`)
      .join('、')
    return `${conflict.moduleName}模块有 ${conflict.records.length} 条记录的${conflict.field}重复「${conflict.code}」：${detail}`
  })
  return `示例数据初始化被挡回：${lines.join('；')}。请修改示例数据解除重复后重试，本次未写入任何数据。`
}

function validateSeedData(data: Record<string, EntryRow[]>): void {
  const conflicts: InitConflict[] = []
  for (const meta of MODULES) {
    const rows = data[meta.key] ?? []
    const seenIds = new Map<number, EntryRow[]>()
    const codeField = meta.codeField
    const seenCodes = new Map<string, EntryRow[]>()
    for (const row of rows) {
      if (typeof row.id !== 'number' || !Number.isFinite(row.id)) {
        throw new Error(`${meta.name}示例数据存在非法 id，初始化中止，请修正后重试`)
      }
      if (!meta.statuses.includes(String(row.status))) {
        throw new Error(
          `${meta.name}示例数据里记录#${row.id}的状态「${row.status}」不在登记状态 ${meta.statuses.join('/')} 内，初始化中止`,
        )
      }
      const idGroup = seenIds.get(row.id) ?? []
      idGroup.push(row)
      seenIds.set(row.id, idGroup)
      if (codeField) {
        const code = String(row[codeField] ?? '').trim()
        if (!code) {
          throw new Error(`${meta.name}示例数据里记录#${row.id}缺少${codeField}，初始化中止`)
        }
        const codeGroup = seenCodes.get(code) ?? []
        codeGroup.push(row)
        seenCodes.set(code, codeGroup)
      }
    }
    const pushConflict = (field: string, value: string, group: EntryRow[]) => {
      conflicts.push({
        module: meta.key,
        moduleName: meta.name,
        field,
        code: value,
        records: group.map((row) => {
          const described = describeRow(meta.fields, row)
          return { id: row.id, name: described.name, scope: described.scope }
        }),
      })
    }
    for (const [id, group] of seenIds) {
      if (group.length > 1) {
        pushConflict('id', String(id), group)
      }
    }
    if (codeField) {
      for (const [code, group] of seenCodes) {
        if (group.length > 1) {
          pushConflict(codeField, code, group)
        }
      }
    }
  }
  if (conflicts.length > 0) {
    throw new SeedConflictError(conflicts)
  }
}

function readStored(): {
  data: Record<string, EntryRow[]> | null
  corrupt: boolean
  hasRaw: boolean
} {
  const raw = store().getItem(STORAGE_KEY)
  if (raw === null) {
    return { data: null, corrupt: false, hasRaw: false }
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: null, corrupt: true, hasRaw: true }
    }
    return { data: parsed, corrupt: false, hasRaw: true }
  } catch {
    return { data: null, corrupt: true, hasRaw: true }
  }
}

function backupCurrent(reason: string): string | null {
  const raw = store().getItem(STORAGE_KEY)
  if (raw === null) {
    return null
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const key = `${BACKUP_PREFIX}${stamp}`
  const envelope = {
    createdAt: new Date().toISOString(),
    reason,
    version: readMeta().version,
    data: (() => {
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    })(),
  }
  store().setItem(key, JSON.stringify(envelope))
  pruneBackups()
  return key
}

function pruneBackups(): void {
  const keys = store()
    .keyNames()
    .filter((name) => name.startsWith(BACKUP_PREFIX))
    .sort()
  for (const stale of keys.slice(0, Math.max(0, keys.length - BACKUP_LIMIT))) {
    store().removeItem(stale)
  }
}

export function listBackups(): BackupMeta[] {
  return store()
    .keyNames()
    .filter((name) => name.startsWith(BACKUP_PREFIX))
    .sort()
    .reverse()
    .map((key) => {
      try {
        const envelope = JSON.parse(store().getItem(key) ?? '{}') as {
          createdAt?: string
          reason?: string
          version?: number | null
        }
        return {
          key,
          createdAt: envelope.createdAt ?? '',
          reason: envelope.reason ?? '初始化覆盖',
          version: typeof envelope.version === 'number' ? envelope.version : null,
        }
      } catch {
        return { key, createdAt: '', reason: '备份（无法解析元信息）', version: null }
      }
    })
}

/**
 * v1 旧库没有 __seed 标记。旧示例是仓库生成器批量写的，名称类字段统一是「xxx样例N」；
 * 迁移时据此把旧示例行与真实记录区分开：旧示例交给新示例替换，真实记录保留。
 */
const LEGACY_SEED_PATTERN = /样例\d+$/

function isLegacySeedRow(row: EntryRow): boolean {
  return Object.values(row).some(
    (value) => typeof value === 'string' && LEGACY_SEED_PATTERN.test(value.trim()),
  )
}

/**
 * 幂等合并：真实记录（__seed 不为真、且不是旧版占位示例）原样保留；旧示例记录按业务编号
 * 被新示例替换；真实记录与示例编号撞号时，进来的那条示例记录让位（挡回并登记），绝不产生重复。
 */
function mergeSeed(
  existing: Record<string, EntryRow[]>,
): { data: Record<string, EntryRow[]>; skipped: Record<string, string[]> } {
  const next: Record<string, EntryRow[]> = { ...existing }
  const skipped: Record<string, string[]> = {}
  for (const meta of MODULES) {
    const oldRows = existing[meta.key] ?? []
    // v1 旧库里的占位示例（无 __seed 标记但字段是「xxx样例N」）同样视为可替换的示例记录。
    const realRows = oldRows.filter(
      (row) => row.__seed !== true && !isLegacySeedRow(row),
    )
    const codeField = meta.codeField
    const occupiedCodes = new Set<string>()
    const occupiedIds = new Set<number>()
    for (const row of realRows) {
      occupiedIds.add(Number(row.id))
      if (codeField) {
        occupiedCodes.add(String(row[codeField] ?? '').trim())
      }
    }
    const seeded: EntryRow[] = []
    let nextId = Math.max(0, ...realRows.map((row) => Number(row.id) || 0))
    const skippedCodes: string[] = []
    for (const template of tagSeedRows(seedRows()[meta.key] ?? [])) {
      const code = codeField ? String(template[codeField] ?? '').trim() : ''
      if (codeField && occupiedCodes.has(code)) {
        // 同编号真实记录已存在：进来的示例记录挡回，不重复落库。
        skippedCodes.push(code)
        continue
      }
      const row = { ...template }
      if (occupiedIds.has(Number(row.id))) {
        nextId += 1
        row.id = nextId
      }
      occupiedIds.add(Number(row.id))
      if (code) {
        occupiedCodes.add(code)
      }
      seeded.push(row)
      nextId = Math.max(nextId, Number(row.id))
    }
    next[meta.key] = [...realRows, ...seeded]
    if (skippedCodes.length > 0) {
      skipped[meta.key] = skippedCodes
    }
  }
  return { data: next, skipped }
}

function commit(data: Record<string, EntryRow[]>): void {
  // 先落数据再落版本元信息：中途失败下一次初始化会整批重试，结果仍然幂等。
  store().setItem(STORAGE_KEY, JSON.stringify(data))
  store().setItem(
    META_KEY,
    JSON.stringify({ version: SEED_VERSION, initializedAt: new Date().toISOString() }),
  )
  cache = data
}

function countsOf(data: Record<string, EntryRow[]>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const meta of MODULES) {
    counts[meta.key] = (data[meta.key] ?? []).length
  }
  return counts
}

export type InitOptions = { force?: boolean }

/**
 * 本地开发初始化命令（应用启动时自动跑，也可在概览页手动重跑）。
 * 幂等保证：
 * - 示例数据先校验（业务编号重复整批挡回），出错不碰旧数据、可直接重试；
 * - 覆盖前先把旧数据整份备份；
 * - 真实记录保留，示例记录按业务编号替换，重复执行不产生重复记录；
 * - 已是当前版本且不强制重灌时直接 no-op。
 */
export function initDemoData(options: InitOptions = {}): InitReport {
  const force = options.force === true
  const seedForCheck = seedSnapshot()
  // 任何重复编号都在这里挡回，后面的备份/覆盖一步都不会执行。
  validateSeedData(seedForCheck)

  const { data: stored, corrupt, hasRaw } = readStored()
  const meta = readMeta()

  if (!corrupt && meta.version === SEED_VERSION && !force) {
    return {
      mode: 'unchanged',
      version: SEED_VERSION,
      backupKey: null,
      counts: countsOf(stored ?? {}),
      skippedSeedCodes: {},
    }
  }

  let mode: InitMode
  let backupKey: string | null = null
  let next: Record<string, EntryRow[]>
  let skippedSeedCodes: Record<string, string[]> = {}

  if (!hasRaw || stored === null || Object.keys(stored).length === 0) {
    mode = corrupt ? 'repaired' : 'fresh'
    backupKey = corrupt ? backupCurrent('示例数据损坏，初始化修复') : null
    next = seedSnapshot()
  } else if (meta.version === null) {
    mode = 'migrated'
    backupKey = backupCurrent('旧版本地库迁移到示例数据 v' + SEED_VERSION)
    ;({ data: next, skipped: skippedSeedCodes } = mergeSeed(stored))
  } else if (meta.version < SEED_VERSION) {
    mode = 'upgraded'
    backupKey = backupCurrent(
      `示例数据 v${meta.version} 升级到 v${SEED_VERSION}`,
    )
    ;({ data: next, skipped: skippedSeedCodes } = mergeSeed(stored))
  } else {
    mode = 'reseeded'
    backupKey = backupCurrent('手动重新灌入示例数据 v' + SEED_VERSION)
    ;({ data: next, skipped: skippedSeedCodes } = mergeSeed(stored))
  }

  commit(next)
  return {
    mode,
    version: SEED_VERSION,
    backupKey,
    counts: countsOf(next),
    skippedSeedCodes,
  }
}

function fallbackRows(): Record<string, EntryRow[]> {
  // 尚未初始化（或存储不可用）时的只读兜底，保证页面首屏也有示例可看。
  const fallback: Record<string, EntryRow[]> = {}
  for (const meta of MODULES) {
    fallback[meta.key] = clone(SEED_ROWS[meta.key] ?? [])
  }
  return fallback
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    const { data } = readStored()
    cache = data === null ? fallbackRows() : { ...fallbackRows(), ...data }
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  store().setItem(STORAGE_KEY, JSON.stringify(next))
}

/** 单个模块重置：先备份整库，再用当前版本示例替换该模块，其他模块不动。 */
export function resetRows(key: string): EntryRow[] {
  const { data: stored } = readStored()
  const base = stored === null ? fallbackRows() : { ...fallbackRows(), ...stored }
  backupCurrent(`重置模块「${key}」前自动备份`)
  const rows = tagSeedRows(SEED_ROWS[key] ?? [])
  const next = { ...base, [key]: rows }
  cache = next
  store().setItem(STORAGE_KEY, JSON.stringify(next))
  if (readMeta().version === null) {
    store().setItem(
      META_KEY,
      JSON.stringify({ version: SEED_VERSION, initializedAt: new Date().toISOString() }),
    )
  }
  return rows
}
