/**
 * popup.js - DeepSeek Chat Group Manager
 *
 * 扩展弹出窗口的逻辑：
 * 1. 展示分组统计信息
 * 2. 提供调试模式开关
 * 3. 支持导出/导入分组数据（备份与恢复）
 * 4. 清除所有分组数据
 *
 * 数据流：
 * popup → chrome.runtime.sendMessage → background.js → chrome.storage
 * 或直接 chrome.storage.local 读写（popup 有 storage 权限）
 */

// ============================================================
// DOM 元素引用
// ============================================================
const statGroups = document.getElementById('statGroups');
const statMapped = document.getElementById('statMapped');
const toggleDebug = document.getElementById('toggleDebug');
const toggleDisabled = document.getElementById('toggleDisabled');
const btnExport = document.getElementById('btnExport');
const btnImport = document.getElementById('btnImport');
const importFileInput = document.getElementById('importFileInput');
const btnClearAll = document.getElementById('btnClearAll');
const toastContainer = document.getElementById('toastContainer');

// ============================================================
// Toast 通知工具函数
// ============================================================
/**
 * 显示一个短暂的提示消息
 * @param {string} msg - 消息文本
 * @param {'success'|'error'} type - 类型（影响颜色）
 * @param {number} duration - 显示时长（毫秒）
 */
function showToast(msg, type = 'success', duration = 2000) {
    const toast = document.createElement('div');
    toast.className = 'toast' + (type === 'error' ? ' error' : '');
    toast.textContent = msg;
    toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.remove();
    }, duration);
}

// ============================================================
// 加载并显示统计数据
// ============================================================
function loadStats() {
    chrome.storage.local.get(['groups', 'conversationGroupMap', 'settings'], (result) => {
        const groups = result.groups || [];
        const mapping = result.conversationGroupMap || {};
        const settings = result.settings || {};

        // 更新统计数字
        statGroups.textContent = groups.length;
        statMapped.textContent = Object.keys(mapping).length;

        // 更新调试开关状态
        toggleDebug.checked = settings.debugMode === true;
        // 更新禁用开关状态
        toggleDisabled.checked = settings.disabled === true;
    });
}

// ============================================================
// 调试模式开关
// ============================================================
toggleDebug.addEventListener('change', () => {
    chrome.storage.local.get(['settings'], (result) => {
        const settings = result.settings || {};
        settings.debugMode = toggleDebug.checked;
        chrome.storage.local.set({ settings }, () => {
            // 通知当前活动的 DeepSeek 标签页刷新设置
            notifyContentScripts({ action: 'settingsUpdated', settings });
            showToast(toggleDebug.checked ? '调试模式已开启' : '调试模式已关闭');
        });
    });
});

// ============================================================
// 禁用/启用插件开关
// ============================================================
toggleDisabled.addEventListener('change', () => {
    chrome.storage.local.get(['settings'], (result) => {
        const settings = result.settings || {};
        settings.disabled = toggleDisabled.checked;
        chrome.storage.local.set({ settings }, () => {
            notifyContentScripts({ action: 'toggleDisabled', disabled: settings.disabled });
            showToast(settings.disabled ? '插件已禁用，请刷新 DeepSeek 页面' : '插件已启用，请刷新 DeepSeek 页面');
        });
    });
});

/**
 * 向所有 DeepSeek 标签页的 content script 发送消息
 * @param {object} message - 要发送的消息
 */
function notifyContentScripts(message) {
    chrome.tabs.query({ url: 'https://chat.deepseek.com/*' }, (tabs) => {
        tabs.forEach((tab) => {
            chrome.tabs.sendMessage(tab.id, message).catch(() => {
                // content script 可能未加载，忽略错误
            });
        });
    });
}

