/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  /** 本行是否由示例数据初始化写入（重新灌入时按它区分示例记录与真实记录）。 */
  __seed?: boolean
  /** 写入该行时的示例数据版本。 */
  __seedVersion?: number
  [field: string]: string | number | boolean | undefined
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 业务编号字段：初始化时按它做唯一性校验与幂等合并，缺省时按 id 处理。 */
  codeField?: string
  /** 名称无法直接对应状态的统计卡，在这里显式指定按哪个状态计数。 */
  metricOverrides?: Record<string, string>
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 初始化执行方式：首次播种 / 旧库迁移 / 版本升级 / 坏数据修复 / 强制重灌 / 已是最新。 */
export type InitMode =
  | 'fresh'
  | 'migrated'
  | 'upgraded'
  | 'repaired'
  | 'reseeded'
  | 'unchanged'

/** 业务编号冲突明细：挡回初始化时要把冲突双方交代清楚。 */
export type InitConflict = {
  module: string
  moduleName: string
  field: string
  code: string
  records: { id: number; name: string; scope: string }[]
}

export type InitReport = {
  mode: InitMode
  version: number
  /** 覆盖前把旧数据备份到的存储键；没有可备份的数据时为 null。 */
  backupKey: string | null
  counts: Record<string, number>
  /** 强制重灌时，编号与示例记录撞号而被保留下来的真实记录编号（示例记录让位，不产生重复）。 */
  skippedSeedCodes: Record<string, string[]>
}

export type BackupMeta = {
  key: string
  createdAt: string
  reason: string
  version: number | null
}
