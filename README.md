# my-omp-plugins

magicdmer 的个人 [omp](https://omp.sh) marketplace。一个 marketplace 只是一份目录，插件代码仍在本仓库里。

## 安装

```sh
omp plugin marketplace add magicdmer/my-omp-plugins
omp plugin discover magicdmer-plugins
omp plugin install deepseek-balance@magicdmer-plugins
```

扩展模块安装后需要重启 omp 会话；skills / commands / agents / MCP 用 `/reload-plugins` 刷新。

不想用 marketplace 也可以直接装单个插件：

```sh
omp plugin install github:magicdmer/my-omp-plugins
```

## 插件

| 插件 | 说明 |
| --- | --- |
| `deepseek-balance` | 状态栏显示 DeepSeek 账户余额与当前峰谷计费（`DS ¥57.52 · 峰价`），`/ds-balance` 手动刷新 |

## 结构

```
.omp-plugin/marketplace.json        marketplace catalog
plugins/deepseek-balance/           插件树
  package.json                      omp.extensions -> extensions/deepseek-balance.ts
  extensions/deepseek-balance.ts
  README.md
```

## 维护

- 改插件代码后同步 `plugins/<name>/`；递增该插件的 `version` 与 catalog 里的 `version`，否则消费者 `upgrade` 不会重装。
- 新增插件：在 `plugins/<name>/` 放入插件树，并在 `.omp-plugin/marketplace.json` 的 `plugins` 里加一条（`name`、`source: "./plugins/<name>"`、`version`）。
- 名称只能用小写字母、数字、`-`、`.`，首尾为字母或数字，最长 64 字符。
- 外部插件可用 `{"source":"github","repo":"owner/repo","sha":"…"}`、`url` 或 `git-subdir` 对象源；npm 源可解析但当前不能安装。

## 注意

omp 不认证 marketplace 与插件，也不做沙箱；插件可包含 hooks、自定义工具、MCP/LSP server 和扩展模块。安装前请审查来源代码。
