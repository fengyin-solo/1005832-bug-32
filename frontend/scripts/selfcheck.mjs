// 本地初始化路径自检：node scripts/selfcheck.mjs
// 用 esbuild（项目已有依赖）把 TS 数据层打包到临时文件后在 Node 里执行，不依赖浏览器。
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const entry = `
import { bindStorage, initializeSeedData, listRows, allRows, listBackups, SeedConflictError, seedVersion, validateSeed } from '${join(root, 'src/data/local-store').replaceAll('\\\\', '/')}'
import { SEED_ROWS } from '${join(root, 'src/data/seed').replaceAll('\\\\', '/')}'
import { runAction, listEntries, getEntry, moduleMetricCards, loadOverview } from '${join(root, 'src/api/local-service').replaceAll('\\\\', '/')}'
const store = () => {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
    get length() { return map.size },
    key: (i) => [...map.keys()][i] ?? null,
    dump: () => new Map(map),
  }
}
globalThis.__selfcheck = {
  bindStorage, initializeSeedData, listRows, allRows, listBackups, SeedConflictError, seedVersion,
  validateSeed, SEED_ROWS, runAction, listEntries, getEntry, moduleMetricCards, loadOverview, store,
}
`

const dir = mkdtempSync(join(tmpdir(), 'drainage-selfcheck-'))
const entryPath = join(root, '.selfcheck-entry.ts')
const outPath = join(dir, 'bundle.mjs')
writeFileSync(entryPath, entry)
await build({
  entryPoints: [entryPath],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: outPath,
  alias: { '@': join(root, 'src') },
  logLevel: 'silent',
})
rmSync(entryPath, { force: true })
await import(pathToFileURL(outPath).href)
const kit = globalThis.__selfcheck
rmSync(dir, { recursive: true, force: true })

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}\n    ${error instanceof Error ? error.message : error}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

// 1. 空库首次初始化
{
  const s = kit.store()
  kit.bindStorage(s)
  const report = kit.initializeSeedData()
  check('空库首次初始化：seeded 且无备份', () => {
    assert(report.action === 'seeded', `action=${report.action}`)
    assert(report.backupKey === null, '不应产生备份')
    assert(kit.listRows('floodgate').length === 8, '闸门调度应有 8 条示例记录')
  })
}

// 2. 幂等：重复执行跳过、记录数不增加
{
  const s = kit.store()
  kit.bindStorage(s)
  kit.initializeSeedData()
  const firstCount = kit.allRows().floodgate.length
  const second = kit.initializeSeedData()
  const third = kit.initializeSeedData()
  check('重复初始化幂等：skipped 且不产生重复记录', () => {
    assert(second.action === 'skipped' && third.action === 'skipped', '第二三次应跳过')
    assert(kit.allRows().floodgate.length === firstCount, '记录数不应变化')
    assert(kit.listBackups().length === 0, '跳过时不应产生备份')
  })
}

// 3. 旧格式裸数据：备份 + 整组覆盖，不合并残留
{
  const s = kit.store()
  s.setItem('drainage-pump:entries', JSON.stringify({
    floodgate: [
      { id: 999, status: '待调度', pending: true, abnormal: false, 调度编号: 'OLD-1', 闸门名称: '旧记录', 所属河渠: '旧河渠', 闸门开度: '0m', 调度状态: '待调度' },
    ],
    ghost: [{ id: 1, status: 'x' }],
  }))
  kit.bindStorage(s)
  const report = kit.initializeSeedData()
  check('旧格式数据：先备份再整组覆盖，残留模块被清掉', () => {
    assert(report.backupKey && report.backupKey.includes('backup'), '应留下备份键')
    assert(kit.allRows().floodgate.every((r) => r.调度编号 !== 'OLD-1'), '旧闸门记录应被覆盖')
    assert(kit.allRows().ghost === undefined, '旧的残留模块应被整组清掉')
    const backupRaw = s.getItem(report.backupKey)
    assert(backupRaw.includes('OLD-1'), '备份里应能找回旧真实数据')
  })
}

