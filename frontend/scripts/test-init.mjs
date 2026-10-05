// 本地数据层自测：用内存存储模拟 localStorage，跑完幂等初始化的全部场景。
// 运行：node scripts/test-init.mjs（由 esbuild 即时转译 TS）
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const srcDir = join(process.cwd(), 'src')

async function loadModules() {
  const outDir = join(process.cwd(), 'node_modules/.cache/init-test')
  mkdirSync(outDir, { recursive: true })
  const entry = join(outDir, 'entry.ts')
  // 单一入口保证 store 与 service 共享同一个 local-store 实例
  writeFileSync(
    entry,
    `import * as store from '${join(srcDir, 'data/local-store.ts').replace(/\\/g, '/')}'\n` +
      `import * as service from '${join(srcDir, 'api/local-service.ts').replace(/\\/g, '/')}'\n` +
      `export { store, service }\n`,
  )
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    write: false,
    alias: { '@': srcDir },
  })
  const bundled = join(outDir, 'bundle.mjs')
  writeFileSync(bundled, result.outputFiles[0].text)
  return await import(pathToFileURL(bundled).href)
}

function makeMemory() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    keyNames: () => [...map.keys()],
    __map: map,
  }
}

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

const api = await loadModules()
const { store, service } = api

// 场景 1：空库首次初始化
console.log('场景1 首次初始化')
{
  const mem = makeMemory()
  store.__setStorageForTest(mem)
  const report = store.initDemoData()
  check('首次模式为 fresh', report.mode === 'fresh', report.mode)
  check('无备份（本来就没数据）', report.backupKey === null)
  check('闸门铺了 8 条', report.counts.floodgate === 8, String(report.counts.floodgate))
  const gates = service.listEntries('floodgate').items
  check('按河渠铺开（4 条河渠）', new Set(gates.map((r) => r['所属河渠'])).size === 4)
  check('闸门名称不再是占位文本', gates.every((r) => !String(r['闸门名称']).includes('样例')))
  check('开度是真实开度', gates.some((r) => r['闸门开度'] === '1.5m'))
  check('调度状态与流程状态一致', gates.every((r) => r['调度状态'] === r.status))
  check('四个状态都有样例', ['待调度', '调度中', '已执行', '已终止'].every((s) => gates.some((r) => r.status === s)))
  check('编号唯一', new Set(gates.map((r) => r['调度编号'])).size === gates.length)
  check('看板有总量', service.loadOverview().cards[1].value >= 8)
  check('看板闸门数=列表数', service.loadOverview().modules.find((m) => m.name === '闸门调度').created === gates.length)
  check('模块统计卡不是零', service.moduleStats('floodgate').every((s) => s.value >= 0) && service.moduleStats('floodgate')[0].value === 3, JSON.stringify(service.moduleStats('floodgate')))
}

// 场景 2：重复执行幂等
console.log('场景2 重复执行不产生重复记录')
{
  const mem = makeMemory()
  store.__setStorageForTest(mem)
  store.initDemoData()
  const before = service.listEntries('floodgate').total
  const again = store.initDemoData()
  const after = service.listEntries('floodgate').total
  check('第二次为 unchanged', again.mode === 'unchanged', again.mode)
  check('记录数不变', before === after, `${before} -> ${after}`)
  store.initDemoData()
  store.initDemoData()
  check('连跑四次仍不变', service.listEntries('floodgate').total === before)
  check('没有产生备份', store.listBackups().length === 0)
}

