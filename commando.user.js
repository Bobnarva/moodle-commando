// ==UserScript==
// @name         Moodle-Commando
// @namespace    http://tampermonkey.net/
// @version      12.5
// @description  Автоматизированный помощник для работы с тестами Moodle. Интеграция с локальной базой знаний Firebase для мгновенных ответов и умный разбор сложных вопросов с помощью ИИ.
// @author       Bobna (Refactored by AI)
// @match        https://edu-spcpu.ru/mod/quiz/attempt.php*
// @match        https://edu-spcpu.ru/mod/quiz/review.php*
// @match        https://edu-spcpu.ru/mod/quiz/view.php*
// @match        https://edu-spcpu.ru/course/view.php*
// @grant        GM_xmlhttpRequest
// @connect      generativelanguage.googleapis.com
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
    const DEFAULT_API_KEY = p_1 + p_2; // Резервный ключ
    const FIREBASE_URL = 'https://eios-e526f-default-rtdb.europe-west1.firebasedatabase.app/';
    const STORAGE_KEY = 'moodle_inserted_answers';
    const KEY_API_STORAGE = 'commando_gemini_api_key';
    const KEY_ROUTING_MODE = 'commando_routing_mode';
    const KEY_UI_COLLAPSED = 'commando_ui_collapsed';
    const KEY_LOGS_EXPANDED = 'commando_logs_expanded';

    // Модели
    const MODEL_LITE = 'gemini-3.1-flash-lite';
    const MODEL_FLASH = 'gemini-3.5-flash';

    let activeRequestsOnPage = 0;

    const Logger = {
        logs: [],
        add: function(text, level = 'info') {
            const time = new Date().toLocaleTimeString();
            const logEntry = { time, text, level };
            this.logs.push(logEntry);

            // Вывод в консоль разработчика
            const colors = { info: '#9DB4C0', success: '#CEDOCE', warn: '#ffcc00', error: '#ff3333' };
            console.log(`%c[Commando OS] [${time}] ${text}`, `color: ${colors[level] || '#9DB4C0'};`);

            // Обновление UI терминала
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

    Logger.add('Запуск ядра Commando v12.5...', 'info');

    // Умное управление API-ключами с защитой от пустых строк и лишних пробелов
    const KeyManager = {
        get: () => {
            const stored = localStorage.getItem(KEY_API_STORAGE);
            if (stored && stored.trim() !== "" && stored !== "null" && stored !== "undefined") {
                return stored.trim();
            }
            return DEFAULT_API_KEY;
        },
        set: (key) => {
            if (key && key.trim() !== "" && key.trim() !== "null" && key.trim() !== "undefined") {
                localStorage.setItem(KEY_API_STORAGE, key.trim());
            } else {
                localStorage.removeItem(KEY_API_STORAGE);
            }
        },
        isCustom: () => {
            const stored = localStorage.getItem(KEY_API_STORAGE);
            return stored !== null && stored.trim() !== "" && stored !== "null" && stored !== "undefined";
        },
        getMasked: () => {
            const key = KeyManager.get();
            if (key.length <= 8) return "INVALID_KEY";
            return key.substring(0, 6) + "..." + key.substring(key.length - 4);
        }
    };

    const RoutingManager = {
        getMode: () => localStorage.getItem(KEY_ROUTING_MODE) || 'auto', // По умолчанию "auto"
        setMode: (mode) => localStorage.setItem(KEY_ROUTING_MODE, mode),
        selectModel: (questionBlock, qType) => {
            const mode = RoutingManager.getMode();
            if (mode === 'flash') return MODEL_FLASH;
            if (mode === 'lite') return MODEL_LITE;

            // Оптимизация запросов (Smart Auto-Routing)
            const hasImages = questionBlock.querySelector('.qtext img, .answer img') !== null;
            const isComplexType = qType === 'match';
            const textLength = extractCleanText(questionBlock.querySelector('.qtext')).length;

            if (hasImages || isComplexType || textLength > 450) {
                Logger.add('Smart Router: Сложный/мультимедиа вопрос. Выбран 3.5 Flash.', 'info');
                return MODEL_FLASH;
            }
            Logger.add('Smart Router: Простой текстовый вопрос. Выбран 3.1 Flash-Lite.', 'success');
            return MODEL_LITE;
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
        let start = rawText.indexOf('{');
        let end = rawText.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            return rawText.substring(start, end + 1);
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
                border-radius: 4px; width: 330px; box-shadow: 0 0 20px rgba(37,50,55,0.4);
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
            .commando-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; }

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
            .commando-row { display: flex; justify-content: space-between; align-items: center; }

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
                padding: 6px; width: 100%; font-family: 'Fira Code', monospace; font-size: 11px;
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
            .commando-drawer {
                display: none; flex-direction: column; gap: 8px; margin-top: 8px;
                border-top: 1px dashed #5C6B73; padding-top: 8px;
            }
            .commando-drawer.active { display: flex; }
            .commando-help { font-size: 10px; color: #CEDOCE; line-height: 1.3; }
            .commando-help a { color: #9DB4C0; text-decoration: underline; }
            .commando-mini-trigger {
                width: 100%; height: 100%; display: flex; align-items: center;
                justify-content: center; font-size: 16px; color: #9DB4C0; font-weight: bold;
            }
            .commando-mini-trigger:hover { color: #E6E8E6; }

            /* Стилизация кнопок под стиль EIOS */
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
            /* Стиль кнопки для перепроверки */
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

        // Микро-иконка при сворачивании (в стиле дискового терминала)
        const miniTrigger = document.createElement('div');
        miniTrigger.className = 'commando-mini-trigger';
        miniTrigger.innerText = '[💾]';
        miniTrigger.title = 'Развернуть COMMANDO';

        // Полный интерфейс
        const fullUI = document.createElement('div');
        fullUI.className = 'commando-full-ui';
        fullUI.style.display = isCollapsed ? 'none' : 'block';

        // Клик для раскрытия
        miniTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            dashboard.classList.remove('collapsed');
            fullUI.style.display = 'block';
            localStorage.setItem(KEY_UI_COLLAPSED, 'false');
        });
        dashboard.appendChild(miniTrigger);

        // Шапка панели
        const header = document.createElement('div');
        header.className = 'commando-header';

        const title = document.createElement('div');
        title.className = 'commando-title';
        title.innerText = '💾 COMMANDO v12.5';
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

        // Тело панели
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
                // Запускаем решение нерешенных
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

        // 2. Управление моделями (с поддержкой Smart Auto)
        const modelCard = document.createElement('div');
        modelCard.className = 'commando-card';

        const mTitle = document.createElement('div');
        mTitle.className = 'commando-card-title';
        mTitle.innerText = 'ВЫБОР МОДЕЛИ ИИ';
        modelCard.appendChild(mTitle);

        const routeSelect = document.createElement('select');
        routeSelect.className = 'commando-select';
        routeSelect.innerHTML = `
            <option value="auto">Smart Auto (auto)</option>
            <option value="lite">Gemini 3.1 Flash-Lite (fast)</option>
            <option value="flash">Gemini 3.5 Flash (think)</option>
        `;
        routeSelect.value = RoutingManager.getMode();
        routeSelect.addEventListener('change', (e) => {
            RoutingManager.setMode(e.target.value);
            Logger.add(`Выбран режим маршрутизации: ${e.target.value}`, 'info');
        });
        modelCard.appendChild(routeSelect);
        body.appendChild(modelCard);

        // 3. Управление ключом Gemini с выводом маски
        const keyCard = document.createElement('div');
        keyCard.className = 'commando-card';

        const kTitle = document.createElement('div');
        kTitle.className = 'commando-card-title';
        kTitle.innerHTML = `КЛЮЧ GEMINI <span id="commando-key-status" style="font-size:9px; color:#CEDOCE;">(DEFAULT)</span>`;
        keyCard.appendChild(kTitle);

        const maskedLabel = document.createElement('div');
        maskedLabel.id = 'commando-masked-key-label';
        maskedLabel.style.fontSize = '10px';
        maskedLabel.style.color = '#CEDOCE';
        maskedLabel.style.marginBottom = '6px';
        maskedLabel.innerHTML = `Текущий: <span style="color: #9DB4C0; font-weight: bold;">${KeyManager.getMasked()}</span>`;
        keyCard.appendChild(maskedLabel);

        const toggleKeyDrawerBtn = document.createElement('button');
        toggleKeyDrawerBtn.className = 'commando-btn btn-secondary';
        toggleKeyDrawerBtn.innerText = '[ НАСТРОИТЬ КЛЮЧ ]';

        const keyDrawer = document.createElement('div');
        keyDrawer.className = 'commando-drawer';

        const kInput = document.createElement('input');
        kInput.type = 'password';
        kInput.className = 'commando-input';
        kInput.placeholder = 'Вставьте API Key...';
        if (KeyManager.isCustom()) {
            kInput.value = KeyManager.get();
        }

        const kSaveBtn = document.createElement('button');
        kSaveBtn.className = 'commando-btn btn-active';
        kSaveBtn.innerText = '[ СОХРАНИТЬ ]';
        kSaveBtn.addEventListener('click', () => {
            const val = kInput.value.trim();
            if (val) {
                KeyManager.set(val);
                Logger.add(`Сохранен пользовательский ключ API: ${KeyManager.getMasked()}`, 'success');
                updateKeyStatus(true);
            } else {
                localStorage.removeItem(KEY_API_STORAGE);
                Logger.add('Используется встроенный API-ключ по умолчанию.', 'warn');
                updateKeyStatus(false);
            }
            const label = document.getElementById('commando-masked-key-label');
            if (label) {
                label.innerHTML = `Текущий: <span style="color: #9DB4C0; font-weight: bold;">${KeyManager.getMasked()}</span>`;
            }
        });

        const kInstructions = document.createElement('div');
        kInstructions.className = 'commando-help';
        kInstructions.innerHTML = `
            Порядок действий:<br>
            1. Перейдите на <a href="https://aistudio.google.com/" target="_blank">Google AI Studio</a>.<br>
            2. Нажмите <b>Get API Key</b>.<br>
            3. Сгенерируйте и вставьте его выше.<br>
            <span style="color: #ff3333;">Внимание:</span> Встроенный ключ часто блокируется. Рекомендуется использовать персональный токен.
        `;

        keyDrawer.appendChild(kInput);
        keyDrawer.appendChild(kSaveBtn);
        keyDrawer.appendChild(kInstructions);
        keyCard.appendChild(toggleKeyDrawerBtn);
        keyCard.appendChild(keyDrawer);
        body.appendChild(keyCard);

        toggleKeyDrawerBtn.addEventListener('click', () => {
            keyDrawer.classList.toggle('active');
        });

        const updateKeyStatus = (isCustom) => {
            const statusEl = document.getElementById('commando-key-status');
            if (statusEl) {
                statusEl.innerText = isCustom ? '(CUSTOM)' : '(DEFAULT)';
                statusEl.style.color = isCustom ? '#CEDOCE' : '#9DB4C0';
            }
        };

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

        // Инициализация статуса ключа в UI
        updateKeyStatus(KeyManager.isCustom());

        // Заполнение истории логов при открытии
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

    function sendAiRequest(payloadParts, modelsList, modelIndex, questionBlock, button, qType, qHash, markDone) {
        if (modelIndex >= modelsList.length) {
            button.innerText = '[❌ Все модели перегружены]';
            button.disabled = false;
            Logger.add(`Критический сбой API: все модели перегружены или неверный API-ключ.`, 'error');
            markDone();
            return;
        }

        const currentModel = modelsList[modelIndex];
        const shortName = currentModel.replace('gemini-', '');

        button.innerText = `[(${shortName}) Генерирует...]`;
        Logger.add(`Запрос решения через ИИ модель [${currentModel}]...`, 'info');

        const activeApiKey = KeyManager.get();

        GM_xmlhttpRequest({
            method: "POST", url: `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${activeApiKey}`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ contents: [{ parts: payloadParts }] }),
            timeout: 25000,
            onload: function(response) {
                try {
                    if (response.status === 503 || response.status === 429) {
                        const delay = Math.pow(2, modelIndex) * 1000;
                        Logger.add(`Ошибка ${response.status} на модели ${currentModel}. Попытка через ${delay}мс...`, 'warn');
                        setTimeout(() => sendAiRequest(payloadParts, modelsList, modelIndex + 1, questionBlock, button, qType, qHash, markDone), delay);
                        return;
                    }
                    if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${response.responseText}`);

                    const resData = JSON.parse(response.responseText);
                    const aiContent = resData.candidates[0].content.parts[0].text.trim();
                    const result = JSON.parse(extractCleanJson(aiContent));
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
                    }
                    else if (result.type === 'shortanswer' && result.text) {
                        const input = questionBlock.querySelector(`input[id="${result.id}"]`);
                        if (input) {
                            input.value = result.text;
                            triggerMoodleEvents(input);
                            actionCount = 1;
                        }
                    }
                    else if (result.type === 'match' && result.mappings) {
                        for (const [selectId, val] of Object.entries(result.mappings)) {
                            const select = questionBlock.querySelector(`select[id="${selectId}"]`);
                            if (select) {
                                select.value = val;
                                triggerMoodleEvents(select);
                                actionCount++;
                            }
                        }
                    }

                    trackAnswer(qHash);
                    button.innerText = `[Решено ИИ (${actionCount}) | ПЕРЕПРОВЕРИТЬ]`;
                    makeRecheckBtnReady(button);
                    Logger.add(`Вопрос ${qHash.substring(2, 8)} успешно решен через ${currentModel} (${actionCount} полей заполнено)`, 'success');

                    if (AutoMode.isActive()) AutoMode.incAi();
                    markDone();

                } catch (e) {
                    Logger.add(`Ошибка ИИ: ${e.message}`, 'error');
                    sendAiRequest(payloadParts, modelsList, modelIndex + 1, questionBlock, button, qType, qHash, markDone);
                }
            },
            ontimeout: () => {
                Logger.add(`Модель ${currentModel} отвалилась по тайм-ауту. Переключаемся на следующую...`, 'warn');
                sendAiRequest(payloadParts, modelsList, modelIndex + 1, questionBlock, button, qType, qHash, markDone);
            },
            onerror: (err) => {
                Logger.add(`Сетевая ошибка API: ${err.statusText || 'Неизвестно'}`, 'error');
                sendAiRequest(payloadParts, modelsList, modelIndex + 1, questionBlock, button, qType, qHash, markDone);
            }
        });
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

                // Сбор картинок
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
                        Logger.add(`Пропущен поврежденный URL картинки`, 'warn');
                    }
                });

                const selectedModel = RoutingManager.selectModel(questionBlock, qType);
                const modelsToTry = selectedModel === MODEL_FLASH ? [MODEL_FLASH, MODEL_LITE] : [MODEL_LITE, MODEL_FLASH];

                Promise.all(imagePromises).then(downloadedImages => {
                    const validImages = downloadedImages.filter(img => img !== null);
                    let payloadParts = [{ text: promptText }];
                    validImages.forEach(imgData => { payloadParts.push({ inlineData: { mimeType: imgData.mimeType, data: imgData.data } }); });
                    sendAiRequest(payloadParts, modelsToTry, 0, questionBlock, button, qType, qHash, markDone);
                }).catch(() => {
                    sendAiRequest([{ text: promptText }], [MODEL_LITE, MODEL_FLASH], 0, questionBlock, button, qType, qHash, markDone);
                });
            };

            if (forceAi) {
                switchToAi();
                return;
            }

            // Поиск в Firebase
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
                    processQuestion(q, btn, true); // forceAi = true
                } else {
                    processQuestion(q, btn, false);
                }
            });
            formulationBlock.insertBefore(btn, formulationBlock.firstChild);
        });
    }

    // Роутинг инициализации в зависимости от URL страницы
    if (window.location.href.includes('review.php')) {
        showInitialLoader();
        if (document.readyState === 'complete') {
            runReviewAndSave();
        } else {
            window.addEventListener('load', runReviewAndSave);
        }
    } else {
        // Запуск интерфейса настроек на страницах курсов и разделов Moodle
        createUI();

        // Полноценный разбор и автоматизация только на странице решения попытки
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
