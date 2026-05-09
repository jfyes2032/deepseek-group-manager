/**
 * content.js - DeepSeek Chat Group Manager
 *
 * ============================================================
 * 核心架构说明
 * ============================================================
 *
 * 本文件在 DeepSeek 页面（chat.deepseek.com）加载完成后注入执行。
 * 采用"隐藏原始列表 + 渲染自定义分组列表"的架构：
 *
 * 1. 保留原始 DOM 节点在页面中（display:none），以保持 React/Vue 事件绑定活跃
 * 2. 在原始容器内创建自定义分组树视图 .gm-root
 * 3. 用户点击自定义列表项时，通过引用找到原始 DOM 节点并触发其点击事件
 * 4. 使用 MutationObserver 监听动态加载的新对话
 * 5. 所有数据通过 chrome.storage.local 持久化
 *
 * ============================================================
 * DOM 选择器策略
 * ============================================================
 *
 * 由于 DeepSeek 网站会更新其前端代码，DOM 类名可能变化。
 * 本扩展使用"候选选择器 + 自动检测"策略：
 *
 * - SELECTOR_CANDIDATES 对象定义了多组备选选择器
 * - autoDetectSelectors() 依次尝试每组选择器，找到匹配的即采用
 * - 检测结果会输出到控制台（调试模式），方便排查失效问题
 * - 用户可在 popup 中覆盖选择器
 *
 * 如何查找最新的 DOM 选择器？
 * 参见 README.md 中的"如何定位最新 DOM 选择器"调试指南。
 *
 * ============================================================
 * 数据结构说明
 * ============================================================
 *
 * chrome.storage.local 中存储以下键：
 *
 * groups: Array<{
 *   id: string,        // 唯一标识，生成规则: "gm_" + Date.now() + "_" + 随机数
 *   name: string,      // 分组名称，如"工作"、"学习"
 *   order: number,     // 显示顺序（数字越小越靠前）
 *   collapsed: boolean // 是否折叠
 * }>
 *
 * conversationGroupMap: {
 *   [conversationId: string]: groupId  // 对话 ID → 所属分组 ID
 * }
 *   - conversationId 来自 DeepSeek 对话的唯一标识
 *   - groupId 为 null 或不存在该键表示"未分组"
 *
 * conversationMeta: {
 *   [conversationId: string]: {
 *     title: string,   // 对话标题（缓存，用于搜索和显示）
 *     href: string,    // 对话链接
 *     addedAt: number  // 首次发现时间戳
 *   }
 * }
 *
 * ============================================================
 * 对话 ID 提取方式
 * ============================================================
 *
 * 优先使用 data-conversation-id 属性，其次从 <a> 标签的 href 中提取。
 * 常见格式：
 *   - /chat/abc123-def456  → 提取 "abc123-def456"
 *   - /a/chat/abc123       → 提取 "abc123"
 *   - data-conversation-id="abc123"
 * 提取逻辑见 extractConversationId() 函数。
 */

// ============================================================
// ╔══════════════════════════════════════════════════════════╗
// ║        第一部分：选择器配置 & 自动检测                    ║
// ╚══════════════════════════════════════════════════════════╝
// ============================================================

/**
 * DOM 选择器候选列表
 *
 * 每个字段对应页面上的一个关键元素。数组中的每一项是一组
 * 备选 CSS 选择器，按优先级排列（排前面的优先尝试）。
 *
 * 当 DeepSeek 更新前端后，只需修改此处的选择器即可适配。
 * 在控制台运行 debugSelectors() 可辅助定位正确的选择器。
 */
const SELECTOR_CANDIDATES = {
    /**
     * 侧边栏容器 — 整个左侧面板的根元素
     *
     * DeepSeek 当前结构（2025.05 实测）:
     * body > div > ... > div.cb86951c（侧边栏最外层）
     * 内部使用 .ds-scroll-area（DeepSeek 设计系统滚动区）
     *
     * 注意：哈希类名（cb86951c）每次构建可能变化，
     * 因此优先使用 .ds-* 设计系统类名（相对稳定）。
     * 如果 .ds-* 也失效，则通过对话链接反向查找容器。
     */
    sidebarContainer: [
        // 策略1: 通过 ds-scroll-area 找包含对话链接的那个
        '.ds-scroll-area',
        // 策略2: 通过 ds-virtual-list 向上查找
        '[class*="ds-virtual-list"]',
        // 策略3: 通过 ds-floating-container 下的面板
        '.ds-floating-container [class*="ds-scroll-area"]',
        // 策略4: 通用侧边栏类名（DeepSeek 可能没有，做后备）
        '[class*="sidebar"]',
        'nav',
        'aside',
    ],

    /**
     * 对话列表容器 — 包含所有对话项的滚动区域
     *
     * DeepSeek 使用虚拟列表:
     * .ds-virtual-list > .ds-virtual-list-items > .ds-virtual-list-visible-items
     *
     * 其中 .ds-virtual-list-visible-items 包含当前可见的对话项（约10个）。
     * 但所有对话链接都在 DOM 中（约199个），只是部分被虚拟列表回收。
     *
     * 有效策略：用 .ds-virtual-list-visible-items 定位虚拟列表可见区，
     * 同时用 a[href*="/a/chat/"] 全局扫描所有对话。
     */
    conversationList: [
        // DeepSeek 设计系统虚拟列表可见区
        '[class*="ds-virtual-list-visible-items"]',
        '[class*="ds-virtual-list-items"]',
        '[class*="ds-virtual-list"]',
        // DeepSeek 设计系统滚动区
        '.ds-scroll-area',
        // 通用后备：包含多个 /a/chat/ 链接的容器
        'div:has(a[href*="/a/chat/"])',
        'a[href*="/chat/"]',
    ],

    /**
     * 单个对话项 — 列表中的每一项
     *
     * DeepSeek 当前（2025.05）结构:
     * <a class="_546d736" href="/a/chat/s/{uuid}" tabindex="0">
     *   <div class="ds-focus-ring"></div>
     *   <div class="c08e6e93">对话标题</div>
     *   <div class="_254829d"><button class="ds-icon-button">...</button></div>
     * </a>
     *
     * 关键特征: href 包含 /a/chat/（DeepSeek 独有）
     * 哈希类名 _546d736 每次构建可能变化，不能依赖。
     */
    conversationItem: [
        'a[href*="/a/chat/"]',                   // DeepSeek 专属格式
        'a[href*="/chat/"]',                     // 通用后备
        '[class*="conversation-item"]',
        '[class*="chat-item"]',
        'li a',
    ],

    /**
     * 对话标题文本所在的元素（相对于 conversationItem）
     *
     * DeepSeek 当前: <a> 内第二个 <div>（class="c08e6e93"，但哈希类名不可靠）
     * 稳健策略: 排除 .ds-focus-ring 和包含 .ds-icon-button 的 div 后的那个 div
     * 等价于 a > div:not(.ds-focus-ring):not(:has(.ds-icon-button))
     */
    conversationTitle: [
        // 最精准：排除 focus-ring 和按钮容器后的 div
        'div:not([class*="ds-focus-ring"]):not(:has(.ds-icon-button))',
        // 哈希类名（当前有效，但可能随更新变化）
        '[class*="c08e6e93"]',
        '[class*="title"]',
        '[class*="name"]',
        'span',
        'div',
    ],

    /**
     * 当前活跃对话的标识（用于高亮）
     *
     * DeepSeek 可能在活跃对话的 <a> 或其父元素上设置特殊属性。
     * 常见模式: aria-current, class 含 active/selected
     */
    activeConversation: [
        '[aria-current]',
        '[class*="active"]',
        '[class*="current"]',
        '[class*="selected"]',
    ],

    /**
     * "新对话"按钮 — 暂未使用，预留
     */
    newChatButton: [
        '[class*="new-chat"]',
        '[class*="newChat"]',
        'button[class*="new"]',
    ],
};

/**
 * 经过自动检测后确定使用的选择器（运行时填充）
 */
let SELECTORS = {};

/**
 * 调试模式标志
 */
let DEBUG = false;

/**
 * 自动检测 DOM 选择器
 *
 * 依次尝试 SELECTOR_CANDIDATES 中的每组备选选择器，
 * 使用第一个能匹配到至少一个 DOM 元素的。
 *
 * 检测优先级：
 * 1. 用户自定义覆盖（从 storage 读取 selectorOverrides）
 * 2. 自动检测结果
 * 3. 后备默认值（数组中的最后一个）
 *
 * @returns {object} 确定使用的选择器映射
 */
function autoDetectSelectors() {
    const detected = {};

    for (const [key, candidates] of Object.entries(SELECTOR_CANDIDATES)) {
        let found = null;
        for (const selector of candidates) {
            try {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    // ---- 特殊校验：sidebarContainer 应包含对话链接 ----
                    if (key === 'sidebarContainer') {
                        // 如果匹配到多个 ds-scroll-area，选那个包含对话链接的
                        let bestEl = null;
                        for (const el of elements) {
                            if (el.querySelectorAll('a[href*="/a/chat/"]').length > 0) {
                                bestEl = el;
                                break;
                            }
                        }
                        if (!bestEl) continue; // 没有对话链接，换下一个选择器
                        // 特殊标记：sidebarContainer 不用 CSS 选择器字符串，
                        // 而是用 DOM 元素直接引用（因为同一个选择器可能匹配多个元素）
                        found = selector;
                        // 存储额外的引用信息供 init 使用
                        detected._sidebarElement = bestEl;
                    }
                    // ---- 特殊校验：conversationList 应包含足够对话 ----
                    else if (key === 'conversationList') {
                        let bestEl = null;
                        for (const el of elements) {
                            const linkCount = el.querySelectorAll('a[href*="/a/chat/"]').length;
                            if (linkCount >= 2) {
                                bestEl = el;
                                break;
                            }
                        }
                        if (!bestEl) continue;
                        detected._conversationListElement = bestEl;
                        found = selector;
                    }
                    // ---- 普通校验：匹配即可 ----
                    else {
                        found = selector;
                    }

                    log(`[SelectorDetect] ${key} = "${selector}" (匹配 ${elements.length} 个元素)`);
                    break;
                }
            } catch (_) {
                // 无效选择器（如 :has() 在不支持的浏览器中），跳过
                continue;
            }
        }
        if (found) {
            detected[key] = found;
        } else {
            detected[key] = candidates[candidates.length - 1];
            log(`[SelectorDetect] ${key} = "${detected[key]}" (后备，无匹配)`, 'warn');
        }
    }

    return detected;
}

// ============================================================
// ╔══════════════════════════════════════════════════════════╗
// ║        第二部分：工具函数                                  ║
// ╚══════════════════════════════════════════════════════════╝
// ============================================================

/**
 * 生成唯一 ID
 * 格式: "gm_" + 时间戳 + "_" + 随机字符串
 * @returns {string} 唯一标识符
 */
