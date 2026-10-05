<template>
  <section class="page" data-module="floodgate">
    <header class="page-head">
      <div>
        <h2>闸门调度管理</h2>
        <p class="page-desc">维护闸门调度记录，围绕调度编号、闸门名称、所属河渠、闸门开度做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记闸门调度记录</button>
        <button class="btn" type="button" @click="exportRows">导出闸门调度清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <button class="link" type="button" @click="openDetail(row)">{{ row[column] ?? '—' }}</button>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无闸门调度数据，可先重新初始化示例数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条闸门调度记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="detail" class="modal-overlay" role="dialog" aria-modal="true" @click.self="closeDetail">
      <div class="modal-card">
        <header class="modal-head">
          <h3>闸门调度详情 · {{ detail['调度编号'] }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <table class="data-table detail-table">
          <tbody>
            <tr v-for="column in columns" :key="column">
              <th>{{ column }}</th>
              <td>{{ detail[column] ?? '—' }}</td>
            </tr>
            <tr>
              <th>当前流程状态</th>
              <td>{{ detail.status }}</td>
            </tr>
          </tbody>
        </table>
        <p class="detail-tip">状态只能按「待调度 → 调度中 → 已执行 → 已终止」顺序逐级流转，不允许跳级。</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getEntry,
  listEntries,
  moduleMeta,
  moduleMetricCards,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('floodgate')
const columns = ["调度编号", "闸门名称", "所属河渠", "闸门开度", "上游水位", "下游水位", "调度人", "调度状态"]
const actions = ["提交调度", "确认执行", "终止调度"]
const statuses = ["待调度", "调度中", "已执行", "已终止"]
const stats = computed(() => moduleMetricCards(meta.key))

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
// 详情读的是本地存储里的同一条记录：列表上怎么流转，详情里就是什么状态，调度数与看板一致。
const detail = ref<EntryRow | null>(null)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '闸门调度记录登记入口尚未接入审批流'
}

function openDetail(row: EntryRow) {
  // 每次打开都按编号重新读取，避免列表渲染时缓存了旧值。
  detail.value = getEntry(meta.key, Number(row.id)) ?? null
}

function closeDetail() {
  detail.value = null
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  if (detail.value && Number(detail.value.id) === Number(row.id)) {
    detail.value = getEntry(meta.key, Number(row.id)) ?? null
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '闸门调度列表读取失败'
  }
}

onMounted(reload)
</script>
