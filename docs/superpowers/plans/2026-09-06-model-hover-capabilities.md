# 模型悬停信息实现计划

目标：在现有模型名称的悬停提示中显示完整模型 ID、可选思考等级和模型上下文大小。

实现沿用现有原生 `title`，由一个 `modelTooltip()` 函数统一生成；能力快照放在 `web/app.js`，不增加运行时网络请求。显示目录数据，不把未知能力或失败的探测标为支持。模型列表、账号可用模型、Key 模型选项和概况模型名称共用格式。

- [x] 核实当前目录和网关固定档位，记录数据来源。
- [x] 添加能力快照与统一悬停文本，保留原有模型名和标签。
- [x] 更新现有布局检查中的 title 契约，运行语法和布局检查。
- [x] 浏览器核对模型列表及账号模型提示；未知模型显示未收录。
- [x] 仅更新目标容器的面板静态文件，校验线上内容与本地一致，无需重启服务。

约束：不实测限定 tag、无额度的独立池、god-only、web-only 模型；不修改容器宿主机文件。当前 Gemini 实测被上游余额不足和等待室阻断，不作为能力通过依据。

数据来源（2026-09-06）：

- OpenRouter 公共模型目录 `https://openrouter.ai/api/v1/models` 的 `context_length`、`reasoning.supported_efforts`；完整采样保存在工作区 `.local/openrouter-models-20260906.json`。
- Freebuff `e1d089368274e72cefe877c2db56063c3d334dd0` 的 `common/src/constants/freebuff-models.ts`：DeepSeek V4 Flash 走 Freebuff 自身的 low/high/max 档位。
- MiMo 的目录 ID 为 `xiaomi/mimo-v2.5`，对应本项目的 `mimo/mimo-v2.5`。
- Gemini 3.8 Flash 同时由 Google 文档 `https://ai.google.dev/gemini-api/docs/thinking` 确认 low/medium/high。
- Luna 使用当前 `worker.js` 中 `MODEL_PINNED_EFFORT` 的 high 固定档位，覆盖公开模型的更宽档位列表。

上下文显示的是模型目录容量，不宣称某个账号额度、上游单次准入限制或调用方压缩阈值等于该容量。未知模型不套用相似型号的能力。

## 后续要求：过载提示、档位和受限目录

- [x] 对上游 HTTP 529 / 5xx overloaded 返回中文 `overloaded_error`，使用 HTTP 503，保留明确 Retry-After。该错误不应被当成账号额度不足，或通过更换账号反复新建会话。
- [x] Gemini 3.8 Flash 登记 low/medium/high，max/xhigh/ultra 向下取 high；现有 Muse 1.2 与 Luna 规则保留。
- [x] 限定模型仅在该模型归属 premium，或该模型独立池有确认的剩余额度时显示；账号 accessTier=full 本身不构成模型可见性证据。
- [x] 对齐 API 目录、模型列表、账号模型、Key 选择；编辑已有 Key 时保留隐藏模型白名单，不能意外扩大为 All。
- [x] 回归错误分流、目录策略和普通会话链，验证后更新目标容器。

## 验收与后续修正

- 全量单元检查 194 项、其余回归套件 254 项通过；独立审查发现的快照时序和 Key 白名单状态转换已补充回归并修正。
- 最终过载和目录策略在容器 Node 22 中完成 21 项本地替身验证，不发起真实模型生成。
- 容器已更新并重载，健康检查 HTTP 200，公网静态资源与本地 SHA-256 一致。
- Muse 1.3 的前端误隐藏已复现并修正：冷启动 config 返回旧服务专用兜底名单，而后到的模型列表来自更新快照。现在 `/v1/models` 同时返回 `serviceOnlyModels`、`pausedModels`、`hidden_models`，初次加载和手动刷新均通过 `applyModelCatalog()` 同步应用。
- 冷启动浏览器夹具中，修复前仅显示 8/9 个模型，修复后显示 9/9；独立池、隐藏→暂停和恢复后的 Key 选择检查仍通过。线上确认 `meta/muse-spark-1.3-contributor` 存在且不在任何隐藏名单中。