function generateId() {
    return 'gm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * 调试日志输出（仅在调试模式下输出）
 * @param {string} msg - 日志消息
 * @param {'log'|'warn'|'error'} level - 日志级别
 */
function log(msg, level = 'log') {
    if (DEBUG) {
        const prefix = '[GroupManager]';
        switch (level) {
            case 'warn': console.warn(prefix, msg); break;
            case 'error': console.error(prefix, msg); break;
            default: console.log(prefix, msg); break;
        }
    }
}

/**
 * 从对话项 DOM 元素中提取唯一标识 ID
 *
 * 提取策略（按优先级）：
 * 1. 元素上的 data-conversation-id 属性
 * 2. 元素上的 data-id 属性
 * 3. href 属性中的路径部分
 *    - "/chat/abc123" → "abc123"
 *    - "/a/chat/abc123" → "abc123"
 * 4. 元素自身的 id 属性
 *
 * @param {Element} itemEl - 对话项的 DOM 元素
 * @returns {string|null} 对话唯一标识，提取失败返回 null
 */
function extractConversationId(itemEl) {
    // 策略 1: data-conversation-id 属性（最精确）
    const convId = itemEl.getAttribute('data-conversation-id');
    if (convId) return convId.trim();

    // 策略 2: data-id 属性
    const dataId = itemEl.getAttribute('data-id');
    if (dataId) return dataId.trim();

    // 策略 3: 从链接 href 提取
    const linkEl = itemEl.tagName === 'A' ? itemEl : itemEl.querySelector('a');
    if (linkEl) {
        const href = linkEl.getAttribute('href') || '';
        // DeepSeek 实际格式: /a/chat/s/70e06e0a-ca9c-439a-afae-1767f8b04540
        // [^?#]+ 匹配 /chat/ 之后直到 ? 或 # 之前的所有字符（包含中间的 /）
        // 结果如 "s/70e06e0a-ca9c-439a-afae-1767f8b04540"
        const chatMatch = href.match(/\/chat\/([^?#]+)/);
        if (chatMatch) return chatMatch[1];

        // 简短格式: /c/xxx
        const shortMatch = href.match(/\/c\/([^?#]+)/);
        if (shortMatch) return shortMatch[1];
    }

    // 策略 4: 元素自身的 id
    if (itemEl.id) return itemEl.id;

    // 策略 5: URL 哈希作为后备
    if (linkEl) {
        const href = linkEl.getAttribute('href') || '';
        if (href && href !== '#') {
            return 'gm_fallback_' + hashCode(href);
        }
    }

    return null;
}

/**
 * 简单字符串哈希函数（用于后备 ID 生成）
 * @param {string} str
 * @returns {string} 哈希值（十六进制）
 */
function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // 转为 32 位整数
    }
    return Math.abs(hash).toString(16);
}

/**
 * 从对话项 DOM 元素中提取对话标题
 *
 * 策略：
 * 1. 查找 title 属性（通常 a 标签的 title 或 aria-label）
 * 2. 查找子元素中的文本内容
 * 3. 查找元素自身的文本内容
 *
 * @param {Element} itemEl - 对话项的 DOM 元素
 * @returns {string} 对话标题
 */
function extractConversationTitle(itemEl) {
    // itemEl 是 <a> 标签本身
    const el = itemEl;

    // 策略 1: aria-label 或 title 属性
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const titleAttr = el.getAttribute('title');
    if (titleAttr && titleAttr.trim()) return titleAttr.trim();

    // 策略 2: 使用 CSS 选择器查找标题 div
    // DeepSeek 结构: <a> > div.ds-focus-ring + div(标题) + div(按钮容器)
    const titleSel = SELECTORS.conversationTitle;
    if (titleSel) {
        try {
            const titleEl = el.querySelector(titleSel);
            if (titleEl && titleEl.textContent.trim()) {
                return titleEl.textContent.trim();
            }
        } catch (_) {
            // :has() 可能不被支持，走后续 JS 逻辑
        }
    }

    // 策略 3 (JS 后备): 在 <a> 的直接子 div 中找标题
    // DeepSeek 结构: 第1个 div = ds-focus-ring, 第2个 div = 标题, 第3个 div = 按钮
    const directDivs = Array.from(el.children).filter(
        child => child.tagName === 'DIV'
    );
    for (const div of directDivs) {
        const cls = div.className || '';
        // 跳过 focus-ring
        if (cls.includes('ds-focus-ring')) continue;
        // 跳过包含按钮的容器（如 _254829d）
        if (div.querySelector('button, [role="button"]')) continue;
        // 找到了：这就是标题 div
        const text = div.textContent.trim();
        if (text) return text;
    }

    // 策略 4: 取整个 <a> 的文本，但去掉按钮的文本
    const fullText = el.textContent.trim();
    if (fullText) {
        // 尝试排除最后一段文本（通常是按钮图标）
        const parts = directDivs.map(d => d.textContent.trim()).filter(Boolean);
        if (parts.length > 1) {
            // 返回非按钮的部分
            return parts[0] || fullText;
        }
        return fullText.length > 100 ? fullText.slice(0, 97) + '...' : fullText;
    }

    return '(无标题)';
}

/**
 * 从对话项中提取链接 href
 * @param {Element} itemEl - 对话项的 DOM 元素
 * @returns {string} 链接 URL
 */
function extractConversationHref(itemEl) {
    const linkEl = itemEl.tagName === 'A' ? itemEl : itemEl.querySelector('a');
    return linkEl ? linkEl.getAttribute('href') || '#' : '#';
}

/**
 * 防抖函数
 * @param {Function} fn - 要执行的函数
 * @param {number} delay - 延迟毫秒数
 * @returns {Function} 防抖包装后的函数
 */
function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

/**
 * 安全地执行 querySelector 并返回结果
 * @param {string} selector - CSS 选择器
 * @param {Element} root - 根元素，默认为 document
 * @returns {Element|null}
 */
function safeQuery(selector, root = document) {
    try {
        return root.querySelector(selector);
    } catch (_) {
        return null;
    }
}

/**
 * 安全地执行 querySelectorAll 并返回数组
 * @param {string} selector - CSS 选择器
 * @param {Element} root - 根元素
 * @returns {Element[]}
 */
function safeQueryAll(selector, root = document) {
    try {
        return Array.from(root.querySelectorAll(selector));
    } catch (_) {
        return [];
    }
}

// ============================================================
// ╔══════════════════════════════════════════════════════════╗
// ║        第三部分：数据管理层                                ║
// ╚══════════════════════════════════════════════════════════╝
// ============================================================

/**
 * DeepSeekGroupManager — 数据管理类
 *
 * 封装所有与 chrome.storage.local 的交互，提供高层 API。
 * 所有数据操作均为异步（通过回调或 Promise 包装）。
 */
class DataManager {
    /**
     * 从 storage 加载所有数据
     * @returns {Promise<{groups: Array, mapping: Object, meta: Object, settings: Object}>}
     */
    static loadAll() {
        return new Promise((resolve) => {
            chrome.storage.local.get(
                ['groups', 'conversationGroupMap', 'conversationMeta', 'settings'],
                (result) => {
                    resolve({
                        groups: result.groups || [],
                        mapping: result.conversationGroupMap || {},
                        meta: result.conversationMeta || {},
                        settings: result.settings || {}
                    });
                }
            );
        });
    }

    /**
     * 保存分组列表
     * @param {Array} groups
     */
    static saveGroups(groups) {
        return new Promise((resolve) => {
            chrome.storage.local.set({ groups }, resolve);
        });
    }

    /**
     * 保存对话到分组的映射
     * @param {Object} mapping - {conversationId: groupId}
     */
    static saveMapping(mapping) {
        return new Promise((resolve) => {
            chrome.storage.local.set({ conversationGroupMap: mapping }, resolve);
        });
    }

    /**
     * 保存对话元数据
     * @param {Object} meta
     */
    static saveMeta(meta) {
        return new Promise((resolve) => {
            chrome.storage.local.set({ conversationMeta: meta }, resolve);
        });
    }

    /**
     * 创建新分组
     * @param {string} name - 分组名称
     * @param {Array} existingGroups - 现有分组列表
     * @returns {Promise<{group: Object, groups: Array}>}
     */
    static async createGroup(name, existingGroups) {
        const group = {
            id: generateId(),
            name: name.trim(),
            order: existingGroups.length,
            collapsed: false
        };
        const groups = [...existingGroups, group];
        await this.saveGroups(groups);
        return { group, groups };
    }

    /**
     * 重命名分组
     * @param {string} groupId
     * @param {string} newName
     * @param {Array} groups
     * @returns {Promise<Array>} 更新后的分组列表
     */
    static async renameGroup(groupId, newName, groups) {
        const updated = groups.map(g =>
            g.id === groupId ? { ...g, name: newName.trim() } : g
        );
        await this.saveGroups(updated);
        return updated;
    }

    /**
     * 删除分组
     * @param {string} groupId
     * @param {Array} groups
     * @param {Object} mapping
     * @returns {Promise<{groups: Array, mapping: Object}>}
     */
    static async deleteGroup(groupId, groups, mapping) {
        // 移除该分组下的所有映射（使对话回到"未分组"状态）
        const newMapping = { ...mapping };
        for (const [convId, gId] of Object.entries(newMapping)) {
            if (gId === groupId) {
                delete newMapping[convId];
            }
        }
        const newGroups = groups.filter(g => g.id !== groupId);
        await this.saveGroups(newGroups);
        await this.saveMapping(newMapping);
        return { groups: newGroups, mapping: newMapping };
    }

    /**
     * 移动对话到指定分组
     * @param {string} conversationId
     * @param {string|null} groupId - null 表示移到"未分组"
     * @param {Object} mapping
     * @returns {Promise<Object>} 更新后的映射
     */
    static async moveConversation(conversationId, groupId, mapping) {
        const newMapping = { ...mapping };
        if (groupId === null) {
            delete newMapping[conversationId];
        } else {
            newMapping[conversationId] = groupId;
        }
        await this.saveMapping(newMapping);
        return newMapping;
    }

    /**
     * 批量移动对话
     * @param {string[]} conversationIds
     * @param {string|null} groupId
     * @param {Object} mapping
     * @returns {Promise<Object>}
     */
    static async batchMoveConversations(conversationIds, groupId, mapping) {
        const newMapping = { ...mapping };
        for (const convId of conversationIds) {
            if (groupId === null) {
                delete newMapping[convId];
            } else {
                newMapping[convId] = groupId;
            }
        }
        await this.saveMapping(newMapping);
        return newMapping;
    }

    /**
     * 更新分组折叠状态
     * @param {string} groupId
     * @param {boolean} collapsed
     * @param {Array} groups
     * @returns {Promise<Array>}
     */
    static async setGroupCollapsed(groupId, collapsed, groups) {
        const updated = groups.map(g =>
            g.id === groupId ? { ...g, collapsed } : g
        );
        await this.saveGroups(updated);
        return updated;
    }

    /**
     * 保存设置
     * @param {Object} settings
     */
    static async saveSettings(settings) {
        return new Promise((resolve) => {
            chrome.storage.local.set({ settings }, resolve);
        });
    }
}

// ============================================================
// ╔══════════════════════════════════════════════════════════╗
// ║        第四部分：UI 构建层                                ║
// ╚══════════════════════════════════════════════════════════╝
// ============================================================

/**
 * UIManager — 用户界面管理类
 *
 * 负责：
 * 1. 构建自定义分组列表 DOM 树
 * 2. 处理用户交互事件（点击、拖拽、菜单操作）
 * 3. 维护自定义列表与原始 DOM 节点的映射关系
 * 4. 搜索过滤
 *
 * 所有 DOM 操作集中在此类中，方便维护和调试。
 */
class UIManager {
    constructor() {
        // 核心 DOM 引用
        /** @type {HTMLElement|null} 自定义分组列表的根容器 */
        this.root = null;
        /** @type {HTMLElement|null} 搜索输入框 */
        this.searchInput = null;
        /** @type {HTMLElement|null} 列表滚动容器 */
        this.listContainer = null;
        /** @type {HTMLElement|null} 原始对话列表容器（被隐藏） */
        this.originalContainer = null;
        /** @type {HTMLElement|null} 原始侧边栏容器 */
        this.originalSidebar = null;

        // 状态
        /** @type {Map<string, HTMLElement>} conversationId → 原始 DOM 元素的映射 */
        this.originalItemMap = new Map();
        /** @type {Map<string, HTMLElement>} conversationId → 自定义 DOM 元素的映射 */
        this.customItemMap = new Map();
        /** @type {string|null} 当前活跃的对话 ID */
        this.activeConversationId = null;
        /** @type {Set<string>} 批量选择模式下选中的对话 ID */
        this.selectedIds = new Set();
        /** @type {boolean} 是否处于批量选择模式 */
        this.batchMode = false;
        /** @type {string} 当前搜索关键词 */
        this.searchQuery = '';

        // 数据引用（由 App 设置）
        /** @type {Array} 分组列表 */
        this.groups = [];
        /** @type {Object} 对话→分组映射 */
        this.mapping = {};
        /** @type {Object} 对话元数据 */
        this.meta = {};
    }

    /**
     * 初始化 UI：找到原始侧边栏并注入自定义列表
     *
     * 这是整个 UI 的入口点。如果找不到原始侧边栏，
     * 会启动重试机制（等待 React 渲染完成）。
     *
     * @returns {boolean} 是否成功找到并初始化
     */
    init() {
        // =====================================================
        // 步骤 1: 定位侧边栏容器
        // =====================================================
        if (SELECTORS._sidebarElement) {
            this.originalSidebar = SELECTORS._sidebarElement;
        } else {
            this.originalSidebar = safeQuery(SELECTORS.sidebarContainer);
        }

        if (!this.originalSidebar) {
            const firstLink = safeQuery('a[href*="/a/chat/"]');
            if (firstLink) {
                let parent = firstLink.parentElement;
                for (let i = 0; i < 10 && parent; i++) {
                    const hasScrollArea = parent.querySelector('[class*="ds-scroll-area"]');
                    if (hasScrollArea && parent.offsetWidth >= 150 && parent.offsetWidth <= 450) {
                        this.originalSidebar = parent;
                        log('通过对话链接反向查找到侧边栏');
                        break;
                    }
                    parent = parent.parentElement;
                }
            }
            if (!this.originalSidebar) {
                log('未找到侧边栏容器，将在 500ms 后重试...', 'warn');
                return false;
            }
        }
        log('✓ 找到侧边栏容器');

        // =====================================================
        // 步骤 2: 定位要隐藏的原始滚动区容器
        // =====================================================
        // 关键：DeepSeek 使用 ds-scroll-area 作为可滚动列表容器。
        // 我们需要在侧边栏内找到包含对话链接的那个 ds-scroll-area，
        // 并将其隐藏，然后在原位置插入自定义 UI。
        //
        // 优先使用检测到的容器元素，但如果它只是虚拟列表子项
        // （ds-virtual-list-visible-items），则向上查找到 ds-scroll-area。
        if (SELECTORS._conversationListElement) {
            let candidate = SELECTORS._conversationListElement;
            // 如果是虚拟列表可见区，向上走到真正的滚动容器
            if (candidate.className && candidate.className.includes('ds-virtual-list-visible-items')) {
                candidate = candidate.closest('[class*="ds-scroll-area"]') || candidate;
            }
            this.originalContainer = candidate;
        } else {
            this.originalContainer = safeQuery(
                SELECTORS.conversationList,
                this.originalSidebar
            );
        }

        if (!this.originalContainer) {
            // 后备：在侧边栏内找包含最多对话链接的元素
            let maxLinks = 0;
            let bestContainer = null;
            const allContainers = this.originalSidebar.querySelectorAll('*');
            for (const el of allContainers) {
                const linkCount = el.querySelectorAll('a[href*="/a/chat/"]').length;
                if (linkCount > maxLinks && el.children.length >= 2) {
                    maxLinks = linkCount;
                    bestContainer = el;
                }
            }
            // 向上走到 ds-scroll-area
            if (bestContainer) {
                this.originalContainer = bestContainer.closest('[class*="ds-scroll-area"]') || bestContainer;
            }
            if (!this.originalContainer) {
                log('未找到对话列表容器，将在 500ms 后重试...', 'warn');
                return false;
            }
        }
        log('✓ 找到对话列表滚动容器');

        // =====================================================
        // 步骤 3: 标记原始容器
        // =====================================================
        this.originalContainer.setAttribute('data-gm-original-list', 'true');

        // =====================================================
        // 步骤 4: 创建自定义 UI 根节点
        // =====================================================
        this.root = document.createElement('div');
        this.root.className = 'gm-root';
        this.root.setAttribute('data-gm-root', 'true');

        // =====================================================
        // 步骤 5: 在原始容器旁边插入自定义 UI，然后隐藏原始容器
        // =====================================================
        // 使用百分比宽度（而非固定像素），以便侧边栏拖拽调整大小时自适应
        this.root.style.width = '100%';
        this.root.style.height = '100%';

        this.originalContainer.parentNode.insertBefore(
            this.root,
            this.originalContainer
        );
        this.hideOriginalContainer(true);

        // =====================================================
        // 步骤 6: 构建 UI 组件
        // =====================================================
        this.buildToolbar();
        this.buildBatchBar();
        this.buildListContainer();

        // =====================================================
        // 步骤 7: 设置侧边栏拖拽调整宽度
        // =====================================================
        this.setupResizeHandle();

        return true;
    }

    /**
     * 设置侧边栏拖拽调整宽度把手
     *
     * 策略：把手挂在 gm-root 自身（不依赖 DeepSeek 具体 DOM 结构）。
     * 拖拽时，从 gm-root 向上遍历祖先链，对所有宽度在 150-600px
     * 范围内的元素设置 !important 内联宽度。这样无论 DeepSeek
     * 未来如何重构 DOM 层级，只要侧边栏容器宽度在此区间就能生效。
     */
    setupResizeHandle() {
        const storageKey = 'gm_sidebar_width';

        // gm-root 作为把手定位的锚点
        this.root.style.position = 'relative';

        // 核心：从 gm-root 向上，覆盖所有可能是侧边栏容器的元素
        const setWidth = (w) => {
            const px = w + 'px';
            let el = this.root;
            for (let i = 0; i < 12 && el && el !== document.body && el !== document.documentElement; i++) {
                const elW = parseFloat(window.getComputedStyle(el).width);
                if (elW >= 150 && elW <= 600) {
                    // 侧边栏范围内的元素：锁定宽度
                    el.style.setProperty('width', px, 'important');
                    el.style.setProperty('min-width', px, 'important');
                    el.style.setProperty('max-width', px, 'important');
                    el.style.setProperty('flex-basis', px, 'important');
                    // flex-grow/shrink 只在父容器为水平 flex 时锁定，
                    // 避免干扰垂直 flex 布局（如 footer、用户面板）
                    if (el.parentElement) {
                        const pDir = window.getComputedStyle(el.parentElement).flexDirection;
                        if (pDir === 'row' || pDir === 'row-reverse') {
                            el.style.setProperty('flex-grow', '0', 'important');
                            el.style.setProperty('flex-shrink', '0', 'important');
                        }
                    }
                }
                el = el.parentElement;
            }
        };

        // 恢复已保存宽度
        chrome.storage.local.get([storageKey], (result) => {
            if (result[storageKey]) {
                setWidth(result[storageKey]);
            }
        });

        // 创建拖拽把手，挂在 gm-root 右边缘
        const handle = document.createElement('div');
        handle.className = 'gm-resize-handle';
        this.root.appendChild(handle);

        let startX = 0;
        let startWidth = 0;

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            startX = e.clientX;
            startWidth = this.root.offsetWidth;
            handle.classList.add('gm-resizing');
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';

            const onMove = (ev) => {
                const delta = ev.clientX - startX;
                const newWidth = Math.max(200, Math.min(500, startWidth + delta));
                setWidth(newWidth);
            };
            const onUp = () => {
                handle.classList.remove('gm-resizing');
                document.body.style.userSelect = '';
                document.body.style.cursor = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                chrome.storage.local.set({ [storageKey]: this.root.offsetWidth });
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        log('setupResizeHandle: 把手挂在 gm-root 右边缘，宽度覆盖祖先链');
    }

    /**
     * 隐藏/显示原始对话列表容器
     *
     * 使用 display:none 而非移除 DOM，因为：
     * 1. React 的事件委托仍然可以工作
     * 2. 原始节点可以随时克隆或被引用
     * 3. 不会触发 DeepSeek 的卸载逻辑
     *
     * @param {boolean} hide - true=隐藏, false=显示
     */
    hideOriginalContainer(hide) {
        if (this.originalContainer) {
            this.originalContainer.style.display = hide ? 'none' : '';
        }
    }

    /**
     * 构建顶部工具栏
     * 包含：搜索输入框 + 新建分组按钮
     */
    buildToolbar() {
        const toolbar = document.createElement('div');
        toolbar.className = 'gm-toolbar';

        // 搜索输入框
        this.searchInput = document.createElement('input');
        this.searchInput.type = 'text';
        this.searchInput.className = 'gm-search-input';
        this.searchInput.placeholder = '搜索对话...';
        this.searchInput.addEventListener('input', debounce(() => {
            this.searchQuery = this.searchInput.value.toLowerCase().trim();
            this.renderAll();
        }, 200));

        // 新建分组按钮
        const newGroupBtn = document.createElement('button');
        newGroupBtn.className = 'gm-btn';
        newGroupBtn.textContent = '+ 新建分组';
        newGroupBtn.addEventListener('click', () => this.showCreateGroupDialog());

        toolbar.appendChild(this.searchInput);
        toolbar.appendChild(newGroupBtn);
        this.root.appendChild(toolbar);
    }

    /**
     * 构建批量操作工具栏（默认隐藏）
     */
    buildBatchBar() {
        const batchBar = document.createElement('div');
        batchBar.className = 'gm-batch-bar';
        batchBar.setAttribute('data-gm-batch-bar', 'true');

        const label = document.createElement('span');
        label.id = 'gm-batch-label';
        label.textContent = '已选择 0 项';
        batchBar.appendChild(label);

        const moveBtn = document.createElement('button');
        moveBtn.className = 'gm-btn gm-btn-sm';
        moveBtn.textContent = '移动到分组';
        moveBtn.addEventListener('click', () => {
            if (this.selectedIds.size > 0) {
                this.showMoveMenu(
                    Array.from(this.selectedIds),
                    null, // 位置不重要，因为是批量操作
                    null
                );
            }
        });
        batchBar.appendChild(moveBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'gm-btn gm-btn-sm gm-btn-ghost';
        cancelBtn.textContent = '取消选择';
        cancelBtn.addEventListener('click', () => this.toggleBatchMode(false));
        batchBar.appendChild(cancelBtn);

        this.root.appendChild(batchBar);
    }

    /**
     * 构建滚动列表容器
     * 所有分组和对话项在此容器内渲染
     */
    buildListContainer() {
        this.listContainer = document.createElement('div');
        this.listContainer.className = 'gm-list-container';
        this.listContainer.addEventListener('scroll', () => {
            this.handleListScroll();
        });
        this.root.appendChild(this.listContainer);
    }

    // ============================================================
    // 扫描原始对话项
    // ============================================================

    /**
     * 扫描原始 DOM 中所有对话项
     *
     * 遍历原始对话列表容器，提取每个对话项的：
     * - 唯一 ID（通过 extractConversationId）
     * - 标题（通过 extractConversationTitle）
     * - 链接（通过 extractConversationHref）
     * - 原始 DOM 元素引用
     *
     * 对于之前未出现的新对话，创建其元数据记录。
     * 这使后续的自定义列表渲染可以跨会话重建。
     *
     * @returns {Array<{id: string, title: string, href: string, element: HTMLElement, isActive: boolean}>}
     */
    scanOriginalItems() {
        // ========================================================
        // 全局扫描：因为 DeepSeek 使用虚拟列表，对话链接可能分散
        // 在 ds-virtual-list-visible-items 内及其他位置。
        // 使用 a[href*="/a/chat/"] 全局查找所有对话链接。
        // ========================================================
        const items = [];
        // 从 document 全局扫描所有对话链接（而非仅 originalSidebar 内）
        // 原因：DeepSeek 虚拟列表可能将对话链接分散在多个容器中，
        // 限制搜索范围会导致部分链接被遗漏。
        const itemElements = safeQueryAll(
            SELECTORS.conversationItem,
            document
        );
        // 去重：同一个 ID 只保留第一个（防止页面不同区域有重复链接）
        const seenIds = new Set();

        for (const el of itemElements) {
            const id = extractConversationId(el);
            if (!id) continue;
            // 去重：跳过已见过的 ID（可能是页面不同区域的同一对话链接）
            if (seenIds.has(id)) continue;
            seenIds.add(id);

            const title = extractConversationTitle(el);
            const href = extractConversationHref(el);

            // 检查是否为当前活跃对话
            const isActive = el.getAttribute('aria-current') === 'true'
                          || el.classList.contains('active')
                          || el.hasAttribute('aria-selected')
                          || !!el.closest('[aria-current]');
            if (isActive) {
                this.activeConversationId = id;
            }

            // 缓存原始元素引用（用于点击激活）
            this.originalItemMap.set(id, el);

            items.push({ id, title, href, element: el, isActive });
        }

        // 更新元数据缓存
        this.updateMetaCache(items);

        log(`扫描到 ${items.length} 个对话项` +
            (this.activeConversationId ? `，当前活跃: ${this.activeConversationId}` : ''));
        return items;
    }

    /**
     * 更新对话元数据缓存
     *
     * 对于新发现的对话（meta 中不存在的），创建元数据条目。
     * 对于已存在的对话，更新其标题（DeepSeek 可能在用户重命名对话后更新标题）。
     *
     * @param {Array} items - scanOriginalItems() 的返回值
     */
    updateMetaCache(items) {
        let changed = false;
        for (const item of items) {
            if (!this.meta[item.id]) {
                // 新对话：创建元数据
                this.meta[item.id] = {
                    title: item.title,
                    href: item.href,
                    addedAt: Date.now()
                };
                changed = true;
            } else if (this.meta[item.id].title !== item.title) {
                // 标题已更新（用户可能在 DeepSeek 中重命名了对话）
                this.meta[item.id].title = item.title;
                this.meta[item.id].href = item.href;
                changed = true;
            }
        }
        if (changed) {
            DataManager.saveMeta(this.meta);
            log('元数据缓存已更新');
        }
    }

    // ============================================================
    // 渲染自定义列表
    // ============================================================

    /**
     * 渲染整个自定义分组列表
     *
     * 渲染流程：
     * 1. 扫描原始对话项获取最新数据
     * 2. 按分组归类对话
     * 3. 按分组顺序渲染各组
     * 4. 渲染"未分组"区域
     * 5. 应用搜索过滤
     *
     * 这是 UI 更新的核心方法，任何数据变更后都应调用此方法。
     */
    renderAll() {
        if (!this.listContainer) return;

        // 步骤 1: 扫描原始项获取最新数据（仅 DOM 中存在的）
        const allItems = this.scanOriginalItems();
        // 记录 DOM 中存在的 ID，用于后续识别"已归档"对话
        const domIds = new Set(allItems.map(item => item.id));

        // 步骤 1.5: 将 meta 中但不在 DOM 的"已归档"对话补充进来
        // DeepSeek 网页版限制显示前 ~200 条，但后台数据仍在。
        // 插件持续积累 meta，即使对话从 DOM 中消失也能显示。
        const archivedItems = [];
        for (const [convId, meta] of Object.entries(this.meta)) {
            if (!domIds.has(convId)) {
                archivedItems.push({
                    id: convId,
                    title: meta.title || '(已归档)',
                    href: meta.href || '#',
                    element: null,    // 无原始 DOM 元素
                    isActive: false,
                    isArchived: true  // 标记为已归档
                });
            }
        }
        // 将已归档对话合并到主列表（排在后面）
        const mergedItems = [...allItems, ...archivedItems];

        // 步骤 2: 构建 分组ID → 对话列表 的映射
        const groupedIds = new Set();
        const groupItemsMap = {}; // { groupId: [item, ...] }
        for (const group of this.groups) {
            groupItemsMap[group.id] = [];
        }

        for (const item of mergedItems) {
            const groupId = this.mapping[item.id] || null;
            if (groupId && groupItemsMap[groupId]) {
                groupItemsMap[groupId].push(item);
                groupedIds.add(item.id);
            }
        }

        // 步骤 3: 收集未分组的对话
        const ungroupedItems = mergedItems.filter(item => !groupedIds.has(item.id));

        // 步骤 4: 应用搜索过滤
        const filterItem = (item) => {
            if (!this.searchQuery) return true;
            const title = (item.title || '').toLowerCase();
            const id = (item.id || '').toLowerCase();
            return title.includes(this.searchQuery) || id.includes(this.searchQuery);
        };

        // 步骤 5: 清空容器
        this.listContainer.innerHTML = '';
        this.customItemMap.clear();

        // 步骤 6: 渲染"最近访问"（虚拟组，固定在顶部）
        this.renderRecentGroup(mergedItems, filterItem);

        // 步骤 7: 渲染各分组
        for (const group of this.groups) {
            const groupItems = (groupItemsMap[group.id] || [])
                .filter(filterItem);
            this.renderGroup(group, groupItems);
        }

        // 步骤 8: 渲染"未分组"区域
        const filteredUngrouped = ungroupedItems.filter(filterItem);
        this.renderUngroupedSection(filteredUngrouped);

        // 步骤 9: 如果没有内容，显示空状态
        if (this.listContainer.children.length === 0) {
            this.renderEmptyState();
        }

        log(`渲染完成: ${this.groups.length} 个分组, ` +
            `${allItems.length} 个对话, ${ungroupedItems.length} 个未分组`);
    }

    /**
     * 渲染单个分组
     *
     * 分组结构:
     * .gm-group-header  (折叠箭头 + 文件夹图标 + 分组名 + 数量 + 操作按钮)
     * .gm-group-body    (对话项列表，折叠时隐藏)
     *   .gm-conversation-item × N
     *
     * @param {Object} group - 分组对象 {id, name, collapsed, order}
     * @param {Array} items - 该分组下的对话项列表
     */
    renderGroup(group, items) {
        const groupBody = document.createElement('div');
        groupBody.className = 'gm-group-body';
        groupBody.setAttribute('data-group-id', group.id);

        // --- 分组头部 ---
        const header = document.createElement('div');
        header.className = 'gm-group-header';
        header.setAttribute('data-group-id', group.id);

        // 折叠/展开箭头
        const arrow = document.createElement('span');
        arrow.className = 'gm-group-arrow' + (group.collapsed ? '' : ' gm-expanded');
        arrow.textContent = '▶';

        // 文件夹图标
        const icon = document.createElement('span');
        icon.className = 'gm-group-icon';
        icon.textContent = group.collapsed ? '📁' : '📂';

        // 分组名称
        const nameSpan = document.createElement('span');
        nameSpan.className = 'gm-group-name';
        nameSpan.textContent = group.name;

        // 对话计数
        const count = document.createElement('span');
        count.className = 'gm-group-count';
        count.textContent = items.length.toString();

        // 操作按钮容器（悬浮显示）
        const actions = document.createElement('span');
        actions.className = 'gm-group-actions';

        // 添加对话到分组按钮
        const addBtn = document.createElement('button');
        addBtn.className = 'gm-btn-sm gm-btn-ghost';
        addBtn.textContent = '+';
        addBtn.title = '添加对话到此分组';
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // 阻止触发展开/折叠
            this.showAddConversationDialog(group);
        });
        actions.appendChild(addBtn);

        // 更多操作按钮（...菜单）
        const moreBtn = document.createElement('button');
        moreBtn.className = 'gm-btn-sm gm-btn-ghost';
        moreBtn.textContent = '⋮';
        moreBtn.title = '更多操作';
        moreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showGroupContextMenu(group, moreBtn);
        });
        actions.appendChild(moreBtn);

        // 组装头部
        header.appendChild(arrow);
        header.appendChild(icon);
        header.appendChild(nameSpan);
        header.appendChild(count);
        header.appendChild(actions);

        // 头部点击：折叠/展开
        header.addEventListener('click', () => {
            this.toggleGroupCollapse(group);
        });

        // 头部双击：重命名
        header.addEventListener('dblclick', (e) => {
            e.preventDefault();
            this.showRenameInput(header, group, nameSpan);
        });

        // 支持拖拽排序（将对话拖入分组）
        header.addEventListener('dragover', (e) => {
            e.preventDefault();
            header.classList.add('gm-drag-over');
        });
        header.addEventListener('dragleave', () => {
            header.classList.remove('gm-drag-over');
        });
        header.addEventListener('drop', (e) => {
            e.preventDefault();
            header.classList.remove('gm-drag-over');
            const convId = e.dataTransfer.getData('text/plain');
            if (convId && convId.startsWith('gm_conv_')) {
                const realConvId = convId.replace('gm_conv_', '');
                this.moveConversationToGroup(realConvId, group.id);
            }
        });

        this.listContainer.appendChild(header);

        // --- 分组展开时渲染对话项 ---
        if (!group.collapsed) {
            for (const item of items) {
                const convEl = this.createConversationItem(item);
                groupBody.appendChild(convEl);
            }
        }
        // 始终保持 groupBody 在 DOM 中（即使折叠），以支持拖入
        groupBody.style.display = group.collapsed ? 'none' : '';
        this.listContainer.appendChild(groupBody);
    }

    /**
     * 渲染"最近访问"虚拟分组
     *
     * 固定在列表顶部，显示最近访问过的 50 条对话，按访问时间倒序。
     * 这是一个视图而非真实分组——对话可以同时出现在这里和其所属分组中。
     * 不可删除、不可重命名、不接受拖入。
     *
     * @param {Array} allItems - 所有对话项
     * @param {Function} filterItem - 搜索过滤函数
     */
    renderRecentGroup(allItems, filterItem) {
        // 收集有 lastAccessedAt 的对话，按时间倒序，取前50
        const recentItems = allItems
            .filter(item => {
                const meta = this.meta[item.id];
                return meta && meta.lastAccessedAt;
            })
            .sort((a, b) => (this.meta[b.id].lastAccessedAt || 0) - (this.meta[a.id].lastAccessedAt || 0))
            .slice(0, 50)
            .filter(filterItem);

        if (recentItems.length === 0) return;

        const RECENT_GROUP_ID = '__gm_recent__';
        const collapsed = this._recentCollapsed || false;

        // --- 头部 ---
        const header = document.createElement('div');
        header.className = 'gm-group-header';
        header.setAttribute('data-group-id', RECENT_GROUP_ID);

        const arrow = document.createElement('span');
        arrow.className = 'gm-group-arrow' + (collapsed ? '' : ' gm-expanded');
        arrow.textContent = '▶';

        const icon = document.createElement('span');
        icon.className = 'gm-group-icon';
        icon.style.color = '#4f8cff'; // 蓝色时钟图标，区别于普通文件夹
        icon.textContent = '🕐';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'gm-group-name';
        nameSpan.textContent = '最近访问';

        const count = document.createElement('span');
        count.className = 'gm-group-count';
        count.textContent = String(Math.min(recentItems.length, 50));

        // 头部点击：折叠/展开
        header.appendChild(arrow);
        header.appendChild(icon);
        header.appendChild(nameSpan);
        header.appendChild(count);
        header.addEventListener('click', () => {
            this._recentCollapsed = !this._recentCollapsed;
            this.renderAll();
        });

        this.listContainer.appendChild(header);

        // --- 对话列表 ---
        const body = document.createElement('div');
        body.className = 'gm-group-body';
        body.setAttribute('data-group-id', RECENT_GROUP_ID);
        if (!collapsed) {
            for (const item of recentItems) {
                body.appendChild(this.createConversationItem(item));
            }
        }
        body.style.display = collapsed ? 'none' : '';
        this.listContainer.appendChild(body);
    }

    /**
     * 渲染"未分组"区域
     *
     * 类似分组，但不可删除、不可重命名。
     * 始终显示在最下方。
     *
     * @param {Array} items - 未分组的对话项列表
     */
    renderUngroupedSection(items) {
        if (items.length === 0 && this.searchQuery) return; // 搜索时不显示空区域

        // 分隔标题
        const header = document.createElement('div');
        header.className = 'gm-ungrouped-header';

        const arrow = document.createElement('span');
        arrow.className = 'gm-group-arrow gm-expanded'; // 默认展开
        arrow.textContent = '▶';

        const label = document.createElement('span');
        label.textContent = `未分组 (${items.length})`;

        header.appendChild(arrow);
        header.appendChild(label);

        let collapsed = false;
        header.addEventListener('click', () => {
            collapsed = !collapsed;
            arrow.classList.toggle('gm-expanded', !collapsed);
            body.style.display = collapsed ? 'none' : '';
        });

        this.listContainer.appendChild(header);

        // 对话列表
        const body = document.createElement('div');
        body.className = 'gm-group-body';
        for (const item of items) {
            body.appendChild(this.createConversationItem(item));
        }
        this.listContainer.appendChild(body);
    }

    /**
     * 创建对话项 DOM 元素（自定义列表中的对话条目）
     *
     * 每个对话项包含:
     * - 批量选择复选框
     * - 对话标题（可点击跳转）
     * - 悬浮显示的分组移动按钮
     *
     * 点击标题时，通过引用原始 DOM 元素来触发 DeepSeek 的导航逻辑，
     * 确保所有原生的点击行为（包括 React Router 导航）正常工作。
     *
     * @param {Object} item - {id, title, href, element, isActive}
     * @returns {HTMLElement}
     */
    createConversationItem(item) {
        const wrapper = document.createElement('div');
        wrapper.className = 'gm-conversation-item';
        if (item.isActive) wrapper.classList.add('gm-active');
        // 已归档（不在 DOM 中）的对话使用暗色样式
        if (item.isArchived) wrapper.classList.add('gm-archived');
        wrapper.setAttribute('data-conversation-id', item.id);
        // 已归档的不支持拖拽
        if (!item.isArchived) wrapper.draggable = true;

        // 批量选择复选框
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'gm-checkbox';
        checkbox.checked = this.selectedIds.has(item.id);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                this.selectedIds.add(item.id);
            } else {
                this.selectedIds.delete(item.id);
            }
            this.updateBatchLabel();
        });
        wrapper.appendChild(checkbox);

        // 对话标题
        const titleSpan = document.createElement('span');
        titleSpan.className = 'gm-conversation-title';
        titleSpan.textContent = item.title || '(无标题)';
        // hover 时显示插件首次收录该对话的时间（DeepSeek DOM 无时间字段）
        const meta = this.meta[item.id];
        if (meta && meta.addedAt) {
            const d = new Date(meta.addedAt);
            const pad = (n) => String(n).padStart(2, '0');
            titleSpan.title = '收录于 ' +
                `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
                `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
        // 点击标题 → 在原始 DOM 中找到对应元素并触发点击
        titleSpan.addEventListener('click', (e) => {
            if (this.batchMode) {
                // 批量模式：切换选择
                e.stopPropagation();
                checkbox.checked = !checkbox.checked;
                if (checkbox.checked) {
                    this.selectedIds.add(item.id);
                } else {
                    this.selectedIds.delete(item.id);
                }
                this.updateBatchLabel();
                return;
            }
            this.activateConversation(item);
        });
        wrapper.appendChild(titleSpan);

        // 分组移动按钮（悬浮显示）
        const moveBtn = document.createElement('button');
        moveBtn.className = 'gm-move-btn';
        moveBtn.textContent = '⋮';
        moveBtn.title = '移动到分组';
        moveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showMoveMenu([item.id], moveBtn, null);
        });
        wrapper.appendChild(moveBtn);

        // 拖拽事件
        wrapper.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', 'gm_conv_' + item.id);
            wrapper.classList.add('gm-dragging');
        });
        wrapper.addEventListener('dragend', () => {
            wrapper.classList.remove('gm-dragging');
        });

        // 右键菜单
        wrapper.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showConversationContextMenu(item, e.clientX, e.clientY);
        });

        // 注册自定义元素引用
        this.customItemMap.set(item.id, wrapper);

        return wrapper;
    }

    /**
     * 激活对话（模拟点击原始 DOM 元素）
     *
     * 关键设计：不自己构造 URL 或调用 router.push，
     * 而是找到原始 DOM 中的对应元素并触发其 click 事件。
     * 这样 DeepSeek 的所有原生逻辑（路由、状态更新等）都能正常运行。
     *
     * @param {Object} item - 对话项数据
     */
    activateConversation(item) {
        // 已归档对话：直接通过存储的 URL 导航
        if (item.isArchived) {
            if (item.href && item.href !== '#') {
                window.location.href = item.href;
            }
            return;
        }

        const originalEl = this.originalItemMap.get(item.id);
        if (originalEl) {
            // 方案 1: 直接点击原始元素
            originalEl.click();

            // 方案 2: 如果原始元素是 <a> 标签的父容器，找到 <a> 并点击
            const link = originalEl.tagName === 'A'
                ? originalEl
                : originalEl.querySelector('a');
            if (link && link !== originalEl) {
                link.click();
            }
        } else {
            // 回退方案: 直接导航
            log('未找到原始元素，使用回退导航: ' + item.href, 'warn');
            if (item.href && item.href !== '#') {
                window.location.href = item.href;
            }
        }

        // 更新高亮状态
        this.activeConversationId = item.id;
        this.updateActiveHighlight();

        // 记录最近访问时间
        if (this.meta[item.id]) {
            this.meta[item.id].lastAccessedAt = Date.now();
        } else {
            this.meta[item.id] = {
                title: item.title || '',
                href: item.href || '#',
                addedAt: Date.now(),
                lastAccessedAt: Date.now()
            };
        }
        DataManager.saveMeta(this.meta);
    }

    /**
     * 更新活跃对话的高亮
     * 在所有自定义项中移除 gm-active，然后添加到当前活跃项
     */
    updateActiveHighlight() {
        this.listContainer.querySelectorAll('.gm-conversation-item.gm-active')
            .forEach(el => el.classList.remove('gm-active'));
        if (this.activeConversationId) {
            const activeEl = this.customItemMap.get(this.activeConversationId);
            if (activeEl) {
                activeEl.classList.add('gm-active');
            }
        }
    }

    /**
     * 渲染空状态提示
     */
    renderEmptyState() {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'gm-empty-state';

        const iconSpan = document.createElement('span');
        iconSpan.className = 'gm-empty-state-icon';
        iconSpan.textContent = '📭';
        emptyDiv.appendChild(iconSpan);

        const textP = document.createElement('p');
        textP.textContent = this.searchQuery
            ? '没有匹配的对话'
            : '还没有对话\n点击"+ 新建分组"开始整理';
        emptyDiv.appendChild(textP);

        this.listContainer.appendChild(emptyDiv);
    }

    // ============================================================
    // 交互操作
    // ============================================================

    /**
     * 切换分组的折叠/展开状态
     * @param {Object} group
     */
    async toggleGroupCollapse(group) {
        const newCollapsed = !group.collapsed;
        this.groups = await DataManager.setGroupCollapsed(
            group.id, newCollapsed, this.groups
        );
        this.renderAll();
    }

    /**
     * 移动对话到指定分组
     * @param {string} convId - 对话 ID
     * @param {string} groupId - 目标分组 ID
     */
    async moveConversationToGroup(convId, groupId) {
        this.mapping = await DataManager.moveConversation(
            convId, groupId, this.mapping
        );
        log(`对话 ${convId} → 分组 ${groupId}`);
        this.renderAll();
    }

    /**
     * 批量移动对话
     * @param {string[]} convIds
     * @param {string|null} groupId
     */
    async batchMoveToGroup(convIds, groupId) {
        this.mapping = await DataManager.batchMoveConversations(
            convIds, groupId, this.mapping
        );
        log(`批量移动 ${convIds.length} 个对话 → 分组 ${groupId}`);
        this.toggleBatchMode(false);
        this.renderAll();
    }

    // ============================================================
    // 弹出菜单
    // ============================================================

    /**
     * 显示分组移动菜单
     *
     * 弹出菜单列出所有分组，用户选择一个后执行移动。
     * 包含"未分组"选项（将对话移回未分组）。
     *
     * @param {string[]} convIds - 要移动的对话 ID 列表
     * @param {HTMLElement} anchor - 菜单定位参考元素
     * @param {string|null} currentGroupId - 当前所在分组（用于排除）
     */
    showMoveMenu(convIds, anchor, currentGroupId) {
        this.closeAllPopups();

        const menu = document.createElement('div');
        menu.className = 'gm-popup-menu';

        // 填充分组选项
        for (const group of this.groups) {
            if (group.id === currentGroupId) continue; // 跳过已在的分组
            const menuItem = document.createElement('div');
            menuItem.className = 'gm-popup-menu-item';
            menuItem.textContent = '📁 ' + group.name;
            menuItem.addEventListener('click', () => {
                menu.remove();
                if (convIds.length === 1) {
                    this.moveConversationToGroup(convIds[0], group.id);
                } else {
                    this.batchMoveToGroup(convIds, group.id);
                }
            });
            menu.appendChild(menuItem);
        }

        // "未分组"选项
        if (currentGroupId !== null) {
            const ungroupItem = document.createElement('div');
            ungroupItem.className = 'gm-popup-menu-item';
            ungroupItem.textContent = '📋 移到未分组';
            ungroupItem.addEventListener('click', () => {
                menu.remove();
                if (convIds.length === 1) {
                    this.moveConversationToGroup(convIds[0], null);
                } else {
                    this.batchMoveToGroup(convIds, null);
                }
            });
            menu.appendChild(ungroupItem);
        }

        // 附加到 document.body（position:fixed 需要不被父容器 overflow 裁剪）
        this.positionPopup(menu, anchor);
        document.body.appendChild(menu);
        setTimeout(() => {
            document.addEventListener('click', function closeMenu(e) {
                if (!menu.contains(e.target)) {
                    menu.remove();
                    document.removeEventListener('click', closeMenu);
                }
            }, { once: true });
        }, 0);
    }

    /**
     * 显示分组上下文菜单（重命名、删除）
     * @param {Object} group
     * @param {HTMLElement} anchor
     */
    showGroupContextMenu(group, anchor) {
        this.closeAllPopups();

        const menu = document.createElement('div');
        menu.className = 'gm-popup-menu';

        // 重命名
        const renameItem = document.createElement('div');
        renameItem.className = 'gm-popup-menu-item';
        renameItem.textContent = '✏️ 重命名';
        renameItem.addEventListener('click', () => {
            menu.remove();
            const header = anchor.closest('.gm-group-header');
            const nameSpan = header.querySelector('.gm-group-name');
            this.showRenameInput(header, group, nameSpan);
        });
        menu.appendChild(renameItem);

        // 分隔线
        const sep = document.createElement('div');
        sep.className = 'gm-popup-menu-separator';
        menu.appendChild(sep);

        // 删除分组
        const deleteItem = document.createElement('div');
        deleteItem.className = 'gm-popup-menu-item gm-danger';
        deleteItem.textContent = '🗑 删除分组';
        deleteItem.addEventListener('click', () => {
            menu.remove();
            this.confirmDeleteGroup(group);
        });
        menu.appendChild(deleteItem);

        this.positionPopup(menu, anchor);
        document.body.appendChild(menu);
        setTimeout(() => {
            document.addEventListener('click', function closeMenu(e) {
                if (!menu.contains(e.target)) {
                    menu.remove();
                    document.removeEventListener('click', closeMenu);
                }
            }, { once: true });
        }, 0);
    }

    /**
     * 显示对话右键菜单
     * @param {Object} item - 对话项数据
     * @param {number} x - 鼠标 X 坐标
     * @param {number} y - 鼠标 Y 坐标
     */
    showConversationContextMenu(item, x, y) {
        this.closeAllPopups();

        const menu = document.createElement('div');
        menu.className = 'gm-popup-menu';
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        const currentGroupId = this.mapping[item.id] || null;

        // 移动选项
        for (const group of this.groups) {
            if (group.id === currentGroupId) continue;
            const menuItem = document.createElement('div');
            menuItem.className = 'gm-popup-menu-item';
            menuItem.textContent = '📁 ' + group.name;
            menuItem.addEventListener('click', () => {
                menu.remove();
                this.moveConversationToGroup(item.id, group.id);
            });
            menu.appendChild(menuItem);
        }

        if (currentGroupId !== null) {
            const ungroupItem = document.createElement('div');
            ungroupItem.className = 'gm-popup-menu-item';
            ungroupItem.textContent = '📋 移到未分组';
            ungroupItem.addEventListener('click', () => {
                menu.remove();
                this.moveConversationToGroup(item.id, null);
            });
            menu.appendChild(ungroupItem);
        }

        document.body.appendChild(menu);
        setTimeout(() => {
            document.addEventListener('click', function closeMenu(e) {
                if (!menu.contains(e.target)) {
                    menu.remove();
                    document.removeEventListener('click', closeMenu);
                }
            }, { once: true });
        }, 0);
    }

    /**
     * 定位弹出菜单（相对于锚点元素）
     * @param {HTMLElement} menu
     * @param {HTMLElement} anchor
     */
    positionPopup(menu, anchor) {
        const rect = anchor.getBoundingClientRect();
        // 优先在锚点下方显示
        let top = rect.bottom + 4;
        let left = rect.left;
        // 如果下方空间不足，显示在上方
        if (top + 200 > window.innerHeight) {
            top = rect.top - 200 - 4;
        }
        // 如果右侧空间不足，向左偏移
        if (left + 220 > window.innerWidth) {
            left = window.innerWidth - 230;
        }
        menu.style.position = 'fixed';
        menu.style.left = Math.max(4, left) + 'px';
        menu.style.top = Math.max(4, top) + 'px';
    }

    /**
     * 关闭所有弹出菜单
     */
    closeAllPopups() {
        document.querySelectorAll('.gm-popup-menu').forEach(el => el.remove());
    }

    // ============================================================
    // 对话框
    // ============================================================

    /**
     * 显示创建分组对话框
     */
    showCreateGroupDialog() {
        this.showModal(
            '新建分组',
            '请输入分组名称',
            '创建',
            async (name) => {
                const result = await DataManager.createGroup(name, this.groups);
                this.groups = result.groups;
                this.renderAll();
            }
        );
    }

    /**
     * 显示添加对话到分组对话框
     * 列出所有未分组的对话供选择
     * @param {Object} group - 目标分组
     */
    showAddConversationDialog(group) {
        // 获取未分组的对话
        const allItems = this.scanOriginalItems();
        const ungroupedItems = allItems.filter(
            item => !this.mapping[item.id]
        );

        if (ungroupedItems.length === 0) {
            alert('没有未分组的对话。');
            return;
        }

        // 构建选择列表
        const content = document.createElement('div');
        content.style.maxHeight = '300px';
        content.style.overflowY = 'auto';
        content.style.marginBottom = '12px';

        const selectedIds = new Set();
        for (const item of ungroupedItems) {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.padding = '4px 0';
            row.style.gap = '8px';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.addEventListener('change', () => {
                if (cb.checked) selectedIds.add(item.id);
                else selectedIds.delete(item.id);
            });
            row.appendChild(cb);

            const label = document.createElement('span');
            label.textContent = item.title;
            label.style.overflow = 'hidden';
            label.style.textOverflow = 'ellipsis';
            label.style.whiteSpace = 'nowrap';
            row.appendChild(label);

            content.appendChild(row);
        }

        this.showCustomModal(
            `添加对话到"${group.name}"`,
            content,
            '添加',
            async () => {
                if (selectedIds.size > 0) {
                    this.mapping = await DataManager.batchMoveConversations(
                        Array.from(selectedIds), group.id, this.mapping
                    );
                    this.renderAll();
                }
            }
        );
    }

    /**
     * 显示确认删除分组对话框
     * @param {Object} group
     */
    async confirmDeleteGroup(group) {
        const confirmed = confirm(
            `确定要删除分组"${group.name}"吗？\n\n` +
            `该分组下的对话将移回"未分组"。`
        );
        if (!confirmed) return;

        const result = await DataManager.deleteGroup(
            group.id, this.groups, this.mapping
        );
        this.groups = result.groups;
        this.mapping = result.mapping;
        this.renderAll();
    }

    /**
     * 内联重命名输入框
     * 直接在分组头部位置显示输入框
     * @param {HTMLElement} header - 分组头部元素
     * @param {Object} group - 分组数据
     * @param {HTMLElement} nameSpan - 分组名称 span
     */
    showRenameInput(header, group, nameSpan) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'gm-rename-input';
        input.value = group.name;
        input.setAttribute('data-gm-rename', 'true');

        // 用输入框替换名称 span
        nameSpan.replaceWith(input);
        input.focus();
        input.select();

        // 保存函数
        const save = async () => {
            const newName = input.value.trim();
            if (newName && newName !== group.name) {
                this.groups = await DataManager.renameGroup(
                    group.id, newName, this.groups
                );
                this.renderAll();
            } else {
                // 名称未变，恢复显示
                input.replaceWith(nameSpan);
            }
        };

        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur(); // 触发 blur → save
            } else if (e.key === 'Escape') {
                input.value = group.name; // 恢复原值
                input.blur();
            }
        });
    }

    /**
     * 显示通用模态框
     * @param {string} title - 标题
     * @param {string} placeholder - 输入框占位符
     * @param {string} btnText - 确认按钮文本
     * @param {Function} onConfirm - 确认回调，接收输入值
     */
    showModal(title, placeholder, btnText, onConfirm) {
        const overlay = document.createElement('div');
        overlay.className = 'gm-modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'gm-modal';

        const titleEl = document.createElement('div');
        titleEl.className = 'gm-modal-title';
        titleEl.textContent = title;
        modal.appendChild(titleEl);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'gm-modal-input';
        input.placeholder = placeholder;
        modal.appendChild(input);

        const actions = document.createElement('div');
        actions.className = 'gm-modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'gm-btn gm-btn-ghost';
        cancelBtn.textContent = '取消';
        cancelBtn.addEventListener('click', () => overlay.remove());
        actions.appendChild(cancelBtn);

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'gm-btn';
        confirmBtn.textContent = btnText;
        confirmBtn.addEventListener('click', () => {
            const value = input.value.trim();
            if (value) {
                overlay.remove();
                onConfirm(value);
            }
        });
        actions.appendChild(confirmBtn);

        modal.appendChild(actions);
        overlay.appendChild(modal);

        // 点击遮罩关闭
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        // ESC 关闭
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                overlay.remove();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

        document.body.appendChild(overlay);
        // 延迟聚焦：确保 DOM 渲染完成后聚焦，且不被 DeepSeek 逻辑抢走焦点
        requestAnimationFrame(() => {
            input.focus();
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                confirmBtn.click();
            }
            // 阻止事件冒泡到 DeepSeek 的键盘处理器
            e.stopPropagation();
        });
        // 阻止输入框上的键盘事件冒泡（防止 DeepSeek 快捷键拦截）
        input.addEventListener('keyup', (e) => e.stopPropagation());
        input.addEventListener('keypress', (e) => e.stopPropagation());
    }

    /**
     * 显示自定义内容模态框
     * @param {string} title
     * @param {HTMLElement} content - 自定义内容
     * @param {string} btnText
     * @param {Function} onConfirm
     */
    showCustomModal(title, content, btnText, onConfirm) {
        const overlay = document.createElement('div');
        overlay.className = 'gm-modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'gm-modal';

        const titleEl = document.createElement('div');
        titleEl.className = 'gm-modal-title';
        titleEl.textContent = title;
        modal.appendChild(titleEl);
        modal.appendChild(content);

        const actions = document.createElement('div');
        actions.className = 'gm-modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'gm-btn gm-btn-ghost';
        cancelBtn.textContent = '取消';
        cancelBtn.addEventListener('click', () => overlay.remove());
        actions.appendChild(cancelBtn);

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'gm-btn';
        confirmBtn.textContent = btnText;
        confirmBtn.addEventListener('click', () => {
            overlay.remove();
            onConfirm();
        });
        actions.appendChild(confirmBtn);

        modal.appendChild(actions);
        overlay.appendChild(modal);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                overlay.remove();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

        document.body.appendChild(overlay);
    }

    // ============================================================
    // 批量操作
    // ============================================================

    /**
     * 切换批量选择模式
     * @param {boolean} enabled
     */
    toggleBatchMode(enabled) {
        this.batchMode = enabled;
        if (!enabled) {
            this.selectedIds.clear();
        }
        // 切换 CSS 类来控制复选框和工具栏的显示
        this.root.classList.toggle('gm-batch-mode', enabled);
        this.updateBatchLabel();
        this.renderAll(); // 重新渲染以显示/隐藏复选框
    }

    /**
     * 更新批量选择标签
     */
    updateBatchLabel() {
        const label = document.getElementById('gm-batch-label');
        if (label) {
            label.textContent = `已选择 ${this.selectedIds.size} 项`;
        }
    }

    // ============================================================
    // 滚动加载处理
    // ============================================================

    /**
     * 处理列表滚动事件
     *
     * 当用户滚动到接近底部时，需要在原始列表中触发加载更多。
     * 我们的自定义列表滚动不直接触发 DeepSeek 的 IntersectionObserver，
     * 所以需要模拟原始列表的滚动来触发懒加载。
     */
    handleListScroll() {
        if (!this.listContainer || !this.originalContainer) return;

        const { scrollTop, scrollHeight, clientHeight } = this.listContainer;
        // 距离底部小于 100px 时触发加载
        if (scrollHeight - scrollTop - clientHeight < 100) {
            // 模拟原始列表滚动到底部
            if (this.originalContainer.scrollTo) {
                // 临时显示原始容器以触发滚动
                const wasHidden = this.originalContainer.style.display === 'none';
                if (wasHidden) {
                    this.originalContainer.style.display = '';
                    this.originalContainer.style.opacity = '0';
                    this.originalContainer.style.pointerEvents = 'none';
                }
                this.originalContainer.scrollTop = this.originalContainer.scrollHeight;
                // 延迟恢复隐藏
                setTimeout(() => {
                    if (wasHidden) {
                        this.originalContainer.style.display = 'none';
                        this.originalContainer.style.opacity = '';
                        this.originalContainer.style.pointerEvents = '';
                    }
                }, 300);
            }
        }
    }
}

