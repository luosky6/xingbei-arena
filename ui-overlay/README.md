# 运行时现代主题

`modern-theme.css` 与 `install.js` 是无名星杯的可逆视觉 overlay：只增加 `body.xb-modern` 作用域下的颜色、层级、圆角、响应式和减少动效规则，不修改 `noname_xingbei` 的 CSS/JS，也不触碰规则、卡牌或隐藏信息。

启用方式：

```powershell
$env:XB_MODERN_UI='1'
$env:XB_MATCHES='1'
npm run selfplay
```

bridge 同样支持 `XB_MODERN_UI=1`。未设置时保持原主题，便于视觉回归对照。主题安装器有幂等和卸载函数，后续可把设计 token 扩展到选角、BP、观战 HUD，而不把 UI 变成规则真源。

视觉基线：`npm run ui:screenshot` 分别生成 `runtime/ui-screenshots/legacy.{png,json}` 与 `modern.{png,json}`（设置 `XB_MODERN_UI=1` 生成 modern）。JSON 记录视口、主题标记、关键 DOM 数量和可见文本前缀，PNG 供人工/像素差异检查。
