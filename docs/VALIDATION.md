# 1.7.2 验证记录

- 基线：`9daf713b5fe52c228785b3be5183c1702374992b`（1.7.1）。生产差异仅 `tools.html`、`tools.css` 和 manifest/package 版本号；所有业务 JS、存储协议、权限和四个快捷命令均不变，无新标签页接管。1.7.1 的 400px 工具栏弹窗修复保留。
- 源码内容指纹 SHA-256：`3a064124dea1fd16fc3fd3b0cf28e6aac703f018ee8afe99158310be0c8f326c`。算法为相对路径到文件 SHA-256 映射，排序且紧凑 JSON 再取 SHA-256；排除 `.git`、`dist`、`__pycache__`、`node_modules`、`.pyc` 和本记录自身。
- 发布 ZIP：`TorranceTabs-v1.7.2.zip`，SHA-256：`e0c668c318c903ac2e7460e28a049f75a1e8b2305cb2a2c33d680028d9339e6e`。
- 构建模式：原生 ES Modules / Manifest V3，无新增生产依赖，检查无额外 flags。

## 根因与针对性验证

备份导入表单只有标签内部的间距，字段之间及下拉框与操作按钮之间没有独立间距；文件选择按钮使用浏览器默认外观。新结构为每个字段提供独立容器，标签与控件间距 8px，字段及操作区之间为 16px。文件选择按钮继承页面字体、边框和颜色，并补充悬停、禁用及格式帮助说明。

本机 Chrome 使用实际 tools.html/tools.css/tools.js，通过内存 File 和模拟扩展 API 检查界面。没有调用原生文件选择器或读取、导入用户文件。覆盖 500、390、320px 三种视口宽度与下列四种状态，共 12 组：

| 状态 | 预览按钮 | 确认按钮 | 结果 |
| --- | --- | --- | --- |
| 未选择文件 | 禁用 | 禁用 | 无横向溢出 |
| 长中文文件名、有效 JSON | 可用 | 禁用 | 无横向溢出 |
| 完成导入预览 | 可用 | 可用 | 预览可见，无横向溢出 |
| 无效 JSON | 禁用 | 禁用 | 错误可见，无横向溢出 |

12 组均通过 DOM 断言。修复前操作区间距 0px，修复后 16px；文件按钮圆角从原生 0px 变为 6px。标签 for 和帮助文本 aria-describedby 均关联唯一目标。导入预览和确认的原有门禁、导入锁不变。独立只读审查复核了作用域、全部业务 ID、权限、产物及上述证据，无阻断项。

## 构建与回归

| 环境 | 实际命令 / 检查 | 结果 |
| --- | --- | --- |
| macOS：`/Users/torrance/.nvm/versions/node/v22.22.3/bin/node` 22.22.3，`/opt/homebrew/opt/python@3.13/bin/python3.13` 3.13.7 | `make check test package` | 退出 0；161 项扩展测试和 20 项安装器测试通过，无跳过 |
| zhr Linux：`/usr/local/bin/node` 22.9.0，`/usr/bin/python3` 3.6.8 | `make check test package` | 退出 0；161 项扩展测试和 20 项安装器测试通过，无跳过 |
| macOS / zhr | ZIP SHA-256、CRC 与源码成员比较 | 退出 0；42 条目，两机打包字节一致；不含测试、预览服务器或 API 模拟桩 |
| 独立审查 | 扩展文件差异、HTML 关联、布局证据及 ZIP 断言 | 退出 0；仅两个界面文件和版本号变化 |

本机完整日志为维护工作区 `outputs/TorranceTabs-v1.7.2-local-validation.log`；12 组布局记录为 `outputs/TorranceTabs-v1.7.2-backup-layout.json`，另存对比图和局部截图。zhr 完整日志位于仓库外 `/home/haoming.zhr/code/TorranceTabs-v1.7.2-validation.log`。最终只更新本验证文档，生产文件与已验证快照逐字节核对。源码传输和 Git 推送使用 SSH，经 zhr 执行，不使用 scp。

## 边界与更新

布局验证使用模拟扩展 API，未真实导入用户配置；未覆盖不同操作系统的原生文件选择器、取消流程或屏幕阅读器实测。没有新增业务测试来镜像 CSS 实现。

本机更新沿用原加载目录和扩展注册，保留旧文件备份，不读写 Chrome 中的规则或配置。更新后需重新加载扩展，再刷新原工具箱页面。GitHub CI、Release 与公开资产校验值在推送后另行核对；不将此前受网络限制的公开资产下载当作已通过。
