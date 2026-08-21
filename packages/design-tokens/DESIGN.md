---
version: alpha
name: Project Operations Center
description: A restrained, trustworthy operating workspace for a small internal project team.
colors:
  primary: '#0F2747'
  secondary: '#1D4ED8'
  tertiary: '#047857'
  neutral: '#F4F6F8'
  surface: '#FFFFFF'
  text: '#172033'
  muted: '#627187'
  border: '#D8DEE8'
  danger: '#B42318'
typography:
  h1:
    fontFamily: Noto Sans CJK SC
    fontSize: 1.75rem
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: '-0.01em'
  body-md:
    fontFamily: Noto Sans CJK SC
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: '0em'
rounded:
  sm: 8px
  md: 12px
  full: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.surface}'
    rounded: '{rounded.sm}'
    padding: 12px
  button-primary-hover:
    backgroundColor: '{colors.secondary}'
    textColor: '{colors.surface}'
  card:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.text}'
    rounded: '{rounded.md}'
    padding: 24px
---

## Overview

项目运营中心是面向约五人内部团队的操作型工作台。界面强调专业、可信、清晰、高效和克制；信息层级、边框和留白优先于装饰。第一版仅提供浅色办公模式。

## Colors

海军蓝负责全局结构和高强调操作；主操作蓝只用于链接、焦点和信息反馈；翠绿仅表示成功。页面浅灰、内容白色，避免渐变、玻璃效果和无意义彩色图标。

## Typography

使用系统中文无衬线字体栈以保证局域网环境无需加载外部字体。数字采用等宽数字特性；标题依靠字重与间距建立层级，不依赖超大字号。

## Layout

采用 4px 基础网格。桌面为固定侧栏加流式工作区；手机侧栏进入抽屉。桌面表格行高不低于 40px，所有触控目标不低于 44px。

## Elevation & Depth

卡片主要依靠边框分层，仅在浮层与需要强调的容器上使用轻量阴影。

## Shapes

输入和按钮使用 8px 圆角，卡片使用 12px。胶囊形只用于短状态标签。

## Components

一个区域只保留一个高强调主操作。空状态必须解释缺少什么和下一步，不以虚假指标或示例业务数据填充空间。错误状态同时包含图标、标题和文字，不能只依靠颜色。

## Do's and Don'ts

- Do：保持紧凑但可扫描，提供清晰焦点环、键盘导航和语义化标签。
- Do：让长中文、英文名称自然换行或截断，不破坏布局。
- Don't：使用营销式 hero、渐变背景、玻璃拟态、装饰性统计或三等分功能卡。
- Don't：把前端导航隐藏当作授权；API 始终执行服务端授权。
