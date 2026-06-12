// ==UserScript==
// @name         Moodle-Commando
// @namespace    http://tampermonkey.net/
// @version      10.9
// @description  Автоматизированный помощник для работы с тестами Moodle. Интеграция с локальной базой знаний Firebase для мгновенных ответов и умный разбор сложных вопросов с помощью моделей ИИ Gemini.
// @author       Bobna
// @match        https://edu-spcpu.ru/mod/quiz/attempt.php*
// @match        https://edu-spcpu.ru/mod/quiz/review.php*
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

    // ================== НАСТРОЙКИ ==================
    const _p1 = 'QVEuQWI4Uk42TFhFaVRNMWNteTJMYVNmTldMT2Q2Vnpw';
    const _p2 = 'LVAtMW5tZWtPYUg0MDM4UDY4OGc=';

    const API_KEY = atob(_p1 + _p2);

    const FIREBASE_URL = 'https://eios-e526f-default-rtdb.europe-west1.firebasedatabase.app/';
    const STORAGE_KEY = 'moodle_inserted_answers';
    // ===============================================

    const TEXT_ONLY_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.1-flash'];
    const MULTIMODAL_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.1-flash'];

    let activeRequestsOnPage = 0;

    console.log('%c[Moodle Commando v10.9] Ранний старт интерфейса активирован.', 'color: #007bff; font-weight: bold;');

    // --- СЕРВИСНЫЕ ФУНКЦИИ АВТОХОДА И СТАТИСТИКИ ---
    const AutoMode = {
        isActive: () => sessionStorage.getItem('commando_auto_active') === 'true',
        start: () => {
            sessionStorage.setItem('commando_auto_active', 'true');
            sessionStorage.setItem('commando_stat_db', '0');
            sessionStorage.setItem('commando_stat_ai', '0');
        },
        stop: () => sessionStorage.setItem('commando_auto_active', 'false'),
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

    function getQuestionHash(questionBlock) {
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

        let hash = 0;
        for (let i = 0; i < baseText.length; i++) {
            hash = ((hash << 5) - hash) + baseText.charCodeAt(i);
            hash |= 0;
        }
        return 'q_' + Math.abs(hash);
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
        let jsonCandidate = rawText;
        let codeBlockMatch = rawText.match(/```json\s*([\s\S]*?)\s*```/) || rawText.match(/```\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch) jsonCandidate = codeBlockMatch[1];
        let firstBrace = jsonCandidate.indexOf('{');
        let lastBrace = jsonCandidate.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) return jsonCandidate.substring(firstBrace, lastBrace + 1);
        throw new Error("No valid JSON found");
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
            finishNotice.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 999999; background: #222; color: #fff; border-left: 4px solid #007bff; border-radius: 4px; padding: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.3); font-family: Arial, sans-serif; width: 320px; cursor: pointer;';
            finishNotice.innerHTML = `
                <div style="font-size: 13px; font-weight: bold; margin-bottom: 5px; color: #007bff;">🏁 Автопрохождение завершено!</div>
                <div style="font-size: 11px; color: #ccc; line-height: 1.4;">
                    • Из базы знаний подтянуто: <b>${stats.db}</b><br>
                    • Сгенерировано через ИИ: <b>${stats.ai}</b>
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
        loaderNotice.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 999999; background: #222; color: #fff; border-left: 4px solid #fd7e14; border-radius: 4px; padding: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.3); font-family: Arial, sans-serif; width: 320px; display: flex; align-items: flex-start; gap: 12px; transition: all 0.3s; cursor: pointer;';

        loaderNotice.innerHTML = `
            <div id="commando-notice-icon" style="min-width: 18px; height: 18px; border: 3px solid #444; border-top: 3px solid #fd7e14; border-radius: 50%; display: inline-block; animation: commando-spin 1s linear infinite; margin-top: 2px;"></div>
            <div id="commando-notice-content">
                <div style="font-size: 13px; font-weight: bold; margin-bottom: 2px; color: #fd7e14;">Анализ Commando...</div>
                <div style="font-size: 11px; color: #ccc; line-height: 1.3;">Проверяем результаты теста и структуру вопросов.</div>
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

    // =========================================================================
    // ЭТАП 1: СБОР СТАТИСТИКИ (REVIEW.PHP) — С ПРАВКАМИ ПАРСИНГА ТИПОВ ДАННЫХ
    // =========================================================================
    function runReviewAndSave() {
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

        document.querySelectorAll('.que.incorrect').forEach(qBlock => {
            const qHash = getQuestionHash(qBlock);
            if (trackedAnswers[qHash]) {
                GM_xmlhttpRequest({ method: "DELETE", url: `${FIREBASE_URL}questions/${qHash}.json`, onload: () => untrackAnswer(qHash) });
            }
        });

        let batchData = {};

        document.querySelectorAll('.que.correct').forEach(qBlock => {
            let qType = 'unknown';
            if (qBlock.classList.contains('multichoice')) qType = 'multichoice';
            else if (qBlock.classList.contains('truefalse')) qType = 'truefalse';
            else if (qBlock.classList.contains('shortanswer') || qBlock.classList.contains('numerical')) qType = 'shortanswer';
            else if (qBlock.classList.contains('match')) qType = 'match';

            if (qType === 'unknown') return;
            const qHash = getQuestionHash(qBlock);
            let answers = null;

            if (qType === 'shortanswer') {
                const rightAnswerEl = qBlock.querySelector('.outcome .rightanswer');
                if (rightAnswerEl) {
                    answers = rightAnswerEl.innerText.replace(/Правильный\s+ответ:\s*/i, '').trim();
                } else {
                    // ПРАВКА №1: Если блока .rightanswer нет, берем значение прямо из заполненного инпута
                    const inputEl = qBlock.querySelector('input[type="text"].form-control');
                    if (inputEl && inputEl.value.trim() !== '') {
                        answers = inputEl.value.trim();
                    }
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
                    // ПРАВКА №2: Проверяем не только .checked, но и классы разметки правильного ответа Moodle
                    const isMoodleCorrect = row.classList.contains('correct') || row.querySelector('.fa-check, .text-success');
                    const isPhysicallyChecked = input && (input.checked || input.getAttribute('checked') === 'checked');
                    
                    if (isPhysicallyChecked || isMoodleCorrect) {
                        let textEl = row.querySelector('.flex-fill') || row.querySelector('label');
                        if (textEl && (isMoodleCorrect || qBlock.classList.contains('correct'))) {
                            checkedTexts.push(extractCleanText(textEl));
                        }
                    }
                });
                if (checkedTexts.length > 0) answers = checkedTexts;
            }

            if (answers) {
                batchData[qHash] = { type: qType, questionText: extractCleanText(qBlock.querySelector('.qtext')), answers: answers };
                untrackAnswer(qHash);
            }
        });

        let totalNew = Object.keys(batchData).length;

        if (totalNew > 0) {
            let typeCounters = { multichoice: 0, shortanswer: 0, match: 0, truefalse: 0 };
            Object.values(batchData).forEach(item => {
                if (typeCounters[item.type] !== undefined) typeCounters[item.type]++;
            });

            if (contentEl) {
                contentEl.innerHTML = `
                    <div style="font-size: 13px; font-weight: bold; margin-bottom: 2px; color: #fd7e14;">Синхронизация с базой...</div>
                    <div style="font-size: 11px; color: #ccc; line-height: 1.3;">Сохраняем ${totalNew} чистых ответов в облако.<br>Пожалуйста, не закрывайте вкладку.</div>
                `;
            }

            GM_xmlhttpRequest({
                method: "PATCH",
                url: `${FIREBASE_URL}questions.json`,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify(batchData),
                onload: function(res) {
                    if (res.status === 200) {
                        if (loaderNotice) loaderNotice.style.borderLeft = '4px solid #28a745';
                        if (iconEl) {
                            iconEl.style.animation = 'none';
                            iconEl.style.border = 'none';
                            iconEl.style.color = '#28a745';
                            iconEl.style.fontWeight = 'bold';
                            iconEl.style.fontSize = '16px';
                            iconEl.innerText = '✓';
                        }
                        if (contentEl) {
                            contentEl.innerHTML = `
                                <div style="font-size: 13px; font-weight: bold; margin-bottom: 4px; color: #28a745;">База знаний обновлена!</div>
                                <div style="font-size: 11px; color: #eee; line-height: 1.4;">
                                    Успешно залито ответов: <b>${totalNew}</b><br>
                                    <span style="color: #aaa;">• Выбор ответа: ${typeCounters.multichoice}</span><br>
                                    <span style="color: #aaa;">• Короткий/Числовой: ${typeCounters.shortanswer}</span><br>
                                    <span style="color: #aaa;">• Сопоставление: ${typeCounters.match}</span><br>
                                    <span style="color: #aaa;">• Верно/Неверно: ${typeCounters.truefalse}</span>
                                </div>
                            `;
                        }
                        setTimeout(() => { if (loaderNotice) loaderNotice.remove(); }, 8000);
                    } else {
                        if (loaderNotice) loaderNotice.style.borderLeft = '4px solid #dc3545';
                        if (contentEl) contentEl.innerHTML = `<div style="font-size: 13px; font-weight: bold; color: #dc3545;">Ошибка сервера: ${res.status}</div>`;
                    }
                },
                onerror: function() {
                    if (loaderNotice) loaderNotice.style.borderLeft = '4px solid #dc3545';
                    if (contentEl) contentEl.innerHTML = `<div style="font-size: 13px; font-weight: bold; color: #dc3545;">Сетевая ошибка Firebase</div>`;
                }
            });
        } else {
            if (loaderNotice) loaderNotice.remove();
            console.log('[REVIEW] Нет новых уникальных ответов для добавления.');
        }
    }

    // =========================================================================
    // ЭТАП 2: ИНТЕГРАЦИЯ И РЕШЕНИЕ (ATTEMPT.PHP)
    // =========================================================================
    function fillFromDatabase(questionBlock, dbData, button, qHash) {
        let actionCount = 0;

        if ((dbData.type === 'multichoice' || dbData.type === 'truefalse') && Array.isArray(dbData.answers)) {
            questionBlock.querySelectorAll('.answer .r0, .answer .r1').forEach(row => {
                let textEl = row.querySelector('.flex-fill') || row.querySelector('label');
                let input = row.querySelector('input[type="checkbox"], input[type="radio"]');
                if (textEl && input && dbData.answers.includes(extractCleanText(textEl))) {
                    if (!input.checked) { input.click(); actionCount++; }
                }
            });
        }
        else if (dbData.type === 'shortanswer' && dbData.answers) {
            let input = questionBlock.querySelector('input[type="text"].form-control');
            if (input) {
                input.value = dbData.answers;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
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
                                select.dispatchEvent(new Event('change', { bubbles: true }));
                                actionCount++;
                                break;
                            }
                        }
                    }
                }
            });
        }

        trackAnswer(qHash);
        button.innerText = `🔷 Из Базы Знаний (${actionCount})`;
        button.style.backgroundColor = '#17a2b8';

        if (AutoMode.isActive()) AutoMode.incDb();
        activeRequestsOnPage--;
        checkPageCompletion();
    }

    function parseQuestionStructure(questionBlock, qType) {
        const data = { type: qType, questionText: '', elements: [] };
        const qtextEl = questionBlock.querySelector('.qtext');
        if (qtextEl) data.questionText = extractCleanText(qtextEl);

        if (qType === 'multichoice' || qType === 'truefalse') {
            questionBlock.querySelectorAll('.answer .r0, .answer .r1').forEach(row => {
                const input = row.querySelector('input[type="checkbox"], input[type="radio"]');
                const textContainer = row.querySelector('.flex-fill') || row.querySelector('label');
                if (input && textContainer) data.elements.push({ id: input.id, text: extractCleanText(textContainer) });
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

    function sendAiRequest(payloadParts, modelsList, modelIndex, questionBlock, button, qType, qHash) {
        if (modelIndex >= modelsList.length) {
            button.innerText = '❌ Все модели перегружены';
            button.style.backgroundColor = '#dc3545';
            button.disabled = false;
            activeRequestsOnPage--;
            checkPageCompletion();
            return;
        }

        const currentModel = modelsList[modelIndex];
        const shortName = currentModel.replace('gemini-', '');

        button.innerText = `(${shortName}) генерирует...`;
        button.style.backgroundColor = '#fd7e14';

        GM_xmlhttpRequest({
            method: "POST", url: `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${API_KEY}`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ contents: [{ parts: payloadParts }] }),
            timeout: 25000,
            onload: function(response) {
                try {
                    if (response.status === 503 || response.status === 429) {
                        sendAiRequest(payloadParts, modelsList, modelIndex + 1, questionBlock, button, qType, qHash);
                        return;
                    }
                    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);

                    const resData = JSON.parse(response.responseText);
                    const aiContent = resData.candidates[0].content.parts[0].text.trim();
                    const result = JSON.parse(extractCleanJson(aiContent));
                    let actionCount = 0;

                    if ((result.type === 'multichoice' || result.type === 'truefalse') && Array.isArray(result.answers)) {
                        result.answers.forEach(id => {
                            const input = questionBlock.querySelector(`input[id="${id}"]`);
                            if (input && !input.checked) { input.click(); actionCount++; }
                        });
                    }
                    else if (result.type === 'shortanswer' && result.text) {
                        const input = questionBlock.querySelector(`input[id="${result.id}"]`);
                        if (input) {
                            input.value = result.text;
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            input.dispatchEvent(new Event('change', { bubbles: true }));
                            actionCount = 1;
                        }
                    }
                    else if (result.type === 'match' && result.mappings) {
                        for (const [selectId, val] of Object.entries(result.mappings)) {
                            const select = questionBlock.querySelector(`select[id="${selectId}"]`);
                            if (select) { select.value = val; select.dispatchEvent(new Event('change', { bubbles: true })); actionCount++; }
                        }
                    }

                    trackAnswer(qHash);
                    button.innerText = `Решено ИИ (${actionCount}) [Возможны неточности]`;
                    button.style.backgroundColor = '#28a745';

                    if (AutoMode.isActive()) AutoMode.incAi();
                    activeRequestsOnPage--;
                    checkPageCompletion();

                } catch (e) {
                    sendAiRequest(payloadParts, modelsList, modelIndex + 1, questionBlock, button, qType, qHash);
                }
            },
            ontimeout: () => sendAiRequest(payloadParts, modelsList, modelIndex + 1, questionBlock, button, qType, qHash),
            onerror: () => sendAiRequest(payloadParts, modelsList, modelIndex + 1, questionBlock, button, qType, qHash)
        });
    }

    function processQuestion(questionBlock, button) {
        let qType = 'unknown';
        if (questionBlock.classList.contains('multichoice')) qType = 'multichoice';
        else if (questionBlock.classList.contains('truefalse')) qType = 'truefalse';
        else if (questionBlock.classList.contains('shortanswer') || questionBlock.classList.contains('numerical')) qType = 'shortanswer';
        else if (questionBlock.classList.contains('match')) qType = 'match';

        if (qType === 'unknown') return;

        activeRequestsOnPage++;
        const qHash = getQuestionHash(questionBlock);

        button.disabled = true;
        button.innerText = '🔍 Поиск в БД...';

        const switchToAi = () => {
            button.innerText = '📷 Сбор структуры...';
            const qData = parseQuestionStructure(questionBlock, qType);

            let promptText = `Ты — экспертный ИИ-модуль тестирования. Реши задачу и выведи результат СТРОГО в формате JSON без какого-либо другого текста вокруг.\n\n`;

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

            const imgElements = questionBlock.querySelectorAll('.qtext img');
            let imagePromises = [];
            imgElements.forEach(img => {
                let src = img.getAttribute('src');
                if (src) imagePromises.push(fetchImageAsBase64(new URL(src, document.baseURI).href));
            });

            Promise.all(imagePromises).then(downloadedImages => {
                let payloadParts = [{ text: promptText }];
                downloadedImages.forEach(imgData => { payloadParts.push({ inlineData: { mimeType: imgData.mimeType, data: imgData.data } }); });
                sendAiRequest(payloadParts, downloadedImages.length > 0 ? MULTIMODAL_MODELS : TEXT_ONLY_MODELS, 0, questionBlock, button, qType, qHash);
            }).catch(() => {
                sendAiRequest([{ text: promptText }], TEXT_ONLY_MODELS, 0, questionBlock, button, qType, qHash);
            });
        };

        GM_xmlhttpRequest({
            method: "GET",
            url: `${FIREBASE_URL}questions/${qHash}.json`,
            timeout: 10000,
            onload: function(response) {
                if (response.status === 200 && response.responseText !== 'null') {
                    fillFromDatabase(questionBlock, JSON.parse(response.responseText), button, qHash);
                } else {
                    switchToAi();
                }
            },
            onerror: switchToAi,
            ontimeout: switchToAi
        });
    }

    // --- ОСТАЛЬНАЯ ЛОГИКА ИНТЕРФЕЙСА ---
    function addButtons() {
        if (window.location.href.includes('review.php')) return;
        document.querySelectorAll('.que').forEach((q) => {
            if (q.querySelector('.auto-solve-btn')) return;
            const formulationBlock = q.querySelector('.formulation');
            if (!formulationBlock) return;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'auto-solve-btn';
            btn.innerText = 'Решить вопрос';
            btn.style.cssText = 'display: inline-block; margin-bottom: 10px; padding: 8px 16px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 13px; width: max-content; min-width: 180px; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1);';

            btn.addEventListener('click', () => processQuestion(q, btn));
            formulationBlock.insertBefore(btn, formulationBlock.firstChild);
        });
    }

    function createFloatingPanel() {
        if (window.location.href.includes('review.php')) return;
        if (document.getElementById('commando-autopilot-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'commando-autopilot-panel';
        panel.style.cssText = 'position: fixed; top: 15px; right: 15px; z-index: 999999; background: #fff; border: 2px solid #bae1f7; border-radius: 8px; padding: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); font-family: Arial, sans-serif; display: flex; flex-direction: column; gap: 8px; min-width: 240px;';

        const title = document.createElement('div');
        title.innerText = 'Autopilot';
        title.style.cssText = 'font-weight: bold; font-size: 14px; color: #333; border-bottom: 1px solid #ddd; padding-bottom: 5px;';
        panel.appendChild(title);

        const disclaimer = document.createElement('div');
        disclaimer.innerText = 'Автоматический запуск прохождения тестов.';
        disclaimer.style.cssText = 'font-size: 11px; color: #666;';
        panel.appendChild(disclaimer);

        document.body.appendChild(panel);
    }

    function updateFloatingPanel() {
        // Заглушка обновления состояния панели автопилота при необходимости
    }

    // --- ИНИЦИАЛИЗАЦИЯ СКРИПТА ---
    if (window.location.href.includes('review.php')) {
        showInitialLoader();
        if (document.readyState === 'complete') {
            runReviewAndSave();
        } else {
            window.addEventListener('load', runReviewAndSave);
        }
    } else if (window.location.href.includes('attempt.php')) {
        addButtons();
        createFloatingPanel();
        
        // Наблюдатель на случай динамической подгрузки вопросов Moodle (AJAX)
        const observer = new MutationObserver(() => {
            addButtons();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }
})();
