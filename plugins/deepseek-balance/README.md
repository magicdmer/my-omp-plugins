# omp-deepseek-balance

在 omp 状态栏显示 DeepSeek 账户余额，以及当前计费时段（峰价 / 谷价-N%）。

```
DS ¥57.52 · 峰价
```

- 余额来自 `POST https://api.deepseek.com/user/balance`，每 60 秒刷新一次；`/ds-balance` 立即刷新并弹出明细。
- 峰谷时段取自模型 catalog 的 `cost.timeBased`（DeepSeek 峰时为 UTC 周一至周五 01:00–04:00、06:00–10:00，谷时 50%）；当前模型不是 DeepSeek 时，从注册表里任一 DeepSeek 模型取该时段，作为提醒。
- 刷新失败时状态显示 `DS 余额失败:<原因>`，不会继续展示过期金额。
- 凭证优先取 `DEEPSEEK_API_KEY`，否则执行 `omp token deepseek`（进程内缓存）。

## 安装

```
omp plugin marketplace add <repo-or-path>
omp plugin install deepseek-balance@ut005689-plugins
```

安装的是**扩展模块**，需要重启 omp 会话生效。

如果同时保留了 `~/.omp/agent/extensions/deepseek-balance.ts`，请删掉其中一份，否则会注册两次：两个刷新定时器、每分钟两次余额请求，`/ds-balance` 命令名冲突（后注册的静默跳过）。

## 结构

```
package.json                 omp.extensions 指向扩展模块
extensions/deepseek-balance.ts
```