// ============================================================
// ╔══════════════════════════════════════════════════════════╗
// ║        第五部分：MutationObserver（动态内容监听）         ║
// ╚══════════════════════════════════════════════════════════╝
// ============================================================

/**
 * ConversationWatcher — 监听原始列表的 DOM 变化
 *
 * DeepSeek 使用懒加载（滚动到底部时加载更多历史对话）。
 * 当新对话项被添加到原始列表时，此类捕获变化并触发 UI 刷新。
 *
 * 使用防抖机制避免频繁刷新（MutationObserver 可能批量触发）。
 */
class ConversationWatcher {
    /**
     * @param {UIManager} uiManager
     */
    constructor(uiManager) {
        this.ui = uiManager;
        this.observer = null;
        this.debouncedRefresh = debounce(() => {
            log('检测到新对话项，刷新列表...');
            this.ui.renderAll();
        }, 300);
    }

    /**
     * 开始监听原始对话列表容器的 DOM 变化
     */
    start() {
        // DeepSeek 使用虚拟列表，所有对话链接可能已经存在于 DOM 中
        // 但虚拟列表只显示可见部分。MutationObserver 在这里主要用于：
        // 1. 检测用户新建对话时新增的链接
        // 2. 检测对话标题更新（如重命名）
        //
        // 观察目标：侧边栏容器（比 originalContainer 更上层）
        // 因为虚拟列表的 ds-virtual-list-visible-items 会被整体替换
        const target = this.ui.originalSidebar || this.ui.originalContainer || document.body;
        if (!target) {
            log('无法启动监听: 无有效目标', 'warn');
            return;
        }

        this.observer = new MutationObserver((mutations) => {
            let hasNewConversationLinks = false;

            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    // 检查是否有新增的 <a> 标签（含 /a/chat/ 链接）
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const el = /** @type {HTMLElement} */ (node);
                            const selfMatch = el.tagName === 'A' &&
                                (el.getAttribute('href') || '').includes('/a/chat/');
                            const childMatch = el.querySelectorAll
                                ? el.querySelectorAll('a[href*="/a/chat/"]').length > 0
                                : false;
                            if (selfMatch || childMatch) {
                                hasNewConversationLinks = true;
                                break;
                            }
                        }
                    }
                }
                // 也检测属性变化（活跃状态切换可能导致 class 变化）
                if (mutation.type === 'attributes' &&
                    (mutation.attributeName === 'aria-current' ||
                     mutation.attributeName === 'class')) {
                    hasNewConversationLinks = true;
                }
                if (hasNewConversationLinks) break;
            }

            if (hasNewConversationLinks) {
                log('MutationObserver: 检测到对话列表变化，刷新...');
                this.debouncedRefresh();
            }
        });

        this.observer.observe(target, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-current', 'class']
        });

        log('MutationObserver 已启动，监听范围: ' +
            (target === this.ui.originalSidebar ? '侧边栏' :
             target === this.ui.originalContainer ? '对话列表容器' : 'document.body'));
    }

    /**
     * 停止监听
     */
    stop() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
    }
}

