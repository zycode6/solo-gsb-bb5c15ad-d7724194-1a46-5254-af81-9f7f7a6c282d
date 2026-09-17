# 离线事件序列修复台

一个完全在浏览器本地运行的 NDJSON 事件序列修复工具。技术栈：**TypeScript + Vite + React**。

粘贴每行包含 `stream`、`sequence`、`payload` 的 NDJSON，为每条流设置起始序号后：

- **重复折叠**：同流、同序号、载荷按 JSON 结构深比较相同的事件自动折叠为一条；
- **冲突标记**：同流、同序号但载荷结构不同 → 标为冲突，列出全部候选版本（标注各自出现的输入行与重复次数）；
- **阻断规则**：缺号，或存在未裁决冲突，会阻断该位置**之后的所有事件**；
- **即时重算**：选择一个冲突版本、撤销选择或修改起始序号，连续前缀立即重新计算；
- **导出**：仅导出每条流「已确认连续前缀」内的事件，可选择按流名+序号或全局序号+流名排序，输出 NDJSON。

所有解析、比较、裁决与导出均在浏览器内存中完成，**无任何网络请求，数据不会离开本机**。

## 输入格式

NDJSON，每行一个 JSON 对象：

```json
{"stream":"orders","sequence":1,"payload":{"id":"a","status":"created"}}
{"stream":"orders","sequence":2,"payload":{"id":"a","status":"paid"}}
```

- `stream`：字符串，流名；
- `sequence`：安全整数；
- `payload`：任意 JSON 值（对象、数组、基本类型均可）。

空行自动跳过；非法行会在解析结果中逐行报错并跳过，其余合法行正常处理。

## 一条命令启动（Docker）

需要已安装 Docker（含 Compose 插件）。在项目目录执行：

```bash
docker compose up --build -d
```

启动后在浏览器访问：

> **http://localhost:8080**

停止服务：

```bash
docker compose down
```

端口可在 `docker-compose.yml` 中修改（默认宿主机 `8080` → 容器 `80`）。

## 本地开发（不使用 Docker）

要求 Node.js 18+。

```bash
npm install
npm run dev        # 开发服务器，访问终端提示的地址（默认 http://localhost:5173）
npm run build      # 类型检查 + 生产构建，产物在 dist/
npm run preview    # 本地预览生产构建（默认 http://localhost:4173）
npm run verify     # 运行核心逻辑校验（解析/折叠/阻断/裁决/导出，共数十项断言）
```

## 使用说明

1. **粘贴数据**：将 NDJSON 粘贴到文本框，点击「解析并分析」（可先「载入示例」）。
2. **设置起始序号**：每条流卡片上可修改起始序号，默认为该流观测到的最小序号。
3. **处理缺口与冲突**：
   - 缺口区列出缺号，阻断点的缺号以红色高亮；
   - 冲突区并列展示候选载荷，选中单选按钮即裁决，点「撤销选择」恢复未裁决；
   - 「当前连续前缀」表格展示从起始序号起连续、已确认的事件。
4. **导出**：在底部选择排序方式，预览后「下载 NDJSON」或「复制」。导出内容严格限定为各流连续前缀。

### 裁决与阻断示例

流 `orders` 有序号 1、2、2、4，且两个序号 2 的载荷不同，起始序号为 1：

- 序号 1 直接进入前缀；
- 序号 2 冲突，未裁决时阻断，序号 4 即使存在也不可放行；
- 缺口列表显示缺号 3；
- 选定序号 2 的一个版本后，前缀推进到 2，随后因缺号 3 阻断；
- 导出只包含序号 1、2。

## 项目结构

```
.
├── Dockerfile              # 多阶段构建：node 构建 → nginx 静态托管
├── docker-compose.yml      # 一条命令启动，映射 8080:80
├── nginx.conf              # SPA 静态托管配置
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── scripts
│   └── verify.mjs         # 核心逻辑端到端断言（npm run verify）
└── src
    ├── main.tsx            # 入口
    ├── App.tsx             # 状态与页面编排
    ├── types.ts            # 领域类型
    ├── sample.ts           # 内置示例数据
    ├── styles.css
    ├── components
    │   └── StreamCard.tsx  # 单流：缺口 / 冲突候选 / 连续前缀
    └── lib
        ├── ndjson.ts       # NDJSON 解析与逐行校验
        ├── compare.ts      # JSON 结构深比较与稳定序列化
        ├── model.ts        # 按流/序号分组折叠、裁决与前缀分析
        └── export.ts       # 连续前缀 NDJSON 导出与排序
```
