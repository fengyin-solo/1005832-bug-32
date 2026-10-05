# 城市排水防涝泵站运行与内涝处置管理平台

面向排水泵站台账、泵组运行、排水管网与检查井养护、水位雨量监测、内涝点处置、闸门调度与抢险队出动的一体化城市排水防涝运行管理工作台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 泵站台账 | `pumpstation` | 排水泵站 | 站名、所属片区、设计流量 |
| 泵组运行 | `pumprun` | 泵组运行记录 | 运行编号、所属泵站、泵组编号 |
| 排水管网 | `drainpipe` | 排水管段 | 管段编号、起点井号、终点井号 |
| 检查井维护 | `manhole` | 检查井 | 井编号、所属管段、井盖状况 |
| 管网清淤 | `dredge` | 清淤记录 | 清淤编号、清淤管段、淤积厚度 |
| 水位监测 | `waterlevel` | 水位监测记录 | 监测编号、监测点位、水位读数 |
| 雨量监测 | `rainfall` | 雨量监测记录 | 监测编号、雨量站名、时段雨量 |
| 内涝点处置 | `waterlog` | 内涝点记录 | 内涝编号、内涝点位、积水深度 |
| 闸门调度 | `floodgate` | 闸门调度记录 | 调度编号、闸门名称、所属河渠 |
| 泵组检修 | `pumpmaint` | 泵组检修记录 | 检修编号、泵组编号、检修类别 |
| 拍门检修 | `sluice` | 拍门检修记录 | 检修编号、所属泵站、拍门编号 |
| 格栅清污 | `screen` | 清污记录 | 清污编号、所属泵站、格栅类型 |
| 排口巡查 | `outfallpatrol` | 排口巡查记录 | 巡查编号、排口名称、所在河段 |
| 防涝预警发布 | `floodwarn` | 预警单 | 预警编号、预警级别、影响区域 |
| 抢险队调度 | `rescueteam` | 抢险任务 | 任务编号、任务类型、目标点位 |
| 排水设备台账 | `drainequipment` | 排水设备 | 设备编号、设备名称、设备型号 |
| 管道内窥检测 | `cctvinspect` | 内窥检测记录 | 检测编号、检测管段、缺陷等级 |
| 排水调度方案 | `dispatchplan` | 调度方案 | 方案编号、方案名称、适用雨型 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断；所有模块的状态都只能
  沿状态链逐级向前（如闸门调度：待调度 → 调度中 → 已执行 → 已终止），不允许跳级或回退。

## 本地示例数据初始化（幂等）

- 应用启动时自动执行 `initializeSeedData()`（见 `src/main.ts`），也可以在「运营概览」页点
  「重新灌入示例数据」。该入口是**幂等**的：
  - 本地保存的示例数据与当前 `SEED_VERSION` 一致时直接跳过，重复执行不会叠加记录；
  - 旧格式 / 旧版本 / 损坏数据会先按时间戳备份到 `drainage-pump:entries:backup:*`（最多保留
    5 份，可在控制台通过 `localStorage` 查看），再按模块整组覆盖，不做合并；
  - 灌入前先校验各模块业务编号（闸门调度为「调度编号」）的唯一性，两条记录编号重复时
    整条初始化被挡回并列出冲突的模块、编号与记录 id，不写入任何数据；
  - 写入采用「草稿键 → 读回校验 → 提交」两步，失败自动回滚并保留原数据，之后可直接重试。
- 只想重置单个模块：调用 `resetModule(模块)`。