// ============================================================
// ╔══════════════════════════════════════════════════════════╗
// ║        第六部分：应用主控制器                              ║
// ╚══════════════════════════════════════════════════════════╝
// ============================================================

/**
 * App — 应用主控制器
 *
 * 负责：
 * 1. 初始化流程：检测选择器 → 加载数据 → 构建UI → 启动监听
 * 2. 处理消息（来自 popup / background）
 * 3. 主题检测与适配
 * 4. 全局错误处理
 */
class App {
    constructor() {
        this.ui = new UIManager();
        this.watcher = null;
        this.initRetryCount = 0;
        this.maxRetries = 20; // 最多重试 20 次（10 秒）
    }

    /**
     * 启动应用
     *
     * 初始化流程：
     * 1. 自动检测 DOM 选择器
     * 2. 从 storage 加载数据（分组、映射、设置）
     * 3. 注入 UI（隐藏原始列表 + 创建自定义列表）
     * 4. 渲染分组和对话
     * 5. 启动 MutationObserver
     * 6. 检测并适配主题
     */
    async start() {
        log('DeepSeek Chat Group Manager v1.0 启动中...');

        // 步骤 0: 注入全局 CSS 变量（模态框/弹出菜单在 body 上需要它们）
        injectGlobalStyles();

        // 步骤 1: 自动检测 DOM 选择器
        SELECTORS = autoDetectSelectors();
        log('选择器检测完成: ' + JSON.stringify(SELECTORS, null, 2));

        // 步骤 2: 从 storage 加载数据
        const data = await DataManager.loadAll();
        this.ui.groups = data.groups;
        this.ui.mapping = data.mapping;
        this.ui.meta = data.meta;

        // 更新调试模式
        DEBUG = data.settings.debugMode === true;
        log(`已加载: ${data.groups.length} 个分组, ` +
            `${Object.keys(data.mapping).length} 条映射`);

        // 检查是否已禁用
        if (data.settings.disabled === true) {
            log('插件已禁用，跳过初始化');
            return;
        }

        // 应用设置中的选择器覆盖
        if (data.settings.selectorOverrides && Object.keys(data.settings.selectorOverrides).length > 0) {
            SELECTORS = { ...SELECTORS, ...data.settings.selectorOverrides };
            log('已应用用户自定义选择器覆盖');
        }

        // 步骤 3: 初始化 UI（找到原始侧边栏并注入自定义 UI）
        const initSuccess = this.ui.init();
        if (!initSuccess) {
            // 页面可能还在加载中（React 尚未渲染完毕），重试
            if (this.initRetryCount < this.maxRetries) {
                this.initRetryCount++;
                log(`UI 初始化失败，500ms 后重试 (${this.initRetryCount}/${this.maxRetries})...`, 'warn');
                setTimeout(() => this.start(), 500);
                return;
            } else {
                log('达到最大重试次数，放弃初始化。请检查选择器配置。', 'error');
                return;
            }
        }

        // 步骤 4: 首次渲染
        this.ui.renderAll();

        // 步骤 5: 启动 MutationObserver 监听动态加载
        this.watcher = new ConversationWatcher(this.ui);
        this.watcher.start();

        // 步骤 6: 检测并适配主题
        this.detectTheme();

        // 步骤 7: 监听来自 popup 的消息
        this.setupMessageListener();

        // 步骤 8: 监听页面 URL 变化（用户点击对话后 URL 可能改变）
        this.setupUrlChangeListener();

        // 暴露调试接口到全局作用域
        this.exposeDebugAPI();

        log('DeepSeek Chat Group Manager 初始化完成!');
    }

