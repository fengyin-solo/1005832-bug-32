<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" :disabled="seeding" @click="reseed">重新灌入示例数据</button>
        <button class="btn" type="button" :disabled="seeding" @click="refresh">重新统计</button>
      </div>
    </header>

    <p v-if="initNotice" class="init-notice" :class="initKind">
      {{ initNotice }}
      <button v-if="initKind !== 'ok'" class="link" type="button" @click="reseed">点此重试初始化</button>
    </p>

    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
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
    <footer class="page-foot">
      <span>数据保存在本机浏览器里；重新灌入时旧数据会先备份（localStorage 键 {{ backupHint }}），重复执行不会叠加记录</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import {
  initializeSeedData,
  listBackups,
  SeedConflictError,
  type InitReport,
} from '@/data/local-store'
import type { OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const initNotice = ref('')
const initKind = ref<'ok' | 'warn' | 'error'>('ok')
const seeding = ref(false)
const backupHint = ref('')

function showReport(report: InitReport) {
  initKind.value = 'ok'
  const backup = report.backupKey ? `；旧数据已备份到「${report.backupKey}」` : ''
  const actionText =
    report.action === 'skipped'
      ? '示例数据已是当前版本，本次跳过（重复执行不产生重复记录）'
      : report.action === 'reseeded'
        ? `示例数据已重新灌入：${report.modules} 个模块、${report.records} 条记录`
        : `示例数据已首次灌入：${report.modules} 个模块、${report.records} 条记录`
  initNotice.value = `${actionText}${backup}。${report.reason}`
  backupHint.value = listBackups().slice(-1)[0] ?? '（暂无备份）'
}

function showError(error: unknown) {
  initKind.value = 'error'
  if (error instanceof SeedConflictError) {
    initNotice.value = `示例数据有 ${error.conflicts.length} 处编号重复冲突，本次初始化已全部挡回，本地数据未改动。${error.message.replace(/^.*?：\n?/s, '')}`
  } else {
    initNotice.value = `初始化失败，原有数据已保留，可以重试：${
      error instanceof Error ? error.message : String(error)
    }`
  }
}

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  backupHint.value = listBackups().slice(-1)[0] ?? '（暂无备份）'
}

function reseed() {
  seeding.value = true
  try {
    const report = initializeSeedData({ force: true })
    showReport(report)
    refresh()
  } catch (error) {
    showError(error)
  } finally {
    seeding.value = false
  }
}

onMounted(() => {
  try {
    const report = initializeSeedData()
    showReport(report)
  } catch (error) {
    showError(error)
  }
  refresh()
})
</script>