// 场景 3：旧库迁移（含真实记录 + 旧占位示例 + 残留重复灌录）
console.log('场景3 旧库迁移：备份真实数据、旧示例被替换、真实记录保留')
{
  const mem = makeMemory()
  const old = {
    floodgate: [
      { id: 1, status: '待调度', pending: true, abnormal: false, 调度编号: 'FLOO-0001', 闸门名称: '闸门调度样例1', 所属河渠: '闸门调度样例1', 闸门开度: '闸门调度样例1' },
      // 模拟重复灌录：同一批旧示例又灌了一遍（新 id、同编号）
      { id: 4, status: '待调度', pending: true, abnormal: false, 调度编号: 'FLOO-0001', 闸门名称: '闸门调度样例1', 所属河渠: '闸门调度样例1', 闸门开度: '闸门调度样例1' },
      // 真实记录
      { id: 9, status: '调度中', pending: true, abnormal: false, 调度编号: 'REAL-2026-01', 闸门名称: '现场实测闸', 所属河渠: '东排渠', 闸门开度: '0.3m' },
    ],
  }
  mem.setItem('drainage-pump:entries', JSON.stringify(old))
  store.__setStorageForTest(mem)
  const report = store.initDemoData()
  check('模式为 migrated', report.mode === 'migrated', report.mode)
  check('覆盖前有备份', report.backupKey !== null && mem.getItem(report.backupKey).includes('REAL-2026-01'))
  const gates = service.listEntries('floodgate').items
  check('真实记录保留', gates.some((r) => r['调度编号'] === 'REAL-2026-01'))
  check('真实记录内容没被覆盖', gates.find((r) => r['调度编号'] === 'REAL-2026-01')['闸门开度'] === '0.3m')
  check('旧占位示例被清掉', !gates.some((r) => String(r['闸门名称']).includes('样例')))
  check('没有残留重复记录', gates.length === new Set(gates.map((r) => r['调度编号'])).size)
  check('总数=8 条新示例 + 1 条真实', gates.length === 9, String(gates.length))
}

// 场景 4：真实记录与新示例编号撞号 → 示例让位挡回，不产生重复
console.log('场景4 真实记录与示例撞号')
{
  const mem = makeMemory()
  const old = {
    floodgate: [
      { id: 1, status: '调度中', pending: true, abnormal: false, 调度编号: 'FGAT-0001', 闸门名称: '现场已用1号', 所属河渠: '东排渠', 闸门开度: '0.9m' },
    ],
  }
  mem.setItem('drainage-pump:entries', JSON.stringify(old))
  store.__setStorageForTest(mem)
  const report = store.initDemoData()
  check('挡回编号被登记', (report.skippedSeedCodes.floodgate ?? []).includes('FGAT-0001'))
  const gates = service.listEntries('floodgate').items
  check('FGAT-0001 只有一条', gates.filter((r) => r['调度编号'] === 'FGAT-0001').length === 1)
  check('保留的是真实记录', gates.find((r) => r['调度编号'] === 'FGAT-0001')['闸门名称'] === '现场已用1号')
  check('其余 7 条示例正常灌入', gates.length === 8, String(gates.length))
}

// 场景 5：示例数据自身两条调度编号重复 → 整批挡回、旧数据不动、改完可重试
console.log('场景5 两条调度编号重复时整批挡回并交代清楚')
{
  const mem = makeMemory()
  // 先放一份已有数据
  mem.setItem('drainage-pump:entries', JSON.stringify({
    floodgate: [
      { id: 1, status: '调度中', pending: true, abnormal: false, 调度编号: 'OLD-1', 闸门名称: '旧记录', 所属河渠: '旧河渠' },
    ],
  }))
  store.__setStorageForTest(mem)

  // 模拟 seed 文件里两条记录用了同一调度编号
  const goodSeed = await (async () => {
    // 从正常初始化结果取一份合法 seed
    const mem2 = makeMemory()
    store.__setStorageForTest(mem2)
    store.initDemoData()
    return JSON.parse(mem2.getItem('drainage-pump:entries'))
  })()
  const badSeed = JSON.parse(JSON.stringify(goodSeed))
  badSeed.floodgate[7] = { ...badSeed.floodgate[6], id: 8 } // 第 8 条与第 7 条同编号

  store.__setStorageForTest(mem)
  store.__setSeedForTest(badSeed)
  let thrown = null
  try {
    store.initDemoData()
  } catch (e) {
    thrown = e
  }
  check('抛出 SeedConflictError', thrown?.name === 'SeedConflictError', String(thrown))
  check('文案交代模块/编号/冲突双方',
    String(thrown?.message).includes('闸门调度') &&
    String(thrown?.message).includes('FGAT-0007') &&
    String(thrown?.message).includes('北截洪渠') &&
    String(thrown?.message).includes('挡回'),
    String(thrown?.message))
  check('旧数据原封不动', mem.getItem('drainage-pump:entries').includes('OLD-1'))
  check('没留下半成品备份以外的写入', service.listEntries('floodgate').total === 1)

  // 修好 seed 后直接重试成功
  store.__setSeedForTest(goodSeed)
  const retry = store.initDemoData()
  check('修复后重试成功（迁移模式）', retry.mode === 'migrated', retry.mode)
  check('重试后 8 条示例 + 1 条真实', service.listEntries('floodgate').total === 9)
  store.__setSeedForTest(null)
}

