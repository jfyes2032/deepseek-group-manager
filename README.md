# DeepSeek Chat Group Manager

为 [DeepSeek 网页版](https://chat.deepseek.com) 增加对话历史分组管理功能的 Chrome 扩展。

---

## 功能列表

### 分组管理
- **创建分组**：点击工具栏"+ 新建分组"按钮，输入名称即可创建
- **重命名分组**：双击分组标题，或右键分组选择"重命名"
- **删除分组**：右键分组选择"删除分组"，分组下的对话自动回到"未分组"
- **折叠/展开**：点击分组头部可折叠或展开该分组下的对话列表
- **分组排序**：按创建顺序排列

### 对话归类
- **移动对话到分组**：悬浮对话右侧出现的 `⋮` 按钮 → 选择目标分组
- **右键菜单移动**：在对话上右键 → 选择目标分组
- **批量移动**：勾选多个对话后，使用顶部批量工具栏的"移动到分组"
- **拖拽移动**：将对话拖到目标分组头部即可移入
- **添加未分组对话**：点击分组的 `+` 按钮，勾选要加入的对话

### 最近访问
- **自动记录**：每次点击对话时自动记录访问时间
- **置顶显示**：🕐 "最近访问"组固定在列表顶部
- **时间倒序**：最新访问的对话排在最上面
- **上限 50 条**：最多保留最近访问的 50 条记录
- **跨分组视图**：对话在"最近访问"中出现不影响其所属分组

### 快速检索
- **搜索过滤**：顶部搜索框支持按对话标题或 ID 实时过滤
- **折叠组自动展开**：搜索时匹配的对话会显示在其所属组中

### 侧边栏拖拽
- **调整宽度**：侧边栏右边缘有拖拽把手，可自由拖动 200px–500px
- **宽度记忆**：调整后的宽度自动保存，刷新页面后保持
- **自适应**：不依赖 DeepSeek 具体 DOM 结构，框架更新后大概率无需适配

### 已归档对话持久化
- **网页限制**：DeepSeek 网页版限制显示约 200 条对话，旧的对话会被虚拟列表回收
- **自动保留**：插件持续积累对话元数据，即使对话从 DOM 中消失，仍显示在侧边栏中
- **归档标记**：已归档对话使用斜体半透明样式，与当前对话区分
- **可直接打开**：点击已归档对话直接通过 URL 导航到对应页面

### 主题适配
- **自动检测**：根据 DeepSeek 页面主题（暗色/浅色）自动切换配色
- **全局 CSS 变量**：模态框、弹出菜单等挂载在 body 上的元素也能正确使用主题色

### 数据管理
- **导出备份**：点击扩展图标 → "导出数据"，下载 JSON 格式备份文件
- **导入恢复**：点击扩展图标 → "导入数据"，支持完全替换或合并到现有数据
- **清除数据**：一键清除所有分组数据（建议先导出备份）

### 其他
- **禁用插件**：popup 中提供"禁用插件"开关，临时恢复 DeepSeek 原始侧边栏
- **调试模式**：popup 中开启后，控制台输出 `[GroupManager]` 前缀的详细日志
- **调试接口**：控制台输入 `__GM__` 查看可用调试方法

---

## 安装方法

1. 打开 Chrome 浏览器，进入 `chrome://extensions`
2. 开启右上角的 **"开发者模式"** 开关
3. 点击 **"加载已解压的扩展程序"**
4. 选择 `group-manager-extension/` 文件夹
5. 打开 [chat.deepseek.com](https://chat.deepseek.com)，左侧应出现分组管理界面

---

## 文件结构

```
group-manager-extension/
├── manifest.json        # Chrome 扩展清单 (Manifest V3)
├── background.js        # Service Worker (安装初始化、消息中继)
├── content.js           # 核心逻辑 (~2700行，UI注入、分组管理、DOM监听)
├── styles.css           # 自定义样式 (暗色主题，完全自包含)
├── popup.html           # 弹出窗口 (统计、设置、导入导出)
├── popup.js             # 弹出窗口逻辑
├── icons/
│   └── icon128.png      # 扩展图标
└── README.md            # 本文件
```

---

## 技术架构

### 整体思路
- **零外部依赖**：不引用任何 CDN 资源或第三方库
- **Manifest V3**：使用最新的 Chrome 扩展标准
- **隐藏原始列表**：将 DeepSeek 原始对话列表设为 `display:none`，在同一位置渲染自定义分组树
- **保留原始 DOM**：不移除原始节点，通过引用触发原始点击事件来导航，确保 React/Vue 事件绑定不受影响
- **MutationObserver**：监听 DOM 变化，自动捕获新加载的对话

### 数据结构（chrome.storage.local）

```
groups: Array<{
  id: string          // "gm_" + timestamp + "_" + random
  name: string        // 分组名称
  order: number       // 排序权重
  collapsed: boolean  // 是否折叠
}>

conversationGroupMap: {
  [conversationId]: groupId  // 对话 → 分组映射
}

conversationMeta: {
  [conversationId]: {
    title: string          // 对话标题
    href: string           // 对话链接
    addedAt: number        // 首次发现时间戳
    lastAccessedAt: number // 最近访问时间戳
  }
}

settings: {
  debugMode: boolean   // 调试模式
  disabled: boolean    // 是否禁用
  theme: string        // "auto" | "dark" | "light"
}
```

### 选择器自动检测
- DeepSeek 使用 CSS Modules（哈希类名每次构建可能变化）
- 扩展使用 `SELECTOR_CANDIDATES` 定义多组备选选择器
- `autoDetectSelectors()` 依次尝试，选中第一个匹配到 DOM 元素的选择器
- 优先使用 `ds-*` 设计系统类名（相对稳定），其次使用结构选择器（如 `a[href*="/a/chat/"]`）

---

## DOM 选择器调试指南

当 DeepSeek 网站更新前端后，原有的 DOM 选择器可能失效（侧边栏不出现、对话列表为空等）。

### 第一步：开启调试模式

1. 点击 Chrome 工具栏中的扩展图标
2. 开启 **"调试模式"** 开关
3. 刷新 DeepSeek 页面
4. 按 `F12` 打开开发者工具 → **Console** 面板

### 第二步：运行选择器诊断

```javascript
__GM__.debugSelectors()
```

输出每组选择器的检测结果：
- 每个候选选择器匹配到的 DOM 元素数量
- 当前正在使用的选择器（标记 ✅）
- 无效的选择器（标记 ❌）

### 第三步：使用 Elements 面板定位

1. 打开开发者工具的 **Elements** 面板
2. 使用选择元素工具（`Ctrl+Shift+C`）
3. 点击 DeepSeek 左侧对话历史侧边栏
4. 观察高亮的 HTML 结构

需要找到的关键元素：

| 元素 | 说明 | 查找方法 |
|------|------|----------|
| **侧边栏容器** | 左侧面板最外层 | 通常是包含 `ds-scroll-area` 的容器 |
| **对话列表容器** | 可滚动对话列表 | 包含大量 `a[href*="/a/chat/"]` 的元素 |
| **单个对话项** | 每条对话 | `a[href*="/a/chat/"]` |
| **对话标题** | 对话标题文本 | 排除 `ds-focus-ring` 和按钮容器后的 div |
| **活跃对话标识** | 当前打开对话的高亮 | 含 `aria-current` 或 `active` 类 |

### 第四步：验证选择器

```javascript
// 测试侧边栏
document.querySelectorAll('[class*="ds-scroll-area"]')

// 测试对话项
document.querySelectorAll('a[href*="/a/chat/"]')

// 测试 ID 提取
const el = document.querySelectorAll('a[href*="/a/chat/"]')[0];
console.log('href:', el.getAttribute('href'));
```

### 第五步：更新选择器

编辑 `content.js` 中的 `SELECTOR_CANDIDATES` 对象，将新发现的选择器加到数组最前面：

```javascript
const SELECTOR_CANDIDATES = {
    sidebarContainer: [
        '[class*="new-sidebar-class"]',  // ← 新增到最前面
        '.ds-scroll-area',
        // ...
    ],
    // ...
};
```

---

## 数据迁移指南

### 场景
DeepSeek 更新导致对话 URL 格式变化时（如 `/chat/abc` → `/a/chat/abc`），对话 ID 提取结果可能改变，导致分组映射失效。

### 方案 1：标题模糊匹配（推荐）

在控制台中运行：

```javascript
(async function remapByTitle() {
    const currentItems = [];
    const itemEls = document.querySelectorAll('a[href*="/a/chat/"]');
    for (const el of itemEls) {
        const href = el.getAttribute('href') || '';
        const chatMatch = href.match(/\/chat\/([^?#]+)/);
        const id = chatMatch ? chatMatch[1] : null;
        const title = el.textContent.trim();
        if (id) currentItems.push({ id, title });
    }

    const { conversationMeta, conversationGroupMap } = await chrome.storage.local.get([
        'conversationMeta', 'conversationGroupMap'
    ]);

    const oldMap = conversationGroupMap || {};
    const oldMeta = conversationMeta || {};
    const newMap = {};
    let remapped = 0;

    for (const item of currentItems) {
        for (const [oldId, meta] of Object.entries(oldMeta)) {
            if (meta.title === item.title && oldMap[oldId]) {
                newMap[item.id] = oldMap[oldId];
                remapped++;
                break;
            }
        }
    }

    console.log(`重新匹配: ${remapped}/${currentItems.length} 个对话`);
    await chrome.storage.local.set({ conversationGroupMap: newMap });
    console.log('已更新分组映射，请刷新页面。');
})();
```

### 方案 2：导出 → 修改 → 导入

1. 点击扩展图标 → **导出数据**，下载 JSON 备份
2. 用文本编辑器打开 JSON 文件
3. 根据新旧 ID 对应关系，全局替换 `conversationGroupMap` 中的 ID
4. 点击 **导入数据**，选择修改后的文件
5. 选择"完全替换"，完成后刷新页面

### 预防措施
- 定期导出数据备份
- 给分组和对话起有意义的名称（便于标题匹配恢复）

---

## 调试接口

在 DeepSeek 页面控制台中可用的全局方法：

| 方法 | 说明 |
|------|------|
| `__GM__.debugSelectors()` | 输出所有选择器的匹配情况 |
| `__GM__.getState()` | 输出当前内部状态（分组、映射、对话数） |
| `__GM__.resetAll()` | 清除所有分组数据 |
| `__GM__.showOriginal()` | 临时显示原始侧边栏 |
| `__GM__.hideOriginal()` | 重新隐藏原始侧边栏 |

---

## 测试清单

- [ ] 创建分组 → 分组出现在侧边栏
- [ ] 移动对话到分组 → 对话从"未分组"移到目标分组下
- [ ] 刷新页面 → 分组和对话归属保持不变
- [ ] 删除分组 → 分组下的对话回到"未分组"
- [ ] 重命名分组 → 新名称在侧边栏显示
- [ ] 折叠/展开分组 → 分组内对话隐藏/显示
- [ ] 搜索过滤 → 不匹配的对话被隐藏
- [ ] "最近访问"组 → 点击对话后出现在顶部，按时间倒序
- [ ] 点击自定义列表中的对话 → 正常打开对话
- [ ] 侧边栏拖拽 → 把手可拖动，宽度记忆保持
- [ ] 批量选择 → 多选对话一次性移动
- [ ] 已归档对话 → meta 中存在但 DOM 中不存在的对话仍显示
- [ ] 导出数据 → 下载 JSON 文件
- [ ] 导入数据 → 分组数据恢复或合并
- [ ] 禁用/启用 → popup 开关可切换显示
- [ ] 暗色/浅色主题 → 自动匹配 DeepSeek 主题
