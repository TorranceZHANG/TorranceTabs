# Chrome Web Store 上架材料

此文件是可审核的提交材料，不表示已经上传或获商店批准。

## 名称与分类

- 名称：TorranceTabs · 标签管理
- 默认语言：简体中文
- 建议分类：生产力 / 工作流程
- 网站：https://github.com/TorranceZHANG/TorranceTabs
- 支持：https://github.com/TorranceZHANG/TorranceTabs/issues
- 隐私说明：https://github.com/TorranceZHANG/TorranceTabs/blob/main/PRIVACY.md

简短描述：

> 自动分组、统一搜索与可预览去重，让浏览器中的项目页面井然有序。默认本地保存，保留原有新标签页。

详细描述：

TorranceTabs 帮你管理分散在多个窗口里的网页，不接管新标签页。

- 按网址前缀自动归入 Chrome 原生标签组，支持目录排除、当前页面建规则和试跑解释。
- 实时按站点、窗口或标签组浏览；统一搜索打开的页面、稍后读与工作区，支持键盘定位和地址栏 tt 搜索。
- 一键清理重复页，或先预览、选择保留副本，再按窗口/标签组清理；支持站点例外和临时暂停提醒。
- 三个常用入口跨窗口定位已打开网页，可配置快捷键。
- 工作区更新与有限历史、差异恢复、可选定时快照，帮助找回项目现场。
- 可选 Chrome 原生侧栏、跟随系统的深色主题及紧凑密度。
- JSON 备份兼容导入，按需同步明确选择的规则、入口和外观设置。

数据默认保存在本机。无项目遥测、广告或外部 AI；不读取网页正文、Cookie、密码或浏览历史数据库。自动快照和按需同步默认关闭。启用同步后也需手动确认上传或应用，规则和入口可能包含内部网址。恢复的是链接与布局，无法保证恢复表单或运行状态。

## 审核用途与权限说明

单一用途：管理用户主动打开及保存的浏览器标签，涵盖整理、查找、重复清理、保存与恢复。

| 权限 | 必要用途 |
| --- | --- |
| tabs | 当前标签的 URL/标题、搜索、定位、重复检测、关闭与恢复 |
| tabGroups | 查找、创建和命名 Chrome 原生标签组 |
| storage | 本地设置、备份、工作区/恢复记录；用户选择的 Chrome 同步存储 |
| alarms | 用户启用后的定时本地快照；worker 启动时恢复缺失计划 |
| 可选 sidePanel | 用户启用的常驻侧栏 |
| 可选 scripting、http/https 网站访问 | 在重复网页顶层隔离环境注入提醒；不读取正文 |

数据处理表应如实披露当前标签 URL/标题等浏览活动元数据，即使只在本地处理；不能以“没有 history 权限”为由声明完全不处理浏览数据。可选同步会通过 Chrome 同步存储传递明确选择的配置与网址。无远程执行代码、无外部 AI、无账号认证、付款或广告。

## 包与截图

运行 `make check test package` 得到两个独立 ZIP：

- `dist/TorranceTabs-v1.8.0.zip`：现有安装脚本的发布包。
- `dist/TorranceTabs-store-v1.8.0.zip`：商店上传包，manifest.json 位于根目录，仅含生产扩展文件。

128px PNG 图标位于 `extension/icons/icon-128.png`，同目录保留 SVG 源稿。商店截图位于本目录，均为实际界面与合成示例数据，无内部链接；尺寸为 640×400。预览模拟 API，不把截图当作真实多设备同步验证。

## 提交与迁移

开发者需要在 [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole) 完成账号注册/身份与联系信息、必要费用和协议，上传商店 ZIP，再填写本材料并提交审核。账号条款、付款、身份验证由账号所有者完成。商店审核、批准及分发不由本地打包保证。

现有解压版应先导出 JSON，再安装商店版并导入；确认后禁用旧扩展，避免两个版本同时整理。商店分配统一扩展身份，便于跨设备同步；已有不同 ID 的解压版不会自动共享同步数据。此版本不通过写 Chrome 配置或添加 manifest key 强制改变旧扩展身份。

参考：[提交发布](https://developer.chrome.com/docs/webstore/publish)、[账号注册](https://developer.chrome.com/docs/webstore/register)、[图片规格](https://developer.chrome.com/docs/webstore/images)、[数据处理披露](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)。