// 场景 6：初始化出错后可重试（存储暂时不可用恢复后成功）
console.log('场景6 出错可重试')
{
  const failing = makeMemory()
  const orig = failing.setItem
  let calls = 0
  failing.setItem = (k, v) => {
    if (k === 'drainage-pump:entries' && calls < 1) {
      calls += 1
      throw new Error('localStorage 写入失败（配额已满）')
    }
    return orig(k, v)
  }
  store.__setStorageForTest(failing)
  let firstError = null
  try {
    store.initDemoData()
  } catch (e) {
    firstError = e
  }
  check('首次失败被抛出', firstError instanceof Error)
  failing.setItem = orig
  const retry = store.initDemoData()
  check('重试成功', retry.mode === 'fresh', retry.mode)
  check('重试后数据可读', service.listEntries('floodgate').total === 8)
}

// 场景 7：坏 JSON 修复
console.log('场景7 本地数据损坏可修复')
{
  const mem = makeMemory()
  mem.setItem('drainage-pump:entries', '{不是合法JSON')
  store.__setStorageForTest(mem)
  const report = store.initDemoData()
  check('模式为 repaired', report.mode === 'repaired', report.mode)
  check('坏数据已备份', report.backupKey !== null && mem.getItem(report.backupKey).includes('不是合法JSON'))
  check('修复后可正常读取', service.listEntries('floodgate').total === 8)
}

// 场景 8：状态顺序流转，不允许跳级/回退
console.log('场景8 闸门状态机：待调度→调度中→已执行→已终止')
{
  const mem = makeMemory()
  store.__setStorageForTest(mem)
  store.initDemoData()
  const first = service.listEntries('floodgate').items.find((r) => r.status === '待调度')
  // 跳级：待调度直接确认执行
  const jump = service.runAction('floodgate', first.id, '确认执行')
  check('跳级被挡', jump.ok === false && jump.message.includes('跳级'))
  // 再越级终止
  const jump2 = service.runAction('floodgate', first.id, '终止调度')
  check('跨两级终止被挡', jump2.ok === false)
  check('被挡后状态不变', service.getEntry('floodgate', first.id).status === '待调度')
  // 顺序走
  check('提交调度成功', service.runAction('floodgate', first.id, '提交调度').ok === true)
  check('状态变调度中', service.getEntry('floodgate', first.id).status === '调度中')
  check('业务状态字段同步', service.getEntry('floodgate', first.id)['调度状态'] === '调度中')
  // 回退
  const back = service.runAction('floodgate', first.id, '提交调度')
  check('重复/回退被挡', back.ok === false)
  check('确认执行成功', service.runAction('floodgate', first.id, '确认执行').ok === true)
  // 从已执行直接提交调度（回退两级）
  const back2 = service.runAction('floodgate', first.id, '提交调度')
  check('回退被挡', back2.ok === false && back2.message.includes('不能回退'))
  check('终止成功', service.runAction('floodgate', first.id, '终止调度').ok === true)
  check('终态 pending=false', service.getEntry('floodgate', first.id).pending === false)
  // 终态后任何动作都挡
  check('终态不能再动', service.runAction('floodgate', first.id, '确认执行').ok === false)
}

// 场景 9：列表 / 详情 / 看板 三处数量一致
console.log('场景9 三处读数一致')
{
  const mem = makeMemory()
  store.__setStorageForTest(mem)
  store.initDemoData()
  const list = service.listEntries('floodgate').total
  const overview = service.loadOverview().modules.find((m) => m.name === '闸门调度').created
  const details = service.listEntries('floodgate').items.map((r) => service.getEntry('floodgate', r.id))
  check('详情逐条可取且非空', details.length === list && details.every(Boolean))
  check('看板=列表', overview === list)
  service.runAction('floodgate', 1, '提交调度')
  const list2 = service.listEntries('floodgate').total
  const overview2 = service.loadOverview().modules.find((m) => m.name === '闸门调度').created
  check('流转后数量仍一致', list2 === overview2 && list2 === 8)
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