    /**
     * 检测 DeepSeek 页面当前主题
     *
     * 通过检查 <html> 或 <body> 的 class/属性来判断主题。
     * 在 .gm-root 上添加对应的主题类。
     */
    detectTheme() {
        const html = document.documentElement;
        const isDark = html.classList.contains('dark')
                    || html.getAttribute('data-theme') === 'dark'
                    || document.body.classList.contains('dark')
                    || window.matchMedia('(prefers-color-scheme: dark)').matches;

        // 同步主题到 .gm-root 和 document.documentElement
        // document.documentElement 上的类供全局 CSS 变量选择器使用
        if (isDark) {
            this.ui.root.classList.remove('gm-theme-light');
            document.documentElement.classList.remove('gm-theme-light');
        } else {
            this.ui.root.classList.add('gm-theme-light');
            document.documentElement.classList.add('gm-theme-light');
        }

        // 监听主题变化
        const observer = new MutationObserver(() => this.detectTheme());
        observer.observe(html, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    }

    /**
     * 监听来自 popup 和 background 的消息
     */
    setupMessageListener() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            // 处理数据更新通知
            if (message.action === 'dataUpdated') {
                log('收到数据更新通知，重新加载...');
                this.reload();
                sendResponse({ success: true });
            }
            // 处理设置更新通知
            if (message.action === 'settingsUpdated') {
                DEBUG = message.settings.debugMode === true;
                log('调试模式: ' + (DEBUG ? '开启' : '关闭'));
                sendResponse({ success: true });
            }
            // 处理禁用/启用切换
            if (message.action === 'toggleDisabled') {
                if (message.disabled) {
                    // 禁用：显示原始侧边栏，隐藏自定义 UI
                    if (this.ui.root) this.ui.root.style.display = 'none';
                    this.ui.hideOriginalContainer(false);
                    log('插件已禁用');
                } else {
                    // 启用：隐藏原始侧边栏，显示自定义 UI
                    if (this.ui.root) this.ui.root.style.display = '';
                    this.ui.hideOriginalContainer(true);
                    this.ui.renderAll();
                    log('插件已启用');
                }
                sendResponse({ success: true });
            }
            return true;
        });
    }

    /**
     * 监听 URL 变化
     *
     * DeepSeek 使用 React Router，页面内导航不会触发页面刷新。
     * 当用户点击对话后，URL 变化时更新高亮状态。
     */
    setupUrlChangeListener() {
        let lastUrl = window.location.href;
        // 使用 MutationObserver 或定时检查 URL 变化
        // 更优雅的方式是拦截 history.pushState
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;
        const checkUrlChange = () => {
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                log('URL 变化: ' + lastUrl);
                // 延迟刷新，等待 React 更新活跃状态
                setTimeout(() => this.ui.renderAll(), 200);
            }
        };

        history.pushState = function (...args) {
            originalPushState.apply(this, args);
            checkUrlChange();
        };
        history.replaceState = function (...args) {
            originalReplaceState.apply(this, args);
            checkUrlChange();
        };
        window.addEventListener('popstate', checkUrlChange);
    }

    /**
     * 重新加载数据和 UI
     */
    async reload() {
        const data = await DataManager.loadAll();
        this.ui.groups = data.groups;
        this.ui.mapping = data.mapping;
        this.ui.meta = data.meta;
        this.ui.renderAll();
    }

    /**
     * 暴露调试 API 到全局作用域
     *
     * 在浏览器控制台可用的调试方法：
     * - __GM__.debugSelectors()    输出当前选择器和匹配情况
     * - __GM__.getState()          获取当前内部状态
     * - __GM__.resetAll()          重置所有数据
     * - __GM__.showOriginal()      显示原始对话列表
     * - __GM__.hideOriginal()      隐藏原始对话列表
     */
    exposeDebugAPI() {
        const self = this;
        window.__GM__ = {
            /**
             * 调试选择器：输出每组选择器的候选和匹配数量
             * 用于查找网站更新后的新选择器
             */
            debugSelectors() {
                console.group('🔍 DeepSeek Group Manager - 选择器调试');
                // 额外：输出 DeepSeek 当前 DOM 结构概览
                const chatLinks = document.querySelectorAll('a[href*="/a/chat/"]');
                console.log(`对话链接总数: ${chatLinks.length}`);
                if (chatLinks.length > 0) {
                    const first = chatLinks[0];
                    console.log('首个对话链接结构:', first.outerHTML.slice(0, 400));
                    console.log('ID提取测试:', extractConversationId(first));
                    console.log('标题提取测试:', extractConversationTitle(first));
                }
                console.log('ds-scroll-area 数量:', document.querySelectorAll('[class*="ds-scroll-area"]').length);
                console.log('ds-virtual-list 数量:', document.querySelectorAll('[class*="ds-virtual-list"]').length);

                for (const [key, candidates] of Object.entries(SELECTOR_CANDIDATES)) {
                    if (key.startsWith('_')) continue; // 跳过内部引用
                    console.group(`${key} (当前使用: "${SELECTORS[key]}")`);
                    for (const sel of candidates) {
                        try {
                            const count = document.querySelectorAll(sel).length;
                            const marker = sel === SELECTORS[key] ? ' ✅ (使用中)' : '';
                            console.log(`  ${count} 个 - "${sel}"${marker}`);
                        } catch (e) {
                            console.log(`  ❌ 无效 - "${sel}"`);
                        }
                    }
                    console.groupEnd();
                }
                console.groupEnd();
            },

            /**
             * 获取当前内部状态
             */
            getState() {
                console.log('Groups:', JSON.parse(JSON.stringify(self.ui.groups)));
                console.log('Mapping:', JSON.parse(JSON.stringify(self.ui.mapping)));
                console.log('Meta keys:', Object.keys(self.ui.meta).length);
                console.log('Original items:', self.ui.originalItemMap.size);
                console.log('Custom items:', self.ui.customItemMap.size);
                console.log('Active conversation:', self.ui.activeConversationId);
            },

            /**
             * 重置所有数据
             */
            resetAll() {
                if (confirm('确定要清除所有分组数据吗？')) {
                    chrome.storage.local.set({
                        groups: [],
                        conversationGroupMap: {},
                        conversationMeta: {}
                    }, () => {
                        self.reload();
                        console.log('已清除所有数据。');
                    });
                }
            },

            /**
             * 临时显示原始对话列表
             */
            showOriginal() {
                self.ui.hideOriginalContainer(false);
                console.log('原始列表已显示（可能被自定义列表遮挡）');
            },

            /**
             * 重新隐藏原始对话列表
             */
            hideOriginal() {
                self.ui.hideOriginalContainer(true);
                console.log('原始列表已隐藏');
            }
        };
        console.log(
            '%c[GroupManager] 调试接口已就绪。在控制台输入 __GM__ 查看可用方法。',
            'color: #4f8cff;'
        );
    }
}