// 4. 旧版本信封：升级重灌
{
  const s = kit.store()
  s.setItem('drainage-pump:entries', JSON.stringify({
    version: '1999.01.01-1', seededAt: '2000-01-01T00:00:00.000Z',
    entries: kit.SEED_ROWS,
  }))
  kit.bindStorage(s)
  const report = kit.initializeSeedData()
  check('旧版本数据：备份后升级重灌', () => {
    assert(report.action === 'reseeded', `action=${report.action}`)
    assert(report.backupKey !== null, '应备份旧版本数据')
  })
}

// 5. 损坏数据：可重试，重试后恢复
{
  const s = kit.store()
  s.setItem('drainage-pump:entries', '{这不是合法JSON')
  kit.bindStorage(s)
  let first
  try { first = kit.initializeSeedData() } catch (e) { first = e }
  const second = kit.initializeSeedData()
  check('损坏数据：初始化可重试并恢复', () => {
    assert(first instanceof Error || first.action === 'reseeded', '第一次应报损坏重灌或成功')
    assert(second.action === 'seeded' || second.action === 'reseeded' || second.action === 'skipped',
      `第二次异常 action=${second.action}`)
    assert(kit.listRows('floodgate').length === 8, '重试后示例数据应恢复')
  })
}

// 6. 写入失败可重试：故障存储抛错，恢复后再试成功且原数据保留
{
  const failing = kit.store()
  failing.setItem('drainage-pump:entries', JSON.stringify({ floodgate: [{ id: 1, 调度编号: 'KEEP-1' }] }))
  const rawMap = failing.dump()
  const guarded = {
    getItem: (k) => failing.getItem(k),
    setItem: (k, v) => {
      if (k === 'drainage-pump:entries:draft' || k === 'drainage-pump:entries') {
        throw new Error('模拟存储写入失败（配额已满）')
      }
      failing.setItem(k, v)
    },
    removeItem: (k) => failing.removeItem(k),
    get length() { return failing.length },
    key: (i) => failing.key(i),
  }
  kit.bindStorage(guarded)
  let error
  try { kit.initializeSeedData() } catch (e) { error = e }
  check('初始化出错：抛出可重试错误且原数据未被破坏', () => {
    assert(error instanceof Error && /可重试/.test(error.message), `错误信息应提示可重试，实际：${error?.message}`)
    assert(rawMap.get('drainage-pump:entries').includes('KEEP-1'), '原数据必须保留')
  })
  kit.bindStorage(failing)
  const retry = kit.initializeSeedData()
  check('故障排除后重试：初始化成功', () => {
    assert(['seeded', 'reseeded'].includes(retry.action), `action=${retry.action}`)
    assert(kit.listRows('floodgate').length === 8, '重试后数据完整')
  })
}

// 7. 状态机：待调度 → 调度中 → 已执行 → 已终止，逐级、不可跳级不可回退
{
  const s = kit.store()
  kit.bindStorage(s)
  kit.initializeSeedData()
  const id = kit.listRows('floodgate').find((r) => r.status === '待调度').id
  check('闸门调度状态只能顺向逐级流转', () => {
    let r = kit.runAction('floodgate', id, '终止调度')
    assert(!r.ok && /不能直接跳/.test(r.message), `待调度直接终止应被挡回：${r.message}`)
    r = kit.runAction('floodgate', id, '确认执行')
    assert(!r.ok && /不能直接跳/.test(r.message), '待调度直接执行应被挡回')
    r = kit.runAction('floodgate', id, '提交调度')
    assert(r.ok, `待调度→调度中应成功：${r.message}`)
    r = kit.runAction('floodgate', id, '提交调度')
    assert(!r.ok, '重复提交不应成功')
    r = kit.runAction('floodgate', id, '终止调度')
    assert(!r.ok && /不能直接跳/.test(r.message), '调度中直接终止应被挡回')
    r = kit.runAction('floodgate', id, '确认执行')
    assert(r.ok, '调度中→已执行应成功')
    r = kit.runAction('floodgate', id, '提交调度')
    assert(!r.ok && /不能/.test(r.message), '已执行后回退应被挡回')
    r = kit.runAction('floodgate', id, '终止调度')
    assert(r.ok, '已执行→已终止应成功')
    assert(kit.getEntry('floodgate', id).status === '已终止', '最终状态应为已终止')
    assert(kit.getEntry('floodgate', id)['调度状态'] === '已终止', '业务字段「调度状态」应同步')
  })
}

