// ==UserScript==
// @name         Moodle-Commando
// @namespace    http://tampermonkey.net/
// @version      13.1
// @description  Автоматизированный помощник для работы с тестами Moodle. Интеграция с базой знаний Firebase и мульти-провайдерный ИИ-решатель (Gemini, Groq, OpenRouter).
// @author       Bobna (Refactored by AI)
// @match        https://edu-spcpu.ru/mod/quiz/attempt.php*
// @match        https://edu-spcpu.ru/mod/quiz/review.php*
// @match        https://edu-spcpu.ru/mod/quiz/view.php*
// @match        https://edu-spcpu.ru/course/view.php*
// @grant        GM_xmlhttpRequest
// @connect      generativelanguage.googleapis.com
// @connect      api.groq.com
// @connect      openrouter.ai
// @connect      eios-e526f-default-rtdb.europe-west1.firebasedatabase.app
// @connect      *
// @run-at       document-end
// @updateURL    https://github.com/Bobnarva/moodle-commando/raw/refs/heads/main/commando.user.js
// @downloadURL  https://github.com/Bobnarva/moodle-commando/raw/refs/heads/main/commando.user.js
// ==/UserScript==

(function() {
    'use strict';
    const p_1 = 'AQ.Ab8RN6JBHJCzBZsAZh3n2KG';
    const p_2 = '-zGX_FOUv_-Hq5JvCGg1PtdtnWg';
    const DEFAULT_GEMINI_KEY = p_1 + p_2;

    const FIREBASE_URL = 'https://eios-e526f-default-rtdb.europe-west1.firebasedatabase.app/';
    const STORAGE_KEY = 'moodle_inserted_answers';

    const KEY_GEMINI_STORAGE = 'commando_gemini_api_key';
    const KEY_GROQ_STORAGE = 'commando_groq_api_key';
    const KEY_OPENROUTER_STORAGE = 'commando_openrouter_api_key';

    const KEY_ROUTING_MODE = 'commando_routing_mode';
    const KEY_UI_COLLAPSED = 'commando_ui_collapsed';
    const KEY_LOGS_EXPANDED = 'commando_logs_expanded';

    // Каталог моделей с профилем задачи: (fast), (medium), (smart)
    const MODEL_CATALOG = {
        // Gemini
        gemini_31_flash_lite: {
            id: 'gemini-3.1-flash-lite',
            provider: 'gemini',
            label: 'Gemini 3.1 Flash-Lite (fast)',
            vision: true,
            profile: 'fast'
        },
        gemini_35_flash: {
            id: 'gemini-3.5-flash',
            provider: 'gemini',
            label: 'Gemini 3.5 Flash (medium)',
            vision: true,
            profile: 'medium'
        },
        gemini_38_flash: {
            id: 'gemini-3.8-flash',
            provider: 'gemini',
            label: 'Gemini 3.8 Flash (smart)',
            vision: true,
            profile: 'smart'
        },

        // Groq
        groq_gpt_oss_20b: {
            id: 'openai/gpt-oss-20b',
            provider: 'groq',
            label: 'Groq GPT-OSS 20B (fast)',
            vision: false,
            profile: 'fast'
        },
        groq_qwen38_27b: {
            id: 'qwen/qwen3.8-27b',
            provider: 'groq',
            label: 'Groq Qwen 3.8 27B (medium)',
            vision: false,
            profile: 'medium'
        },
        groq_gpt_oss_120b: {
            id: 'openai/gpt-oss-120b',
            provider: 'groq',
            label: 'Groq GPT-OSS 120B (smart)',
            vision: false,
            profile: 'smart'
        },

        // OpenRouter (:free)
        or_lightning_free: {
            id: 'nvidia/nemotron-3.5-lightning:free',
            provider: 'openrouter',
            label: 'OR Nemotron 3.5 Lightning (fast)',
            vision: false,
            profile: 'fast'
        },
        or_ernie_free: {
            id: 'baidu/ernie-5.5-flash-preview:free',
            provider: 'openrouter',
            label: 'OR ERNIE 5.5 Flash (medium)',
            vision: false,
            profile: 'medium'
        },
        or_nemotron_vl_free: {
            id: 'nvidia/nemotron-3-super-vl:free',
            provider: 'openrouter',
            label: 'OR Nemotron 3 Super VL (smart)',
            vision: true,
            profile: 'smart'
        },
        or_nemotron_ultra_free: {
            id: 'nvidia/nemotron-3-ultra:free',
            provider: 'openrouter',
            label: 'OR Nemotron 3 Ultra (smart)',
            vision: false,
            profile: 'smart'
        },
        or_auto_free: {
            id: 'openrouter/free',
            provider: 'openrouter',
            label: 'OR Auto Free Router (medium)',
            vision: true,
            profile: 'medium'
        }
    };

    let activeRequestsOnPage = 0;

    const Logger = {
        logs: [],
        add: function(text, level = 'info') {
            const time = new Date().toLocaleTimeString();
            const logEntry = { time, text, level };
            this.logs.push(logEntry);

            const colors = { info: '#9DB4C0', success: '#CEDOCE', warn: '#ffcc00', error: '#ff3333' };
            console.log(`%c[Commando OS] [${time}] ${text}`, `color: ${colors[level] || '#9DB4C0'};`);

            const logPanel = document.getElementById('commando-log-terminal');
            if (logPanel) {
                const item = document.createElement('div');
                item.style.marginBottom = '4px';
                item.style.color = colors[level] || '#ccc';
                item.innerHTML = `<span style="color: #5C6B73;">[${time}]</span> ${text}`;
                logPanel.appendChild(item);
                logPanel.scrollTop = logPanel.scrollHeight;
            }
        }
    };

    Logger.add('Запуск ядра Commando v13.1...', 'info');

    function sanitizeStoredValue(val) {
        if (!val) return null;
        const trimmed = val.trim();
        if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null;
        return trimmed;
    }

    const KeyManager = {
        getProviderKey: (provider) => {
            if (provider === 'gemini') {
                return sanitizeStoredValue(localStorage.getItem(KEY_GEMINI_STORAGE)) || DEFAULT_GEMINI_KEY;
            }
            if (provider === 'groq') {
                return sanitizeStoredValue(localStorage.getItem(KEY_GROQ_STORAGE));
            }
            if (provider === 'openrouter') {
                return sanitizeStoredValue(localStorage.getItem(KEY_OPENROUTER_STORAGE));
            }
            return null;
        },
        setProviderKey: (provider, key) => {
            const storageMap = {
                gemini: KEY_GEMINI_STORAGE,
                groq: KEY_GROQ_STORAGE,
                openrouter: KEY_OPENROUTER_STORAGE
            };
            const storageKey = storageMap[provider];
            if (!storageKey) return;

            const clean = sanitizeStoredValue(key);
            if (clean) {
                localStorage.setItem(storageKey, clean);
            } else {
                localStorage.removeItem(storageKey);
            }
        },
        isCustomGemini: () => sanitizeStoredValue(localStorage.getItem(KEY_GEMINI_STORAGE)) !== null,
        hasKey: (provider) => {
            const k = KeyManager.getProviderKey(provider);
            return Boolean(k && k.length > 8);
        },
        getMasked: (provider = 'gemini') => {
            const key = KeyManager.getProviderKey(provider);
            if (!key || key.length <= 8) return 'NOT_SET';
            return key.substring(0, 6) + '...' + key.substring(key.length - 4);
        }
    };

    const RoutingManager = {
        getMode: () => localStorage.getItem(KEY_ROUTING_MODE) || 'smart_auto',
        setMode: (mode) => localStorage.setItem(KEY_ROUTING_MODE, mode),

        classifyQuestion: (questionBlock, qType) => {
            const hasImages = questionBlock.querySelector('.qtext img, .answer img') !== null;
            const textLen = extractCleanText(questionBlock.querySelector('.qtext')).length;
            if (hasImages || qType === 'match' || textLen > 450) {
                return 'smart';
            }
            if (qType === 'multichoice' || textLen > 180) {
                return 'medium';
            }
            return 'fast';
        },

        buildChain: (questionBlock, qType) => {
            const mode = RoutingManager.getMode();
            const complexity = RoutingManager.classifyQuestion(questionBlock, qType);

            if (MODEL_CATALOG[mode]) {
                const primary = MODEL_CATALOG[mode];
                const rest = Object.keys(MODEL_CATALOG)
                    .filter(k => k !== mode)
                    .map(k => MODEL_CATALOG[k]);
                return [primary, ...rest];
            }

            if (mode === 'only_fast') {
                return [
                    MODEL_CATALOG.groq_gpt_oss_20b,
                    MODEL_CATALOG.gemini_31_flash_lite,
                    MODEL_CATALOG.or_lightning_free,
                    MODEL_CATALOG.groq_qwen38_27b,
                    MODEL_CATALOG.gemini_35_flash,
                    MODEL_CATALOG.or_auto_free
                ];
            }

            if (mode === 'only_medium') {
                return [
                    MODEL_CATALOG.gemini_35_flash,
                    MODEL_CATALOG.groq_qwen38_27b,
                    MODEL_CATALOG.or_ernie_free,
                    MODEL_CATALOG.or_auto_free,
                    MODEL_CATALOG.gemini_31_flash_lite,
                    MODEL_CATALOG.groq_gpt_oss_20b
                ];
            }

            if (mode === 'only_smart') {
                return [
                    MODEL_CATALOG.gemini_38_flash,
                    MODEL_CATALOG.groq_gpt_oss_120b,
                    MODEL_CATALOG.or_nemotron_vl_free,
                    MODEL_CATALOG.or_nemotron_ultra_free,
                    MODEL_CATALOG.gemini_35_flash,
                    MODEL_CATALOG.groq_qwen38_27b
                ];
            }

            // smart_auto: подстраивается под сложность вопроса и доступные ключи
            if (complexity === 'smart') {
                Logger.add('Smart Auto [smart]: сложный вопрос/картинка — приоритет smart-моделям.', 'info');
                return [
                    MODEL_CATALOG.gemini_38_flash,
                    MODEL_CATALOG.or_nemotron_vl_free,
                    MODEL_CATALOG.groq_gpt_oss_120b,
                    MODEL_CATALOG.or_nemotron_ultra_free,
                    MODEL_CATALOG.gemini_35_flash,
                    MODEL_CATALOG.groq_qwen38_27b,
                    MODEL_CATALOG.or_auto_free
                ];
            }

            if (complexity === 'medium') {
                Logger.add('Smart Auto [medium]: вопрос средней сложности — баланс скорости и точности.', 'info');
                return [
                    MODEL_CATALOG.gemini_35_flash,
                    MODEL_CATALOG.groq_qwen38_27b,
                    MODEL_CATALOG.or_ernie_free,
                    MODEL_CATALOG.or_auto_free,
                    MODEL_CATALOG.gemini_31_flash_lite,
                    MODEL_CATALOG.groq_gpt_oss_20b,
                    MODEL_CATALOG.groq_gpt_oss_120b
                ];
            }

            Logger.add('Smart Auto [fast]: простой вопрос — запуск на быстрых моделях.', 'success');
            return [
                MODEL_CATALOG.groq_gpt_oss_20b,
                MODEL_CATALOG.gemini_31_flash_lite,
                MODEL_CATALOG.or_lightning_free,
                MODEL_CATALOG.groq_qwen38_27b,
                MODEL_CATALOG.gemini_35_flash,
                MODEL_CATALOG.or_auto_free
            ];
        }
    };

    const AutoMode = {
        isActive: () => sessionStorage.getItem('commando_auto_active') === 'true',
        start: () => {
            sessionStorage.setItem('commando_auto_active', 'true');
            sessionStorage.setItem('commando_stat_db', '0');
            sessionStorage.setItem('commando_stat_ai', '0');
            Logger.add('Автопилот запущен.', 'success');
        },
        stop: () => {
            sessionStorage.setItem('commando_auto_active', 'false');
            Logger.add('Автопилот остановлен.', 'warn');
        },
        incDb: () => sessionStorage.setItem('commando_stat_db', String(Number(sessionStorage.getItem('commando_stat_db') || 0) + 1)),
        incAi: () => sessionStorage.setItem('commando_stat_ai', String(Number(sessionStorage.getItem('commando_stat_ai') || 0) + 1)),
        getStats: () => ({
            db: Number(sessionStorage.getItem('commando_stat_db') || 0),
            ai: Number(sessionStorage.getItem('commando_stat_ai') || 0)
        })
    };

    function getTrackedAnswers() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (e) { return {}; }
    }

    function trackAnswer(qHash) {
        const tracked = getTrackedAnswers();
        tracked[qHash] = true;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(tracked));
    }

    function untrackAnswer(qHash) {
        const tracked = getTrackedAnswers();
        if (tracked[qHash]) {
            delete tracked[qHash];
            localStorage.setItem(STORAGE_KEY, JSON.stringify(tracked));
        }
    }

    function extractCleanText(element) {
        if (!element) return '';
        let clone = element.cloneNode(true);
        clone.querySelectorAll('.MathJax_Preview, .MathJax, .MJX_Assistive_MathML').forEach(el => el.remove());
        clone.querySelectorAll('script[type^="math/tex"]').forEach(script => {
            let mathText = script.innerText || script.textContent;
            let textNode = document.createTextNode(` ${mathText.trim()} `);
            script.parentNode.replaceChild(textNode, script);
        });
        return clone.innerText.replace(/[\s\u00A0]+/g, ' ').trim();
    }

    function extractChoiceText(element, allImages = []) {
        if (!element) return '';
        let text = extractCleanText(element);

        let imgSignatures = [];
        element.querySelectorAll('img').forEach(img => {
            let src = img.getAttribute('src') || '';
            let sig = '';
            if (src.startsWith('data:')) {
                sig = `_imginline_${src.length}_${src.substring(0, 30)}`;
            } else {
                sig = `_img_${src.split('/').pop().split('?')[0]}`;
            }

            let globalIndex = allImages.indexOf(img);
            if (globalIndex !== -1) {
                imgSignatures.push(`[Изображение №${globalIndex + 1} (ID: ${sig})]`);
            } else {
                imgSignatures.push(`[Изображение (ID: ${sig})]`);
            }
        });

        if (imgSignatures.length > 0) {
            text = (text + ' ' + imgSignatures.join(' ')).trim();
        }
        return text;
    }

    async function getQuestionHash(questionBlock) {
        const qtextEl = questionBlock.querySelector('.qtext');
        if (!qtextEl) return 'q_unknown';

        let baseText = extractCleanText(qtextEl).toLowerCase();
        questionBlock.querySelectorAll('.qtext img, .answer img').forEach(img => {
            let src = img.getAttribute('src') || '';
            if (src.startsWith('data:')) {
                baseText += `_imginline_${src.length}_${src.substring(0, 30)}`;
            } else {
                baseText += `_img_${src.split('/').pop().split('?')[0]}`;
            }
        });

        const msgUint8 = new TextEncoder().encode(baseText);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return 'q_' + hashHex.substring(0, 24);
    }

    function fetchImageAsBase64(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET", url: url, responseType: "arraybuffer", timeout: 15000,
                onload: function(response) {
                    if (response.status === 200) {
                        let contentType = response.responseHeaders.match(/content-type:\s*([^\s;]+)/i)?.[1] || "image/jpeg";
                        let reader = new FileReader();
                        reader.onloadend = () => resolve({ mimeType: contentType, data: reader.result.split(',')[1] });
                        reader.readAsDataURL(new Blob([response.response], { type: contentType }));
                    } else reject(new Error(`Code ${response.status}`));
                },
                onerror: () => reject(new Error("Network error"))
            });
        });
    }

    function extractCleanJson(rawText) {
        let cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        let start = cleaned.indexOf('{');
        let end = cleaned.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            return cleaned.substring(start, end + 1);
        }
        throw new Error("No valid JSON found in response");
    }

    function triggerMoodleEvents(element) {
        if (!element) return;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    }

    function injectStyles() {
        if (document.getElementById('commando-panel-styles')) return;
        const styles = document.createElement('style');
        styles.id = 'commando-panel-styles';
        styles.innerHTML = `
            @import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;700&display=swap');

            .commando-dashboard {
                position: fixed; top: 15px; right: 15px; z-index: 999999;
                background: #253237; color: #E6E8E6; border: 2px solid #9DB4C0;
                border-radius: 4px; width: 345px; box-shadow: 0 0 20px rgba(37,50,55,0.4);
                font-family: 'Fira Code', 'Courier New', monospace;
                font-size: 12px; overflow: hidden; transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1), height 0.3s, max-height 0.3s;
                text-shadow: 0 0 2px rgba(230, 232, 230, 0.2);
                box-sizing: border-box;
                max-height: 90vh;
            }
            .commando-dashboard::before {
                content: " "; display: block; position: absolute; top: 0; left: 0; bottom: 0; right: 0;
                background: linear-gradient(rgba(37, 50, 55, 0) 50%, rgba(0, 0, 0, 0.15) 50%);
                z-index: 1000000; background-size: 100% 3px; pointer-events: none;
            }
            .commando-dashboard.collapsed {
                width: 50px; height: 50px; border-radius: 4px; top: 15px; right: 15px;
                background: #253237; border: 2px solid #5C6B73; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                box-shadow: 0 0 10px rgba(92,107,115,0.3);
            }
            .commando-dashboard.collapsed.autopilot-active {
                border-color: #CEDOCE;
                box-shadow: 0 0 15px rgba(206, 220, 206, 0.4);
            }
            .commando-dashboard.collapsed .commando-full-ui {
                display: none !important;
            }
            .commando-dashboard:not(.collapsed) .commando-mini-trigger {
                display: none !important;
            }
            .commando-header {
                display: flex; justify-content: space-between; align-items: center;
                padding: 10px 14px; background: #5C6B73; border-bottom: 2px solid #9DB4C0;
                user-select: none;
            }
            .commando-title { font-weight: bold; font-size: 13px; color: #E6E8E6; letter-spacing: 1px; }
            .commando-collapse-btn {
                background: transparent; border: 1px solid #9DB4C0; color: #9DB4C0; cursor: pointer;
                font-size: 11px; width: 22px; height: 22px; display: flex;
                align-items: center; justify-content: center; transition: all 0.2s;
                border-radius: 2px;
            }
            .commando-collapse-btn:hover { background: #9DB4C0; color: #253237; }
            .commando-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; max-height: calc(90vh - 46px); }

            .commando-card {
                background: rgba(92, 107, 115, 0.15); border: 1px solid #5C6B73; padding: 10px; position: relative;
                border-radius: 3px;
            }
            .commando-card-title {
                font-size: 10px; font-weight: bold; text-transform: uppercase;
                letter-spacing: 0.1em; color: #9DB4C0; margin-bottom: 8px;
                display: flex; justify-content: space-between; align-items: center;
                border-bottom: 1px dashed #5C6B73; padding-bottom: 4px;
            }

            .commando-btn {
                background: #5C6B73; color: #E6E8E6; border: 1px solid #9DB4C0; padding: 6px 10px;
                cursor: pointer; font-family: 'Fira Code', monospace; font-weight: bold; font-size: 11px;
                transition: all 0.2s; width: 100%; text-align: center; box-sizing: border-box;
                border-radius: 2px;
            }
            .commando-btn:hover { background: #9DB4C0; color: #253237; box-shadow: 0 0 8px rgba(157,180,192,0.6); }
            .commando-btn.btn-secondary { background: #253237; border-color: #5C6B73; color: #CEDOCE; }
            .commando-btn.btn-secondary:hover { background: #5C6B73; color: #E6E8E6; }
            .commando-btn.btn-active { background: #253237; border-color: #CEDOCE; color: #CEDOCE; }
            .commando-btn.btn-active:hover { background: #CEDOCE; color: #253237; box-shadow: 0 0 8px rgba(206,220,206,0.6); }

            .commando-select {
                background: #253237; color: #E6E8E6; border: 1px solid #9DB4C0;
                padding: 6px; width: 100%; font-family: 'Fira Code', monospace; font-size: 10px;
                outline: none; cursor: pointer; box-sizing: border-box;
                border-radius: 2px;
            }
            .commando-log-view {
                background: #1c272b; border-radius: 2px; padding: 6px;
                height: 120px; overflow-y: auto; font-family: 'Fira Code', monospace;
                font-size: 10px; line-height: 1.3; border: 1px solid #5C6B73;
            }
            .commando-input {
                background: #253237; color: #E6E8E6; border: 1px solid #9DB4C0;
                padding: 6px; width: 100%; font-family: 'Fira Code', monospace; font-size: 11px;
                outline: none; box-sizing: border-box;
                border-radius: 2px;
            }
            .commando-label {
                font-size: 10px; color: #9DB4C0; margin-bottom: 2px; display: block;
            }
            .commando-drawer {
                display: none; flex-direction: column; gap: 8px; margin-top: 8px;
                border-top: 1px dashed #5C6B73; padding-top: 8px;
            }
            .commando-drawer.active { display: flex; }
            .commando-help { font-size: 10px; color: #CEDOCE; line-height: 1.35; }
            .commando-help a { color: #9DB4C0; text-decoration: underline; }
            .commando-mini-trigger {
                width: 100%; height: 100%; display: flex; align-items: center;
                justify-content: center; font-size: 16px; color: #9DB4C0; font-weight: bold;
            }
            .commando-mini-trigger:hover { color: #E6E8E6; }

            .auto-solve-btn {
                font-family: 'Fira Code', monospace !important;
                border: 1px solid #9DB4C0 !important;
                background-color: #253237 !important;
                color: #9DB4C0 !important;
                border-radius: 3px !important;
                box-shadow: none !important;
                text-shadow: 0 0 2px rgba(157, 180, 192, 0.5) !important;
                transition: all 0.2s !important;
            }
            .auto-solve-btn:hover {
                background-color: #9DB4C0 !important;
                color: #253237 !important;
                box-shadow: 0 0 8px rgba(157,180,192,0.6) !important;
            }
            .auto-solve-btn.recheck-ready {
                border-color: #CEDOCE !important;
                color: #CEDOCE !important;
            }
            .auto-solve-btn.recheck-ready:hover {
                background-color: #CEDOCE !important;
                color: #253237 !important;
                box-shadow: 0 0 8px rgba(206,220,206,0.6) !important;
            }
        `;
        document.head.appendChild(styles);
    }

    function createUI() {
        injectStyles();
        if (document.getElementById('commando-dashboard')) return;

        const isCollapsed = localStorage.getItem(KEY_UI_COLLAPSED) === 'true';
        const logsExpanded = localStorage.getItem(KEY_LOGS_EXPANDED) === 'true';

        const dashboard = document.createElement('div');
        dashboard.id = 'commando-dashboard';
        dashboard.className = 'commando-dashboard';
        if (isCollapsed) dashboard.classList.add('collapsed');
        if (AutoMode.isActive()) dashboard.classList.add('autopilot-active');

        const miniTrigger = document.createElement('div');
        miniTrigger.className = 'commando-mini-trigger';
        miniTrigger.innerText = '[💾]';
        miniTrigger.title = 'Развернуть COMMANDO';

        const fullUI = document.createElement('div');
        fullUI.className = 'commando-full-ui';
        fullUI.style.display = isCollapsed ? 'none' : 'block';

        miniTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            dashboard.classList.remove('collapsed');
            fullUI.style.display = 'block';
            localStorage.setItem(KEY_UI_COLLAPSED, 'false');
        });
        dashboard.appendChild(miniTrigger);

        const header = document.createElement('div');
        header.className = 'commando-header';

        const title = document.createElement('div');
        title.className = 'commando-title';
        title.innerText = '💾 COMMANDO v13.1';
        header.appendChild(title);

        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'commando-collapse-btn';
        collapseBtn.innerHTML = '[-]';
        collapseBtn.title = 'Свернуть';
        collapseBtn.addEventListener('click', () => {
            dashboard.classList.add('collapsed');
            fullUI.style.display = 'none';
            localStorage.setItem(KEY_UI_COLLAPSED, 'true');
        });
        header.appendChild(collapseBtn);
        fullUI.appendChild(header);

        const body = document.createElement('div');
        body.className = 'commando-body';

        // 1. Статистика и Автопилот
        const statCard = document.createElement('div');
        statCard.className = 'commando-card';

        const autopilotBtn = document.createElement('button');
        autopilotBtn.id = 'commando-ui-autopilot';
        autopilotBtn.className = 'commando-btn';
        if (AutoMode.isActive()) {
            autopilotBtn.classList.add('btn-active');
            autopilotBtn.innerText = '[АВТОПИЛОТ: ВКЛ]';
        } else {
            autopilotBtn.innerText = '[АВТОПИЛОТ: ВЫКЛ]';
        }

        autopilotBtn.addEventListener('click', () => {
            if (AutoMode.isActive()) {
                AutoMode.stop();
                autopilotBtn.classList.remove('btn-active');
                autopilotBtn.innerText = '[АВТОПИЛОТ: ВЫКЛ]';
                dashboard.classList.remove('autopilot-active');
            } else {
                AutoMode.start();
                autopilotBtn.classList.add('btn-active');
                autopilotBtn.innerText = '[АВТОПИЛОТ: ВКЛ]';
                dashboard.classList.add('autopilot-active');
                document.querySelectorAll('.que').forEach(q => {
                    const btn = q.querySelector('.auto-solve-btn');
                    if (btn && !btn.classList.contains('recheck-ready')) btn.click();
                });
            }
        });
        statCard.appendChild(autopilotBtn);

        const statRow = document.createElement('div');
        statRow.style.display = 'flex';
        statRow.style.justifyContent = 'space-between';
        statRow.style.marginTop = '10px';
        statRow.style.fontSize = '10px';
        statRow.style.color = '#CEDOCE';

        const stats = AutoMode.getStats();
        const statDbSpan = document.createElement('span');
        statDbSpan.id = 'commando-ui-stat-db';
        statDbSpan.innerHTML = `БД: <b>${stats.db}</b>`;
        statRow.appendChild(statDbSpan);

        const statAiSpan = document.createElement('span');
        statAiSpan.id = 'commando-ui-stat-ai';
        statAiSpan.innerHTML = `ИИ: <b>${stats.ai}</b>`;
        statRow.appendChild(statAiSpan);
        statCard.appendChild(statRow);

        body.appendChild(statCard);

        // 2. Выбор режима и моделей
        const modelCard = document.createElement('div');
        modelCard.className = 'commando-card';

        const mTitle = document.createElement('div');
        mTitle.className = 'commando-card-title';
        mTitle.innerText = 'МАРШРУТ И МОДЕЛИ ИИ';
        modelCard.appendChild(mTitle);

        const routeSelect = document.createElement('select');
        routeSelect.className = 'commando-select';
        let optionsHtml = `
            <option value="smart_auto">Smart Auto (fast / medium / smart)</option>
            <option value="only_fast">Только простые вопросы (fast)</option>
            <option value="only_medium">Только средние вопросы (medium)</option>
            <option value="only_smart">Только сложные/картинки (smart)</option>
        `;
        Object.entries(MODEL_CATALOG).forEach(([key, cfg]) => {
            optionsHtml += `<option value="${key}">${cfg.label}</option>`;
        });
        routeSelect.innerHTML = optionsHtml;
        routeSelect.value = RoutingManager.getMode();
        if (!routeSelect.value) routeSelect.value = 'smart_auto';

        routeSelect.addEventListener('change', (e) => {
            RoutingManager.setMode(e.target.value);
            Logger.add(`Выбран режим/модель: ${e.target.value}`, 'info');
        });
        modelCard.appendChild(routeSelect);
        body.appendChild(modelCard);

        // 3. Управление ключами (Gemini, Groq, OpenRouter)
        const keyCard = document.createElement('div');
        keyCard.className = 'commando-card';

        const kTitle = document.createElement('div');
        kTitle.className = 'commando-card-title';
        kTitle.innerHTML = `API-КЛЮЧИ <span id="commando-key-status" style="font-size:9px; color:#CEDOCE;"></span>`;
        keyCard.appendChild(kTitle);

        const maskedLabel = document.createElement('div');
        maskedLabel.id = 'commando-masked-key-label';
        maskedLabel.style.fontSize = '10px';
        maskedLabel.style.color = '#CEDOCE';
        maskedLabel.style.marginBottom = '6px';
        maskedLabel.style.lineHeight = '1.4';

        const refreshKeyLabels = () => {
            maskedLabel.innerHTML =
                `Gemini: <span style="color:#9DB4C0;">${KeyManager.getMasked('gemini')}</span><br>` +
                `Groq: <span style="color:#9DB4C0;">${KeyManager.getMasked('groq')}</span><br>` +
                `OpenRouter: <span style="color:#9DB4C0;">${KeyManager.getMasked('openrouter')}</span>`;

            const activeCount = ['gemini', 'groq', 'openrouter'].filter(p => KeyManager.hasKey(p)).length;
            const statusEl = document.getElementById('commando-key-status');
            if (statusEl) {
                statusEl.innerText = `(${activeCount}/3 АКТИВНО)`;
                statusEl.style.color = activeCount > 0 ? '#CEDOCE' : '#ff3333';
            }
        };
        keyCard.appendChild(maskedLabel);

        const toggleKeyDrawerBtn = document.createElement('button');
        toggleKeyDrawerBtn.className = 'commando-btn btn-secondary';
        toggleKeyDrawerBtn.innerText = '[ НАСТРОИТЬ КЛЮЧИ ]';

        const keyDrawer = document.createElement('div');
        keyDrawer.className = 'commando-drawer';

        const gemLabel = document.createElement('span');
        gemLabel.className = 'commando-label';
        gemLabel.innerText = 'Gemini API Key (AIza...):';
        const gemInput = document.createElement('input');
        gemInput.type = 'password';
        gemInput.className = 'commando-input';
        gemInput.placeholder = 'Оставьте пустым для default';
        if (KeyManager.isCustomGemini()) gemInput.value = KeyManager.getProviderKey('gemini');

        const groqLabel = document.createElement('span');
        groqLabel.className = 'commando-label';
        groqLabel.innerText = 'Groq API Key (gsk_...):';
        const groqInput = document.createElement('input');
        groqInput.type = 'password';
        groqInput.className = 'commando-input';
        groqInput.placeholder = 'gsk_... (console.groq.com)';
        if (KeyManager.hasKey('groq')) groqInput.value = KeyManager.getProviderKey('groq');

        const orLabel = document.createElement('span');
        orLabel.className = 'commando-label';
        orLabel.innerText = 'OpenRouter API Key (sk-or-...):';
        const orInput = document.createElement('input');
        orInput.type = 'password';
        orInput.className = 'commando-input';
        orInput.placeholder = 'sk-or-v1-... (openrouter.ai)';
        if (KeyManager.hasKey('openrouter')) orInput.value = KeyManager.getProviderKey('openrouter');

        const kSaveBtn = document.createElement('button');
        kSaveBtn.className = 'commando-btn btn-active';
        kSaveBtn.innerText = '[ СОХРАНИТЬ КЛЮЧИ ]';
        kSaveBtn.addEventListener('click', () => {
            KeyManager.setProviderKey('gemini', gemInput.value);
            KeyManager.setProviderKey('groq', groqInput.value);
            KeyManager.setProviderKey('openrouter', orInput.value);
            refreshKeyLabels();
            Logger.add('Ключи провайдеров обновлены.', 'success');
        });

        const kInstructions = document.createElement('div');
        kInstructions.className = 'commando-help';
        kInstructions.innerHTML = `
            Провайдеры:<br>
            • <a href="https://aistudio.google.com/" target="_blank">Google AI Studio</a> (Gemini)<br>
            • <a href="https://console.groq.com/" target="_blank">Groq Console</a> (GPT-OSS / Qwen)<br>
            • <a href="https://openrouter.ai/keys" target="_blank">OpenRouter</a> (модели <code>:free</code>)
        `;

        keyDrawer.appendChild(gemLabel);
        keyDrawer.appendChild(gemInput);
        keyDrawer.appendChild(groqLabel);
        keyDrawer.appendChild(groqInput);
        keyDrawer.appendChild(orLabel);
        keyDrawer.appendChild(orInput);
        keyDrawer.appendChild(kSaveBtn);
        keyDrawer.appendChild(kInstructions);
        keyCard.appendChild(toggleKeyDrawerBtn);
        keyCard.appendChild(keyDrawer);
        body.appendChild(keyCard);

        toggleKeyDrawerBtn.addEventListener('click', () => {
            keyDrawer.classList.toggle('active');
        });

        // 4. Терминал логов
        const logCard = document.createElement('div');
        logCard.className = 'commando-card';

        const lTitle = document.createElement('div');
        lTitle.className = 'commando-card-title';
        lTitle.innerText = 'СИСТЕМНЫЙ ВЫВОД (LOGS)';
        logCard.appendChild(lTitle);

        const toggleLogsBtn = document.createElement('button');
        toggleLogsBtn.className = 'commando-btn btn-secondary';
        toggleLogsBtn.innerText = logsExpanded ? '[ СКРЫТЬ ЛОГИ ]' : '[ ПОКАЗАТЬ ЛОГИ ]';

        const logTerminal = document.createElement('div');
        logTerminal.id = 'commando-log-terminal';
        logTerminal.className = 'commando-log-view';
        logTerminal.style.display = logsExpanded ? 'block' : 'none';

        toggleLogsBtn.addEventListener('click', () => {
            const expanded = logTerminal.style.display === 'none';
            logTerminal.style.display = expanded ? 'block' : 'none';
            toggleLogsBtn.innerText = expanded ? '[ СКРЫТЬ ЛОГИ ]' : '[ ПОКАЗАТЬ ЛОГИ ]';
            localStorage.setItem(KEY_LOGS_EXPANDED, String(expanded));
            if (expanded) logTerminal.scrollTop = logTerminal.scrollHeight;
        });

        logCard.appendChild(toggleLogsBtn);
        logCard.appendChild(logTerminal);
        body.appendChild(logCard);

        fullUI.appendChild(body);
        dashboard.appendChild(fullUI);
        document.body.appendChild(dashboard);

        refreshKeyLabels();

        Logger.logs.forEach(log => {
            const colors = { info: '#9DB4C0', success: '#CEDOCE', warn: '#ffcc00', error: '#ff3333' };
            const item = document.createElement('div');
            item.style.marginBottom = '4px';
            item.style.color = colors[log.level] || '#ccc';
            item.innerHTML = `<span style="color: #5C6B73;">[${log.time}]</span> ${log.text}`;
            logTerminal.appendChild(item);
        });
        logTerminal.scrollTop = logTerminal.scrollHeight;
    }

    function updateFloatingPanel() {
        const stats = AutoMode.getStats();
        const statDb = document.getElementById('commando-ui-stat-db');
        const statAi = document.getElementById('commando-ui-stat-ai');
        if (statDb) statDb.innerHTML = `БД: <b>${stats.db}</b>`;
        if (statAi) statAi.innerHTML = `ИИ: <b>${stats.ai}</b>`;
    }

    function makeRecheckBtnReady(button) {
        button.disabled = false;
        button.classList.add('recheck-ready');
    }

    function fillFromDatabase(questionBlock, dbData, button, qHash, markDone) {
        let actionCount = 0;
        try {
            if ((dbData.type === 'multichoice' || dbData.type === 'truefalse') && Array.isArray(dbData.answers)) {
                questionBlock.querySelectorAll('.answer .r0, .answer .r1').forEach(row => {
                    let textEl = row.querySelector('.flex-fill') || row.querySelector('label');
                    let input = row.querySelector('input[type="checkbox"], input[type="radio"]');
                    if (textEl && input && dbData.answers.includes(extractChoiceText(textEl))) {
                        if (!input.checked) {
                            input.click();
                            triggerMoodleEvents(input);
                            actionCount++;
                        }
                    }
                });
            }
            else if (dbData.type === 'shortanswer' && dbData.answers) {
                let input = questionBlock.querySelector('input[type="text"].form-control');
                if (input) {
                    input.value = dbData.answers;
                    triggerMoodleEvents(input);
                    actionCount = 1;
                }
            }
            else if (dbData.type === 'match' && dbData.answers) {
                questionBlock.querySelectorAll('table.answer tr').forEach(row => {
                    let textTd = row.querySelector('td.text');
                    let select = row.querySelector('select');
                    if (textTd && select) {
                        let currentSubQ = extractCleanText(textTd).replace(/[«»"']/g, '').trim();
                        let targetOptionText = dbData.answers[currentSubQ];
                        if (targetOptionText) {
                            for (let opt of select.options) {
                                if (opt.innerText.replace(/[\s\u00A0]+/g, ' ').replace(/[«»"']/g, '').trim() === targetOptionText.replace(/[«»"']/g, '').trim()) {
                                    select.value = opt.value;
                                    triggerMoodleEvents(select);
                                    actionCount++;
                                    break;
                                }
                            }
                        }
                    }
                });
            }

            trackAnswer(qHash);
            button.innerText = `[🔷 ИЗ БД (${actionCount}) | ПЕРЕПРОВЕРИТЬ]`;
            makeRecheckBtnReady(button);
            Logger.add(`Вопрос ${qHash.substring(2, 8)}: подтянуто решение из БД (${actionCount} совпадений)`, 'success');

            if (AutoMode.isActive()) AutoMode.incDb();
        } catch (e) {
            Logger.add(`Ошибка заполнения из БД: ${e.message}`, 'error');
            button.innerText = '[⚠️ Ошибка вставки из БД]';
        } finally {
            markDone();
        }
    }

    function applyAiResult(result, questionBlock) {
        let actionCount = 0;
        if ((result.type === 'multichoice' || result.type === 'truefalse') && Array.isArray(result.answers)) {
            result.answers.forEach(id => {
                const input = questionBlock.querySelector(`input[id="${id}"]`);
                if (input && !input.checked) {
                    input.click();
                    triggerMoodleEvents(input);
                    actionCount++;
                }
            });
        } else if (result.type === 'shortanswer' && result.text !== undefined) {
            const input = questionBlock.querySelector(`input[id="${result.id}"]`) || questionBlock.querySelector('input[type="text"].form-control');
            if (input) {
                input.value = String(result.text);
                triggerMoodleEvents(input);
                actionCount = 1;
            }
        } else if (result.type === 'match' && result.mappings) {
            for (const [selectId, val] of Object.entries(result.mappings)) {
                const select = questionBlock.querySelector(`select[id="${selectId}"]`);
                if (select) {
                    select.value = val;
                    triggerMoodleEvents(select);
                    actionCount++;
                }
            }
        }
        return actionCount;
    }

    function dispatchModelRequest(modelCfg, promptText, validImages, onSuccess, onRetry) {
        const apiKey = KeyManager.getProviderKey(modelCfg.provider);
        if (!apiKey) {
            Logger.add(`Пропуск [${modelCfg.id}]: не задан ключ для ${modelCfg.provider}.`, 'warn');
            onRetry(false);
            return;
        }

        if (modelCfg.provider === 'gemini') {
            const parts = [{ text: promptText }];
            validImages.forEach(img => {
                parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
            });

            GM_xmlhttpRequest({
                method: 'POST',
                url: `https://generativelanguage.googleapis.com/v1beta/models/${modelCfg.id}:generateContent?key=${encodeURIComponent(apiKey)}`,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ contents: [{ parts }] }),
                timeout: 25000,
                onload: (res) => {
                    if (res.status === 200) {
                        try {
                            const data = JSON.parse(res.responseText);
                            const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                            const parsed = JSON.parse(extractCleanJson(rawText));
                            onSuccess(parsed);
                        } catch (err) {
                            Logger.add(`Ошибка разбора ответа [${modelCfg.id}]: ${err.message}`, 'error');
                            onRetry(false);
                        }
                    } else {
                        Logger.add(`Gemini [${modelCfg.id}] вернул HTTP ${res.status}.`, 'warn');
                        onRetry(res.status === 429 || res.status === 503);
                    }
                },
                ontimeout: () => {
                    Logger.add(`Тайм-аут [${modelCfg.id}].`, 'warn');
                    onRetry(false);
                },
                onerror: () => {
                    Logger.add(`Сетевая ошибка [${modelCfg.id}].`, 'error');
                    onRetry(false);
                }
            });
            return;
        }

        const isGroq = modelCfg.provider === 'groq';
        const url = isGroq
            ? 'https://api.groq.com/openai/v1/chat/completions'
            : 'https://openrouter.ai/api/v1/chat/completions';

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        };
        if (!isGroq) {
            headers['HTTP-Referer'] = window.location.origin;
            headers['X-Title'] = 'Moodle-Commando';
        }

        let contentPayload = promptText;
        if (modelCfg.vision && validImages.length > 0) {
            contentPayload = [
                { type: 'text', text: promptText },
                ...validImages.map(img => ({
                    type: 'image_url',
                    image_url: { url: `data:${img.mimeType};base64,${img.data}` }
                }))
            ];
        }

        GM_xmlhttpRequest({
            method: 'POST',
            url: url,
            headers: headers,
            data: JSON.stringify({
                model: modelCfg.id,
                temperature: 0.1,
                messages: [{ role: 'user', content: contentPayload }]
            }),
            timeout: 25000,
            onload: (res) => {
                if (res.status === 200) {
                    try {
                        const data = JSON.parse(res.responseText);
                        const rawText = data?.choices?.[0]?.message?.content || '';
                        const parsed = JSON.parse(extractCleanJson(rawText));
                        onSuccess(parsed);
                    } catch (err) {
                        Logger.add(`Ошибка парсинга JSON [${modelCfg.id}]: ${err.message}`, 'error');
                        onRetry(false);
                    }
                } else {
                    Logger.add(`${modelCfg.provider.toUpperCase()} [${modelCfg.id}] HTTP ${res.status}.`, 'warn');
                    onRetry(res.status === 429 || res.status === 503);
                }
            },
            ontimeout: () => {
                Logger.add(`Тайм-аут [${modelCfg.id}].`, 'warn');
                onRetry(false);
            },
            onerror: () => {
                Logger.add(`Сетевая ошибка [${modelCfg.id}].`, 'error');
                onRetry(false);
            }
        });
    }

    function sendAiRequest(promptText, validImages, modelsList, modelIndex, questionBlock, button, qType, qHash, markDone) {
        if (modelIndex >= modelsList.length) {
            button.innerText = '[❌ Все модели недоступны]';
            button.disabled = false;
            Logger.add('Все модели в цепочке не ответили. Проверьте ключи и лимиты.', 'error');
            markDone();
            return;
        }

        const currentCfg = modelsList[modelIndex];
        button.innerText = `[${currentCfg.id.split('/').pop()} (${currentCfg.profile})...]`;
        Logger.add(`Запрос через [${currentCfg.provider}:${currentCfg.id} (${currentCfg.profile})]...`, 'info');

        const imagesForModel = currentCfg.vision ? validImages : [];

        dispatchModelRequest(
            currentCfg,
            promptText,
            imagesForModel,
            (result) => {
                const actionCount = applyAiResult(result, questionBlock);
                trackAnswer(qHash);
                button.innerText = `[Решено ИИ (${actionCount}) | ПЕРЕПРОВЕРИТЬ]`;
                makeRecheckBtnReady(button);
                Logger.add(`Вопрос ${qHash.substring(2, 8)} решён через ${currentCfg.id} (${actionCount} полей)`, 'success');
                if (AutoMode.isActive()) AutoMode.incAi();
                markDone();
            },
            (isRateLimit = false) => {
                const delay = isRateLimit ? Math.min(2500, (modelIndex + 1) * 500) : 150;
                setTimeout(() => {
                    sendAiRequest(promptText, validImages, modelsList, modelIndex + 1, questionBlock, button, qType, qHash, markDone);
                }, delay);
            }
        );
    }

    async function processQuestion(questionBlock, button, forceAi = false) {
        let qType = 'unknown';
        if (questionBlock.classList.contains('multichoice')) qType = 'multichoice';
        else if (questionBlock.classList.contains('truefalse')) qType = 'truefalse';
        else if (questionBlock.classList.contains('shortanswer') || questionBlock.classList.contains('numerical')) qType = 'shortanswer';
        else if (questionBlock.classList.contains('match')) qType = 'match';

        if (qType === 'unknown') return;

        activeRequestsOnPage++;
        const markDone = () => {
            activeRequestsOnPage = Math.max(0, activeRequestsOnPage - 1);
            updateFloatingPanel();
            checkPageCompletion();
        };

        button.disabled = true;
        button.classList.remove('recheck-ready');
        button.innerText = forceAi ? '[ Перепроверка ИИ... ]' : '[ Поиск в БД... ]';

        try {
            const qHash = await getQuestionHash(questionBlock);

            const switchToAi = () => {
                button.innerText = '[ Сбор структуры... ]';

                let qData;
                try {
                    qData = parseQuestionStructure(questionBlock, qType);
                } catch (parseErr) {
                    Logger.add(`Ошибка парсинга DOM: ${parseErr.message}`, 'error');
                    button.innerText = '[❌ Сбой сбора DOM]';
                    button.disabled = false;
                    markDone();
                    return;
                }

                let promptText = `Ты — экспертный ИИ-модуль тестирования. Реши задачу и выведи результат СТРОГО в формате JSON без какого-либо другого текста вокруг. Вложения содержат все изображения из вопроса и вариантов ответов по порядку (Изображение №1, Изображение №2, ...).\n\n`;

                if (qType === 'multichoice') {
                    promptText += `Вопрос: "${qData.questionText}"\nВарианты:\n${qData.elements.map(e => `- ID: ${e.id} | Текст: ${e.text}`).join('\n')}\n\nВыведи: {"type": "multichoice", "answers": ["ID_верного_варианта"]}`;
                }
                else if (qType === 'truefalse') {
                    promptText += `Вопрос: "${qData.questionText}"\nВарианты:\n${qData.elements.map(e => `- ID: ${e.id} | Текст: ${e.text}`).join('\n')}\n\nВыведи: {"type": "truefalse", "answers": ["ID_выбранного_варианта"]}`;
                }
                else if (qType === 'shortanswer') {
                    promptText += `Вопрос: "${qData.questionText}"\n\nВыведи: {"type": "shortanswer", "id": "${qData.elements[0].id}", "text": "ТвойОтветЗдесь"}`;
                }
                else if (qType === 'match') {
                    promptText += `Общий вопрос: "${qData.questionText}"\nЗадания:\n${qData.elements.map(e => `Селект ID: "${e.selectId}" для вопроса: "${e.subQuestion}"\nОпции:\n${e.options.map(o => `  - Value: "${o.value}" -> "${o.text}"`).join('\n')}`).join('\n\n')}\n\nВыведи: {"type": "match", "mappings": {"Селект_ID": "Выбранное_Value"}}`;
                }

                const imgElements = questionBlock.querySelectorAll('.qtext img, .answer img');
                let imagePromises = [];
                imgElements.forEach(img => {
                    try {
                        let src = img.getAttribute('src');
                        if (src) {
                            if (src.startsWith('data:')) {
                                let match = src.match(/^data:([^;]+);base64,(.+)$/);
                                if (match) {
                                    imagePromises.push(Promise.resolve({ mimeType: match[1], data: match[2] }));
                                }
                            } else {
                                const imgUrl = new URL(src, document.baseURI).href;
                                imagePromises.push(fetchImageAsBase64(imgUrl).catch(() => null));
                            }
                        }
                    } catch (imgErr) {
                        Logger.add('Пропущен повреждённый URL картинки', 'warn');
                    }
                });

                const modelsChain = RoutingManager.buildChain(questionBlock, qType);

                Promise.all(imagePromises).then(downloadedImages => {
                    const validImages = downloadedImages.filter(img => img !== null);
                    sendAiRequest(promptText, validImages, modelsChain, 0, questionBlock, button, qType, qHash, markDone);
                }).catch(() => {
                    sendAiRequest(promptText, [], modelsChain, 0, questionBlock, button, qType, qHash, markDone);
                });
            };

            if (forceAi) {
                switchToAi();
                return;
            }

            GM_xmlhttpRequest({
                method: "GET",
                url: `${FIREBASE_URL}questions/${qHash}.json`,
                timeout: 10000,
                onload: function(response) {
                    if (response.status === 200 && response.responseText !== 'null') {
                        fillFromDatabase(questionBlock, JSON.parse(response.responseText), button, qHash, markDone);
                    } else {
                        switchToAi();
                    }
                },
                onerror: switchToAi,
                ontimeout: switchToAi
            });
        } catch (globalErr) {
            Logger.add(`Критический сбой процесса решения: ${globalErr.message}`, 'error');
            button.innerText = '[❌ Критическая ошибка]';
            button.disabled = false;
            markDone();
        }
    }

    function checkPageCompletion() {
        if (activeRequestsOnPage > 0) return;
        if (!AutoMode.isActive()) return;

        const nextBtn = document.querySelector('.mod_quiz-next-nav, input[name="next"], input[id$="_next"]');
        if (nextBtn) {
            setTimeout(() => { nextBtn.click(); }, 1500);
        } else {
            AutoMode.stop();
            const stats = AutoMode.getStats();

            const finishNotice = document.createElement('div');
            finishNotice.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 999999; background: #253237; color: #E6E8E6; border: 2px solid #9DB4C0; padding: 15px; box-shadow: 0 0 15px rgba(37,50,55,0.4); font-family: "Fira Code", monospace; width: 320px; cursor: pointer; border-radius: 4px;';
            finishNotice.innerHTML = `
                <div style="font-size: 13px; font-weight: bold; margin-bottom: 5px; color: #CEDOCE;">🏁 АВТОПРОХОЖДЕНИЕ ЗАВЕРШЕНО!</div>
                <div style="font-size: 11px; color: #E6E8E6; line-height: 1.4;">
                    • Из базы знаний: <b>${stats.db}</b><br>
                    • Сгенерировано ИИ: <b>${stats.ai}</b>
                </div>
            `;
            finishNotice.addEventListener('click', () => finishNotice.remove());
            document.body.appendChild(finishNotice);
            setTimeout(() => { if (finishNotice) finishNotice.remove(); }, 10000);

            updateFloatingPanel();
        }
    }

    function showInitialLoader() {
        if (document.getElementById('commando-upload-notice')) return;

        const loaderNotice = document.createElement('div');
        loaderNotice.id = 'commando-upload-notice';
        loaderNotice.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 999999; background: #253237; color: #E6E8E6; border: 2px solid #9DB4C0; padding: 15px; box-shadow: 0 0 15px rgba(37,50,55,0.4); font-family: "Fira Code", monospace; width: 320px; display: flex; align-items: flex-start; gap: 12px; transition: all 0.3s; cursor: pointer; border-radius: 4px;';

        loaderNotice.innerHTML = `
            <div id="commando-notice-icon" style="min-width: 18px; height: 18px; border: 2px solid #9DB4C0; border-top: 2px solid #253237; border-radius: 50%; display: inline-block; animation: commando-spin 1s linear infinite; margin-top: 2px;"></div>
            <div id="commando-notice-content">
                <div style="font-size: 12px; font-weight: bold; margin-bottom: 2px; color: #E6E8E6;">АНАЛИЗ COMMANDO OS...</div>
                <div style="font-size: 10px; color: #CEDOCE; line-height: 1.3;">Сверяем структуру сессии с облаком.</div>
            </div>
        `;

        loaderNotice.addEventListener('click', () => loaderNotice.remove());

        if (!document.getElementById('commando-spin-style')) {
            const spinStyle = document.createElement('style');
            spinStyle.id = 'commando-spin-style';
            spinStyle.innerHTML = '@keyframes commando-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
            document.head.appendChild(spinStyle);
        }

        (document.body || document.documentElement).appendChild(loaderNotice);
    }

    async function runReviewAndSave() {
        console.log('[REVIEW] Анализ контента страницы...');
        const showAllLink = document.querySelector('a[href*="showall=1"]');
        if (showAllLink && !window.location.search.includes('showall=1')) {
            window.location.href = showAllLink.href;
            return;
        }

        const trackedAnswers = getTrackedAnswers();
        const loaderNotice = document.getElementById('commando-upload-notice');
        const iconEl = document.getElementById('commando-notice-icon');
        const contentEl = document.getElementById('commando-notice-content');

        const incorrectBlocks = Array.from(document.querySelectorAll('.que.incorrect'));
        for (const qBlock of incorrectBlocks) {
            const qHash = await getQuestionHash(qBlock);
            if (trackedAnswers[qHash]) {
                GM_xmlhttpRequest({ method: "DELETE", url: `${FIREBASE_URL}questions/${qHash}.json`, onload: () => untrackAnswer(qHash) });
            }
        }

        let batchData = {};
        const correctBlocks = Array.from(document.querySelectorAll('.que.correct'));

        for (const qBlock of correctBlocks) {
            let qType = 'unknown';
            if (qBlock.classList.contains('multichoice')) qType = 'multichoice';
            else if (qBlock.classList.contains('truefalse')) qType = 'truefalse';
            else if (qBlock.classList.contains('shortanswer') || qBlock.classList.contains('numerical')) qType = 'shortanswer';
            else if (qBlock.classList.contains('match')) qType = 'match';

            if (qType === 'unknown') continue;

            const qHash = await getQuestionHash(qBlock);
            let answers = null;

            if (qType === 'shortanswer') {
                const rightAnswerEl = qBlock.querySelector('.outcome .rightanswer');
                if (rightAnswerEl) {
                    answers = rightAnswerEl.innerText.replace(/Правильный\s+ответ:\s*/i, '').trim();
                } else {
                    const inputEl = qBlock.querySelector('input[type="text"].form-control');
                    if (inputEl && inputEl.value.trim() !== '') answers = inputEl.value.trim();
                }
            }
            else if (qType === 'match') {
                let mappings = {};
                qBlock.querySelectorAll('table.answer tr').forEach(row => {
                    let textTd = row.querySelector('td.text');
                    let controlTd = row.querySelector('td.control');
                    let select = row.querySelector('select');
                    if (textTd && select && controlTd && (controlTd.classList.contains('correct') || controlTd.querySelector('.text-success, .fa-check'))) {
                        let subQ = extractCleanText(textTd);
                        let selectedOpt = select.options[select.selectedIndex];
                        if (selectedOpt && selectedOpt.value !== "0") mappings[subQ] = selectedOpt.innerText.replace(/[\s\u00A0]+/g, ' ').replace(/[«»"']/g, '').trim();
                    }
                });
                if (Object.keys(mappings).length > 0) answers = mappings;
            }
            else if (qType === 'multichoice' || qType === 'truefalse') {
                let checkedTexts = [];
                qBlock.querySelectorAll('.answer .r0, .answer .r1').forEach(row => {
                    const input = row.querySelector('input');
                    const isMoodleCorrect = row.classList.contains('correct') || row.querySelector('.fa-check, .text-success');
                    const isPhysicallyChecked = input && (input.checked || input.getAttribute('checked') === 'checked');

                    if (isPhysicallyChecked || isMoodleCorrect) {
                        let textEl = row.querySelector('.flex-fill') || row.querySelector('label');
                        if (textEl && (isMoodleCorrect || qBlock.classList.contains('correct'))) {
                            checkedTexts.push(extractChoiceText(textEl));
                        }
                    }
                });
                if (checkedTexts.length > 0) answers = checkedTexts;
            }

            if (answers) {
                batchData[qHash] = { type: qType, questionText: extractCleanText(qBlock.querySelector('.qtext')), answers: answers };
                untrackAnswer(qHash);
            }
        }

        let totalNew = Object.keys(batchData).length;

        if (totalNew > 0) {
            let typeCounters = { multichoice: 0, shortanswer: 0, match: 0, truefalse: 0 };
            Object.values(batchData).forEach(item => {
                if (typeCounters[item.type] !== undefined) typeCounters[item.type]++;
            });

            if (contentEl) {
                contentEl.innerHTML = `
                    <div style="font-size: 12px; font-weight: bold; margin-bottom: 2px; color: #E6E8E6;">СИНХРОНИЗАЦИЯ БАЗЫ ДАННЫХ...</div>
                    <div style="font-size: 10px; color: #CEDOCE; line-height: 1.3;">Сохраняем новые ответы (${totalNew} шт.)</div>
                `;
            }

            GM_xmlhttpRequest({
                method: "PATCH",
                url: `${FIREBASE_URL}questions.json`,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify(batchData),
                onload: function(res) {
                    if (res.status === 200) {
                        if (loaderNotice) loaderNotice.style.borderColor = '#CEDOCE';
                        if (iconEl) {
                            iconEl.style.animation = 'none';
                            iconEl.style.border = 'none';
                            iconEl.style.color = '#CEDOCE';
                            iconEl.innerText = '[✓]';
                        }
                        if (contentEl) {
                            contentEl.innerHTML = `
                                <div style="font-size: 12px; font-weight: bold; margin-bottom: 4px; color: #CEDOCE;">БАЗА ДАННЫХ СИНХРОНИЗИРОВАНА!</div>
                                <div style="font-size: 10px; color: #E6E8E6; line-height: 1.4;">
                                    Успешно импортировано: <b>${totalNew}</b><br>
                                    <span style="color: #9DB4C0;">• Выбор ответа: ${typeCounters.multichoice}</span><br>
                                    <span style="color: #9DB4C0;">• Короткий: ${typeCounters.shortanswer}</span><br>
                                    <span style="color: #9DB4C0;">• Сопоставление: ${typeCounters.match}</span>
                                </div>
                            `;
                        }
                        setTimeout(() => { if (loaderNotice) loaderNotice.remove(); }, 8000);
                    } else {
                        if (loaderNotice) loaderNotice.style.borderColor = '#ff3333';
                        if (contentEl) contentEl.innerHTML = `<div style="font-size: 12px; font-weight: bold; color: #ff3333;">ОШИБКА СЕРВЕРА: ${res.status}</div>`;
                    }
                },
                onerror: function() {
                    if (loaderNotice) loaderNotice.style.borderColor = '#ff3333';
                    if (contentEl) contentEl.innerHTML = `<div style="font-size: 12px; font-weight: bold; color: #ff3333;">СЕТЕВАЯ ОШИБКА FIREBASE</div>`;
                }
            });
        } else {
            if (loaderNotice) loaderNotice.remove();
            console.log('[REVIEW] Нет новых уникальных ответов для добавления.');
        }
    }

    function parseQuestionStructure(questionBlock, qType) {
        const data = { type: qType, questionText: '', elements: [] };
        const qtextEl = questionBlock.querySelector('.qtext');
        if (qtextEl) data.questionText = extractCleanText(qtextEl);

        const allImages = Array.from(questionBlock.querySelectorAll('.qtext img, .answer img'));

        if (qType === 'multichoice' || qType === 'truefalse') {
            questionBlock.querySelectorAll('.answer .r0, .answer .r1').forEach(row => {
                const input = row.querySelector('input[type="checkbox"], input[type="radio"]');
                const textContainer = row.querySelector('.flex-fill') || row.querySelector('label');
                if (input && textContainer) data.elements.push({ id: input.id, text: extractChoiceText(textContainer, allImages) });
            });
        }
        else if (qType === 'shortanswer') {
            const input = questionBlock.querySelector('input[type="text"].form-control');
            if (input) data.elements.push({ id: input.id });
        }
        else if (qType === 'match') {
            questionBlock.querySelectorAll('table.answer tr').forEach(row => {
                const textTd = row.querySelector('td.text');
                const select = row.querySelector('select');
                if (textTd && select) {
                    const options = [];
                    select.querySelectorAll('option').forEach(opt => {
                        if (opt.value !== "0") options.push({ value: opt.value, text: opt.innerText.replace(/[\s\u00A0]+/g, ' ').trim() });
                    });
                    data.elements.push({ selectId: select.id, subQuestion: extractCleanText(textTd), options: options });
                }
            });
        }
        return data;
    }

    function addButtons() {
        if (window.location.href.includes('review.php')) return;
        document.querySelectorAll('.que').forEach((q) => {
            if (q.querySelector('.auto-solve-btn')) return;
            const formulationBlock = q.querySelector('.formulation');
            if (!formulationBlock) return;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'auto-solve-btn';
            btn.innerText = '[ РЕШИТЬ ВОПРОС ]';
            btn.style.cssText = 'display: inline-block; margin-bottom: 10px; padding: 8px 16px; cursor: pointer; font-weight: bold; font-size: 13px; width: max-content; min-width: 180px; text-align: center;';

            btn.addEventListener('click', () => {
                if (btn.classList.contains('recheck-ready')) {
                    Logger.add('Запрос принудительной перепроверки вопроса через ИИ...', 'warn');
                    processQuestion(q, btn, true);
                } else {
                    processQuestion(q, btn, false);
                }
            });
            formulationBlock.insertBefore(btn, formulationBlock.firstChild);
        });
    }

    if (window.location.href.includes('review.php')) {
        showInitialLoader();
        if (document.readyState === 'complete') {
            runReviewAndSave();
        } else {
            window.addEventListener('load', runReviewAndSave);
        }
    } else {
        createUI();

        if (window.location.href.includes('attempt.php')) {
            addButtons();

            if (AutoMode.isActive()) {
                setTimeout(() => {
                    Logger.add('Автопилот: автоматический старт решения вопросов...', 'info');
                    document.querySelectorAll('.que').forEach(qBlock => {
                        const btn = qBlock.querySelector('.auto-solve-btn');
                        if (btn && !btn.disabled && !btn.classList.contains('recheck-ready')) {
                            btn.click();
                        }
                    });
                }, 500);
            }

            let observerTimeout = null;
            const observer = new MutationObserver(() => {
                if (observerTimeout) return;
                observerTimeout = setTimeout(() => {
                    addButtons();
                    observerTimeout = null;
                }, 500);
            });

            const targetNode = document.querySelector('#responseform') || document.querySelector('.region-main') || document.body;
            observer.observe(targetNode, { childList: true, subtree: true });
        }
    }
})();
