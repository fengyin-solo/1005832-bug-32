import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, getRow, listRows, resetRows, saveRows, statusCounts } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

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

// 详情：列表、详情、看板读的是同一份本地数据，调度数天然一致。
export function getEntry(key: string, id: number): EntryRow | undefined {
  return getRow(key, id)
}

export function moduleStatusCounts(key: string): Record<string, number> {
  return statusCounts(key)
}

// 模块页顶部指标卡：指标按 metricStatuses 指定的状态实时计数，列表、详情、看板读同一份数据。
// null 位表示非状态指标（如「本月发现问题数」），按对应数值字段累加。
export function moduleMetricCards(
  key: string,
): { label: string; value: number }[] {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const counts = statusCounts(key)
  return meta.metrics.map((label, index) => {
    const status = meta.metricStatuses[index] ?? null
    if (status !== null) {
      return { label, value: counts[status] ?? 0 }
    }
    // 非状态指标：从字段名推断数值列（去掉「本月」「数」等词后按包含关系匹配），找不到则按 0 计。
    const hint = label.replace(/本月|数$|量$/g, '')
    const field = meta.fields.find((name) => name.includes(hint) || hint.includes(name.replace(/数$/, '')))
    if (!field) {
      return { label, value: 0 }
    }
    const sum = rows.reduce((total, row) => {
      const value = Number(String(row[field] ?? '').replace(/[^\d.]/g, ''))
      return total + (Number.isFinite(value) ? value : 0)
    }, 0)
    return { label, value: sum }
  })
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
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 状态只能从待调度顺着走到终态：必须且只能迈到状态链上的下一级，不允许跳级，也不允许回退。
  const currentIndex = meta.statuses.indexOf(current)
  const targetIndex = meta.statuses.indexOf(target)
  if (currentIndex < 0) {
    return { ok: false, message: `${meta.entity}当前状态「${current}」不在登记的状态链上，无法流转` }
  }
  if (targetIndex <= currentIndex) {
    return {
      ok: false,
      message: `「${current}」不能${action}回「${target}」，状态只能顺着 ${meta.statuses.join('→')} 向前走`,
    }
  }
  if (targetIndex !== currentIndex + 1) {
    const nextStatus = meta.statuses[currentIndex + 1]
    return {
      ok: false,
      message: `「${current}」不能直接跳到「${target}」，请先流转到下一状态「${nextStatus}」（状态链：${meta.statuses.join('→')}）`,
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 业务字段里的状态列（如闸门调度的「调度状态」）与流程状态保持同值，列表/详情读到的状态一致。
  const statusField = meta.fields.find((field) => field.endsWith('状态'))
  if (statusField) {
    updated[statusField] = target
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
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
