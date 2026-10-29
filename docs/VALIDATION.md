# 1.8.1 验证记录

- 基线：`d4865d9069fda2edabfaddd26670352ed46cf811`（1.8.0）加本次 patch。原生 ES Modules / Manifest V3；无新增依赖、权限或构建 flags，无新标签页接管。
- 源码内容指纹 SHA-256：`ef9e023114b9230405a903a7f155a327b3139526df3bd5ee37fbfcea8b1111c6`。相对路径→SHA-256 映射排序、紧凑 JSON 后取摘要；排除 `.git`、`dist`、`__pycache__`、`node_modules`、`.pyc` 和本记录。
- 两种 ZIP 的 CRC、条目和 57 个生产文件均核对，与源码逐字节一致；本机和 zhr 产物摘要一致。

| 产物 | 条目数 | SHA-256 |
| --- | --- | --- |
| TorranceTabs-v1.8.1.zip | 63 | `bc0adecc3ad6455e66e15fd08f8ef7692a7541fb2d4db1b49fe9cad5c2b4b777` |
| TorranceTabs-store-v1.8.1.zip | 57 | `d458f918ca00135333fab4fdead3be682c499908cb90418b0be2a9fd152ee3d0` |

## 根因及回归

网址已提交但 Chrome 仍报告 `loading` 时，旧代码即开始注入；随后安装完成检查或下一次 updated 的严格稳定性检查会永久取消提醒。首次加载完成后已无观察记录，不能补显示。先新增回归，在修改前以退出码 1 复现；修复后等待首次加载完成再注入，不放宽切换/删除前的导航与文档检查。

新增回归覆盖已提交且加载中的新页、about:blank→pending→committed loading→complete、关闭后取消等待/已有浮层/在途注入、旧配置默认开启，以及快速关闭再开启不复活旧记录。后台保留关闭事件快照；之后新建页正常提示。快捷开关只在共享写队列内更改提醒字段，保留最新分组规则；普通网页无权调用该 RPC。

## 构建与测试

| 环境 | 实际命令 | 结果 |
| --- | --- | --- |
| macOS：`/Users/torrance/.nvm/versions/node/v22.22.3/bin/node` 22.22.3；Homebrew Python 3.13.7 | `make check test package` | 退出 0；219 项扩展 + 21 项 Python 测试通过，0 失败、0 跳过 |
| zhr Linux：`/usr/local/bin/node` 22.9.0；`/usr/bin/python3` 3.6.8 | `make check test package` | 退出 0；219 项扩展 + 21 项 Python 测试通过，0 失败、0 跳过 |
| 独立 Expert：Node 22.22.3 | `cd extension && node --test tests/inline-duplicate-guard.test.js tests/background.test.js tests/library-store.test.js tests/prompt-control.test.js` | 退出 0；42 通过，0 失败、0 跳过 |

本机日志：`/tmp/TorranceTabs-v1.8.1-local-validation.log`。zhr 日志：`/home/haoming.zhr/code/TorranceTabs-v1.8.1-validation.log`。独立审查日志：`/tmp/TorranceTabs-v1.8.1-expert-review.log`。源码经 SSH stdin 传输，107 个文件摘要校验通过；不使用 scp。最终仅补本文档，生产代码与被验证 stage 一致。

## 界面和审查

Chrome 打开实际快捷面板 HTML/CSS/JS，使用合成内存 Chrome API，无真实标签删除、配置更改或权限申请。实测默认开启→关闭→开启、状态文案、浅色/深色外观；文档内容宽度与 scrollWidth 均为 400px，无横向溢出。截图：`/tmp/TorranceTabs-v1.8.1-prompt-control.png`，仅示例数据。

独立 Expert 审查已关闭快速关/开遗漏关闭事件的 P2，以及响应失败时误称原设置保留的文案问题。最终审查无阻断项；Lead 亲自运行关键回归及全量测试。

## 兼容和未验证范围

沿用已有 `settings.duplicatePromptEnabled` 字段，缺省为 true，尊重用户已保存的 false。快捷面板立即保存；设置页同名字段仍随整份表单保存。关闭取消已有/待显示提醒，不影响自动分组或手动清理。未授权时显示提示与设置入口，不隐式申请权限。

长时间不完成加载的网页会继续等待；固定、无痕、分屏、共享页及例外/暂停站点继续跳过。本次未执行真实已加载扩展的原生端到端联调；代码文件更新后仍需在 Chrome 扩展管理页重新加载。合成浏览器 API 测试不能替代平台实际行为。原生侧栏、跨设备同步及商店审核未作为本次验证范围。

GitHub CI/Release 在推送后另行核对；没有将受网络限制的公开 ZIP 下载记为通过。保留原安装目录和用户配置，提供更新前文件备份。