// ============================================================
// ╔══════════════════════════════════════════════════════════╗
// ║   第6.5部分：全局 CSS 变量注入                             ║
// ╚══════════════════════════════════════════════════════════╝
// ============================================================

/**
 * 将 CSS 自定义属性注入到 document.head
 *
 * 为什么需要这个？
 * 模态框和弹出菜单被附加到 document.body（因为 position:fixed 若放在
 * .gm-root 内部会被其 overflow:hidden 裁剪）。但 CSS 变量定义在 .gm-root
 * 选择器下，body 上的这些元素访问不到。
 *
 * 解决方案：在页面 <head> 中注入一份全局 CSS 变量副本。
 * 这样无论元素在 DOM 中挂在哪里，都能使用 var(--gm-*)。
 */
function injectGlobalStyles() {
    // 避免重复注入
    if (document.getElementById('gm-global-styles')) return;

    const style = document.createElement('style');
    style.id = 'gm-global-styles';
    style.textContent = `
        /* DeepSeek Chat Group Manager — 全局 CSS 变量（暗色主题默认） */
        :root {
            --gm-bg-primary: #1a1a2e;
            --gm-bg-secondary: #16213e;
            --gm-bg-hover: #1f2b47;
            --gm-bg-active: #253553;
            --gm-bg-input: #0f0f23;
            --gm-border: #2a2a4a;
            --gm-border-light: #333358;
            --gm-text-primary: #e0e0ec;
            --gm-text-secondary: #9898b8;
            --gm-text-muted: #6a6a8a;
            --gm-accent: #4f8cff;
            --gm-accent-hover: #6ba0ff;
            --gm-accent-subtle: rgba(79, 140, 255, 0.12);
            --gm-folder-color: #e8b850;
            --gm-folder-open: #f0c860;
            --gm-btn-add: #2d8a4e;
            --gm-btn-add-hover: #35a35a;
            --gm-btn-danger: #c0392b;
            --gm-btn-danger-hover: #e74c3c;
            --gm-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            --gm-radius: 6px;
            --gm-radius-sm: 4px;
            --gm-transition: 150ms ease;
            --gm-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            --gm-font-size: 12px;
            --gm-font-size-sm: 10px;
            --gm-font-size-lg: 13px;
        }
        /* 浅色主题覆盖（由 detectTheme() 在 <html> 上切换 gm-theme-light 类） */
        :root.gm-theme-light {
            --gm-bg-primary: #ffffff;
            --gm-bg-secondary: #f8f9fa;
            --gm-bg-hover: #f0f1f3;
            --gm-bg-active: #e8eaed;
            --gm-bg-input: #f0f1f3;
            --gm-border: #e0e2e6;
            --gm-border-light: #d0d2d6;
            --gm-text-primary: #1a1a2e;
            --gm-text-secondary: #5a5a7a;
            --gm-text-muted: #8a8aaa;
            --gm-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            --gm-accent-subtle: rgba(79, 140, 255, 0.08);
        }
    `;
    document.head.appendChild(style);
    log('全局 CSS 变量已注入');
}

// ============================================================
// ╔══════════════════════════════════════════════════════════╗
// ║        第七部分：入口点                                    ║
// ╚══════════════════════════════════════════════════════════╝
// ============================================================

/**
 * 启动时机判断
 *
 * 如果 DeepSeek 页面的关键 DOM 尚未渲染完成（页面可能在加载中），
 * 短暂延迟后再启动。通常 document_idle 已经足够。
 */
function bootstrap() {
    const app = new App();

    // 快速检查：页面上是否存在 DeepSeek 对话链接
    const hasConversationLinks = document.querySelectorAll('a[href*="/a/chat/"]').length > 0
                              || document.querySelectorAll('a[href*="/chat/"]').length > 0;
    // 检查是否有 ds-scroll-area（DeepSeek 设计系统组件）
    const hasScrollArea = document.querySelectorAll('[class*="ds-scroll-area"]').length > 0;

    if (hasConversationLinks || hasScrollArea) {
        app.start();
    } else {
        log('DeepSeek 对话列表尚未渲染，等待页面加载...');
        // 延迟启动，等待 React 渲染
        setTimeout(() => app.start(), 1000);
    }
}

// 页面加载完成后启动
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
