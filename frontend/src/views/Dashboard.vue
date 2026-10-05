<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" :disabled="initializing" @click="refresh">重新统计</button>
        <button class="btn primary" type="button" :disabled="initializing" @click="reseed">
          {{ initializing ? '初始化中…' : '重新初始化示例数据' }}
        </button>
      </div>
    </header>

    <p v-if="notice.ok" class="notice ok">{{ notice.ok }}</p>
    <div v-else-if="notice.err" class="notice err">
      <div>{{ notice.err }}</div>
      <button class="btn" type="button" :disabled="initializing" @click="retryInit">重试初始化</button>
    </div>

    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>登记数量</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>
    <footer class="page-foot" style="display: block;">
      <p style="margin: 4px 0;">
        闸门调度数一致性校验：列表 {{ gateCount.list }} · 详情可查 {{ gateCount.detail }} · 看板
        <template v-if="gateCount.consistent">{{ gateCount.overview }}，三者一致。</template>
        <template v-else>
          {{ gateCount.overview }}，<span class="error-text">三者不一致，请重试初始化修复。</span>
        </template>
      </p>
      <p style="margin: 4px 0;">状态流转只能顺序向前：待调度 → 调度中 → 已执行 → 已终止，不允许跳级或回退。</p>
      <p style="margin: 4px 0;">最近备份：</p>
      <ul v-if="backups.length" class="backup-list">
        <li v-for="item in backups.slice(0, 3)" :key="item.key">
          {{ item.createdAt || '时间未知' }} · {{ item.reason }}<template v-if="item.version !== null">（覆盖前版本 v{{ item.version }}）</template>
        </li>
      </ul>
      <p v-else style="margin: 4px 0; color: var(--muted);">还没有覆盖过数据，暂无备份。</p>
      <p style="margin: 4px 0;">数据保存在本机浏览器里；重新初始化会先整份备份再覆盖示例记录，真实记录保留。</p>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  getEntry,
  initializeDemoData,
  listBackups,
  listEntries,
  loadOverview,
} from '@/api/local-service'
import type { BackupMeta, InitMode, InitReport, OverviewResult } from '@/data/types'

const MODE_TEXT: Record<InitMode, string> = {
  fresh: '已按河渠铺好示例数据',
  migrated: '旧版本地库已迁移：先备份再覆盖，真实记录已保留',
  upgraded: '示例数据已升级到新版本：先备份再覆盖，真实记录已保留',
  repaired: '本地示例数据损坏，已备份坏数据并修复，可放心重试',
  reseeded: '已重新灌入示例数据：旧数据先备份，重复执行不会产生重复记录',
  unchanged: '示例数据已是最新，无需重复灌入',
}

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const backups = ref<BackupMeta[]>([])
const notice = ref<{ ok: string; err: string }>({ ok: '', err: '' })
const initializing = ref(false)

const gateCount = computed(() => {
  const items = listEntries('floodgate').items
  const list = items.length
  const detail = items.filter((row) => getEntry('floodgate', Number(row.id)) !== null).length
  const overview = moduleRows.value.find((row) => row.name === '闸门调度')?.created ?? -1
  return { list, detail, overview, consistent: list === overview && detail === list }
})

function formatReport(report: InitReport): string {
  const parts = [
    `${MODE_TEXT[report.mode]}（示例数据 v${report.version}）`,
    `闸门调度 ${report.counts.floodgate ?? 0} 条已按河渠铺开`,
  ]
  if (report.backupKey) {
    parts.push(`旧数据已备份到 ${report.backupKey}`)
  }
  const skipped = report.skippedSeedCodes.floodgate ?? []
  if (skipped.length > 0) {
    parts.push(
      `调度编号 ${skipped.join('、')} 与真实记录撞号，对应示例记录已挡回让位，没有生成重复记录`,
    )
  }
  return parts.join('；')
}

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  backups.value = listBackups()
}

function runInit(force: boolean) {
  initializing.value = true
  try {
    const report = initializeDemoData(force)
    notice.value = { ok: formatReport(report), err: '' }
    refresh()
  } catch (error) {
    notice.value = {
      ok: '',
      err: error instanceof Error ? error.message : '示例数据初始化失败，旧数据未改动',
    }
  } finally {
    initializing.value = false
  }
}

function reseed() {
  runInit(true)
}

function retryInit() {
  runInit(false)
}

onMounted(() => {
  runInit(false)
  refresh()
})
</script>
