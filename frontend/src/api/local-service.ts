import { MODULE_BY_KEY, MODULES } from '@/data/modules'
import {
  allRows,
  initDemoData,
  listBackups,
  listRows,
  resetRows,
  saveRows,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  InitReport,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function getEntry(key: string, id: number): EntryRow | null {
  return listRows(key).find((row) => Number(row.id) === Number(id)) ?? null
}

/**
 * 状态只能顺着登记顺序向前走一步：待调度 → 调度中 → 已执行 → 已终止。
 * 不允许跳级（待调度不能直接确认执行），也不允许回头走（已执行不能再提交调度）。
 */
function guardTransition(meta: ModuleMeta, current: string, target: string): string | null {
  const from = meta.statuses.indexOf(current)
  const to = meta.statuses.indexOf(target)
  if (from < 0) {
    return `${meta.entity}当前状态「${current}」无法识别，请先初始化示例数据后再操作`
  }
  if (to < 0) {
    return `${meta.entity}没有登记「${target}」这个目标状态`
  }
  if (to === from) {
    return `${meta.entity}已经是「${target}」，不用重复操作`
  }
  if (to < from) {
    return `${meta.entity}只能从「${current}」顺着向「${meta.statuses[from + 1] ?? target}」流转，不能回退到「${target}」`
  }
  if (to > from + 1) {
    return `${meta.entity}状态不允许跳级：「${current}」只能先到「${meta.statuses[from + 1]}」，不能直接到「${target}」`
  }
  return null
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  const blocked = guardTransition(meta, current, target)
  if (blocked) {
    return { ok: false, message: blocked }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 业务字段里的「xx状态」要与流程状态保持一致，看板、列表、详情读的是同一份状态。
  for (const field of meta.fields) {
    if (field.endsWith('状态')) {
      updated[field] = target
    }
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

/** 模块页统计卡：直接按当前状态统计，保证与列表、看板同源。 */
export function moduleStats(key: string): { label: string; value: number }[] {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  return meta.metrics.map((label) => {
    const override = meta.metricOverrides?.[label]
    // 没有显式映射时，找标签里包含的最长状态名（避免「调度中」错配「待调度」）。
    const status =
      override ??
      meta.statuses
        .filter((candidate) => label.includes(candidate))
        .sort((a, b) => b.length - a.length)[0]
    return {
      label,
      value: status ? rows.filter((row) => String(row.status) === status).length : 0,
    }
  })
}

/** 本地开发初始化：应用启动与概览页「重新初始化示例数据」共用这一条幂等路径。 */
export function initializeDemoData(force = false): InitReport {
  return initDemoData({ force })
}

export { listBackups }

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: MODULES.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