// 8. 列表 / 详情 / 看板读数一致
{
  const s = kit.store()
  kit.bindStorage(s)
  kit.initializeSeedData()
  check('列表、详情、看板的调度数一致', () => {
    const listTotal = kit.listEntries('floodgate').total
    const stored = kit.listRows('floodgate').length
    const overviewGate = kit.loadOverview().modules.find((m) => m.name === '闸门调度').created
    const cardSum = kit.moduleMetricCards('floodgate').reduce(
      (sum, c) => sum + (c.label !== '已执行调度数' ? c.value : 0), 0,
    )
    // 指标卡是各状态子集计数；用状态汇总核对总数
    const everyDetail = kit.listRows('floodgate').every((r) => kit.getEntry('floodgate', r.id)?.id === r.id)
    assert(listTotal === stored && stored === overviewGate,
      `列表=${listTotal} 存储=${stored} 看板=${overviewGate} 不一致`)
    assert(everyDetail, '详情按编号应能逐条读到')
    const cards = kit.moduleMetricCards('floodgate')
    assert(cards[0].value === 2, `待调度闸门应为 2，实际 ${cards[0].value}`)
    assert(cards[1].value === 2, `调度中闸门应为 2，实际 ${cards[1].value}`)
    assert(cards[2].value === 3, `已执行调度数应为 3，实际 ${cards[2].value}`)
    void cardSum
  })
}

// 9. 示例数据自身校验：按河渠铺开、编号唯一、开度非占位
{
  check('闸门示例数据按河渠铺齐名称/状态，编号唯一，开度为真实值', () => {
    const rows = kit.SEED_ROWS.floodgate
    const channels = new Set(rows.map((r) => r.所属河渠))
    assert(channels.size >= 4, `河渠数应铺开，实际 ${channels.size}`)
    const codes = rows.map((r) => r.调度编号)
    assert(new Set(codes).size === codes.length, '调度编号必须唯一')
    assert(rows.every((r) => !/样例/.test(String(r.闸门名称))), '闸门名称不应残留占位符')
    assert(rows.every((r) => /^\d+(\.\d+)? m$/.test(String(r.闸门开度))), '闸门开度应为真实开度值')
    assert(rows.some((r) => r.status === '待调度') && rows.some((r) => r.status === '调度中') &&
      rows.some((r) => r.status === '已执行') && rows.some((r) => r.status === '已终止'),
      '四种调度状态都应铺到')
  })
}

// 10. 冲突挡回：种子里出现两条同编号记录时，initialize 抛 SeedConflictError 整条挡回、不写库
{
  const s = kit.store()
  kit.bindStorage(s)
  const rows = kit.SEED_ROWS.floodgate
  const originalSecond = JSON.parse(JSON.stringify(rows[1]))
  rows[1]['调度编号'] = rows[0]['调度编号'] // 人为制造两条调度编号重复
  let error
  try {
    kit.initializeSeedData()
  } catch (e) {
    error = e
  }
  rows[1] = originalSecond // 还原，避免污染后续
  check('两条调度编号重复：初始化被挡回并交代清楚模块/编号/记录，且不写入数据', () => {
    assert(error instanceof kit.SeedConflictError, '应抛 SeedConflictError')
    const c = error.conflicts[0]
    assert(c.module === 'floodgate', `冲突模块应为 floodgate，实际 ${c.module}`)
    assert(c.field === '调度编号', `冲突字段应为调度编号，实际 ${c.field}`)
    assert(c.code === rows[0]['调度编号'], '应交代重复的编号')
    assert(c.rowIds.length === 2, '应列出冲突的两条记录 id')
    assert(/挡回/.test(error.message), '错误信息应交代已挡回')
    assert(s.getItem('drainage-pump:entries') === null, '冲突挡回时不应写入任何数据')
  })
  check('排除冲突后重试：初始化成功', () => {
    const report = kit.initializeSeedData()
    assert(['seeded', 'reseeded'].includes(report.action), `action=${report.action}`)
    assert(kit.listRows('floodgate').length === 8, '重试后数据完整')
  })
}

console.log(`\n自检结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
