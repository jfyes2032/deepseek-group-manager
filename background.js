/**
 * background.js - DeepSeek Chat Group Manager
 * Service Worker (Manifest V3)
 *
 * 职责：
 * 1. 处理扩展安装/更新事件，初始化默认配置
 * 2. 作为 content script 和 popup 之间的消息中转（如果需要）
 * 3. 管理 chrome.storage 的数据结构升级/迁移
 *
 * 注意：Manifest V3 的 service worker 不会持久运行，
 * 所有状态通过 chrome.storage 持久化。
 */

// ============================================================
// 扩展安装 / 更新时的初始化
// ============================================================
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        // 首次安装：写入默认存储结构
        chrome.storage.local.set({
            groups: [],                          // {id, name, order, collapsed}
            conversationGroupMap: {},            // {conversationId: groupId}
            conversationMeta: {},                // {conversationId: {title, href, addedAt}}
            settings: {
                debugMode: false,                // 调试模式：在控制台输出详细日志
                selectorOverrides: {},           // 用户自定义 DOM 选择器（为空则自动检测）
                theme: 'auto'                    // 'auto' | 'dark' | 'light'
            },
            dataVersion: 1                       // 数据结构版本号，用于未来迁移
        }, () => {
            console.log('[GroupManager] 扩展已安装，默认配置已初始化。');
        });
    } else if (details.reason === 'update') {
        // 版本更新时进行数据迁移检查
        checkAndMigrateData();
    }
});

/**
 * 数据迁移检查
 * 当 dataVersion 升级时，在此添加迁移逻辑
 */
function checkAndMigrateData() {
    chrome.storage.local.get(['dataVersion'], (result) => {
        const version = result.dataVersion || 0;
        if (version < 1) {
            // 将来版本 0 -> 1 的迁移逻辑写在这里
            console.log('[GroupManager] 数据迁移完成: v' + version + ' -> v1');
            chrome.storage.local.set({ dataVersion: 1 });
        }
    });
}

/**
 * 监听来自 content script 或 popup 的消息
 * 当前主要用于数据中转和调试
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 处理获取存储数据的请求（popup 使用）
    if (message.action === 'getStorageData') {
        chrome.storage.local.get(null, (data) => {
            sendResponse({ success: true, data });
        });
        return true; // 保持消息通道开启（异步 sendResponse）
    }

    // 处理批量更新存储数据的请求（popup 导入数据）
    if (message.action === 'setStorageData') {
        chrome.storage.local.set(message.data, () => {
            sendResponse({ success: true });
        });
        return true;
    }

    // 处理清除所有数据的请求
    if (message.action === 'clearAllData') {
        chrome.storage.local.clear(() => {
            sendResponse({ success: true });
        });
        return true;
    }
});