// ============================================================
// 导出数据
// ============================================================
btnExport.addEventListener('click', () => {
    chrome.storage.local.get(['groups', 'conversationGroupMap', 'conversationMeta', 'settings'], (result) => {
        // 构造导出数据，包含版本号便于迁移
        const exportData = {
            exportVersion: 1,
            exportedAt: new Date().toISOString(),
            groups: result.groups || [],
            conversationGroupMap: result.conversationGroupMap || {},
            conversationMeta: result.conversationMeta || {},
            // 不导出 settings.debugMode（那是个人偏好）
            settings: {
                theme: (result.settings || {}).theme || 'auto'
            }
        };

        // 创建 Blob 并触发下载
        const blob = new Blob(
            [JSON.stringify(exportData, null, 2)],
            { type: 'application/json' }
        );
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `deepseek-groups-backup-${timestamp}.json`;

        // 使用 chrome.downloads（需要 downloads 权限）或创建隐藏链接下载
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);

        showToast(`数据已导出: ${filename}`);
    });
});

// ============================================================
// 导入数据
// ============================================================
btnImport.addEventListener('click', () => {
    importFileInput.click();
});

importFileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const importData = JSON.parse(e.target.result);

            // 基本验证
            if (!importData.groups || !importData.conversationGroupMap) {
                throw new Error('无效的备份文件格式');
            }

            // 合并策略：用导入数据覆盖现有数据
            // 用户也可以选择合并（保留现有数据，只添加导入中不存在的新数据）
            const mergeData = confirm(
                '点击"确定"将完全替换现有分组数据。\n' +
                '点击"取消"将合并数据（保留现有分组，仅添加新内容）。'
            );

            if (mergeData) {
                // 完全替换
                chrome.storage.local.set({
                    groups: importData.groups,
                    conversationGroupMap: importData.conversationGroupMap,
                    conversationMeta: importData.conversationMeta || {}
                }, () => {
                    showToast('数据已完全替换，请刷新 DeepSeek 页面查看效果。');
                    loadStats();
                    notifyContentScripts({ action: 'dataUpdated' });
                });
            } else {
                // 合并模式：保留现有分组，只添加导入中的新分组和新映射
                chrome.storage.local.get(['groups', 'conversationGroupMap', 'conversationMeta'], (current) => {
                    const currentGroups = current.groups || [];
                    const currentMap = current.conversationGroupMap || {};
                    const currentMeta = current.conversationMeta || {};

                    // 合并分组（按 id 去重，保留现有分组）
                    const existingIds = new Set(currentGroups.map(g => g.id));
                    const newGroups = importData.groups.filter(g => !existingIds.has(g.id));
                    const mergedGroups = [...currentGroups, ...newGroups];

                    // 合并映射（保留现有映射，仅添加不存在的键）
                    const mergedMap = { ...importData.conversationGroupMap, ...currentMap };

                    // 合并元数据
                    const mergedMeta = { ...importData.conversationMeta, ...currentMeta };

                    chrome.storage.local.set({
                        groups: mergedGroups,
                        conversationGroupMap: mergedMap,
                        conversationMeta: mergedMeta
                    }, () => {
                        showToast(
                            `合并完成：新增 ${newGroups.length} 个分组，` +
                            `新增 ${Object.keys(importData.conversationGroupMap).length} 条映射。`
                        );
                        loadStats();
                        notifyContentScripts({ action: 'dataUpdated' });
                    });
                });
            }
        } catch (err) {
            showToast('导入失败: ' + err.message, 'error', 3000);
        }
    };
    reader.readAsText(file);
    // 重置文件输入，允许重复导入同一文件
    importFileInput.value = '';
});

// ============================================================
// 清除所有数据
// ============================================================
btnClearAll.addEventListener('click', () => {
    if (confirm('确定要清除所有分组数据吗？此操作不可撤销！\n\n建议先点击"导出数据"进行备份。')) {
        // 二次确认
        if (confirm('再次确认：清除所有分组和对话分组映射？')) {
            chrome.storage.local.set({
                groups: [],
                conversationGroupMap: {},
                conversationMeta: {}
            }, () => {
                showToast('所有分组数据已清除，请刷新 DeepSeek 页面。');
                loadStats();
                notifyContentScripts({ action: 'dataUpdated' });
            });
        }
    }
});

// ============================================================
// 初始化：加载统计信息
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    loadStats();
});

// 每次 popup 打开时重新加载（popup 关闭后 JS 状态丢失）
loadStats();
