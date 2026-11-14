# omp-deepseek-balance

在 omp 状态栏显示 DeepSeek 账户余额与目录峰谷提示，并提供用户命令和模型可调用的只读查询工具。

```text
DS ¥57.52 · 峰价
```

## 安装

要求 omp 18.20.0 或更新版本，使用宿主提供的扩展 API 和 Schema，无生产运行时 npm 依赖。

```sh
omp plugin marketplace add magicdmer/my-omp-plugins
omp plugin install deepseek-balance@magicdmer-plugins
```

安装或升级后需要重启 omp 会话，扩展代码不会通过 `/reload-plugins` 热更新。

从旧单文件版本迁移时，先备份并移出 `~/.omp/agent/extensions/deepseek-balance.ts`（命名 profile 使用其对应 agent 目录），避免两份扩展同时启用。旧版 `/dsbalance` 统一改用 `/ds-balance`，模型工具名称仍为 `deepseek_balance`；不提供旧命令别名。

## 查询

```text
/ds-balance
/ds-balance --force
/ds-balance -f
```

- 命令弹出总余额、充值余额、赠送余额和账户可用状态；金额保留接口返回的小数精度。
- 默认使用 30 秒进程内结果缓存，包括失败结果；`--force` / `-f` 跳过缓存。
- 模型可调用 `deepseek_balance`，参数为可选的 `force: boolean`，工具权限为只读。
- 同一运行会话中的命令、工具和自动刷新共享在途请求，即使强制刷新也等待同一次查询，不会提前显示“未知”。
- 取消一个工具调用不会中断其他调用者正在等待的共享查询；会话关闭或切换会取消旧查询。

## 刷新与错误处理

- 余额来自 `GET https://api.deepseek.com/user/balance`，HTTP 请求超时为 8 秒，不跟随重定向。
- 首次查询通过宿主管理的计时器异步执行，不等待网络完成才结束会话启动事件。
- 余额每 10 分钟自动查询；峰谷提示每分钟重绘，不额外请求余额接口。
- 返回结构经过运行时 Schema 校验；缺少充值/赠送字段时显示 `-`，不虚构金额。
- 查询失败后显示错误，不继续显示上一笔成功余额。401/403、429、无凭据、网络错误、超时及无效响应会给出对应提示。
- 不输出 API Key、原始认证异常或服务端错误正文。状态栏写入失败不影响余额查询结果。
- 重复启动会清理旧计时器；关闭、切换或分支到其他会话时重置该运行实例的缓存、请求和计时器，晚到结果不会重新写回旧状态。

## 凭据与账户隔离

1. 优先使用 `DEEPSEEK_API_KEY`。
2. 否则通过 `ctx.modelRegistry.getApiKeyForProvider("deepseek", sessionId, ...)` 使用当前会话注册表中的 DeepSeek 凭据。

插件不扫描默认目录或其他 profile，不直接读取 `agent.db`，也不启动 `omp token` 子进程。每次实际请求重新解析凭据；更新 Key 后用 `--force` 立即查询，不需要等待旧 Key 的插件缓存失效。

查询始终发往 DeepSeek 官方余额接口。第三方网关余额不在本插件范围内；请确保配置的是对应官方账户的 DeepSeek Key。

## 峰谷提示的含义

时段只读取模型 catalog 的 `cost.timeBased`，按 UTC 分钟及 ISO 星期计算；仅显示“峰价”或“谷价”，不显示折扣百分比。

- 当前模型为 DeepSeek：使用该模型的时段；若有显式固定价格覆盖，不借用其他模型时段。
- 当前模型不是 DeepSeek：从会话模型列表中有时段的 DeepSeek 模型取提醒。
- 目录没有时段则不显示峰谷提示。这是目录提醒，不是余额接口返回的实时账单，也不代表当前其他 provider 正在按该价格收费；实际计费以服务商为准。

## 本地开发

后续代码以 `magicdmer/my-omp-plugins` 仓库为维护源，不再维护另一个全局单文件副本。在仓库根目录可链接本地插件：

```sh
omp plugin link ./plugins/deepseek-balance
```

代码修改后重启 omp。不要同时启用 marketplace 安装副本、同插件的本地链接及旧全局扩展。

回归测试需要 Node.js 24.3+，使用与目标宿主同版的真实 `@oh-my-pi/omptype`，但隔离网络、凭据注册表和计时器，不访问真实账户：

```sh
cd plugins/deepseek-balance
npm install
npm test
```

## 0.2.0

- 整合旧安装版的余额明细、账户可用状态、`deepseek_balance` 工具和 30 秒缓存。
- 通过当前会话公开接口获取凭据，移除长期 Key 缓存和凭据子进程。
- 合并并发请求，修复重复启动、会话切换及关闭后晚到结果的处理。
- 保留目录峰谷提示，将余额轮询与提示重绘分开；补充真实 Schema 回归测试。
