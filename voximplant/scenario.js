/**
 * SalesAgent AI — VoxEngine сценарий для Voximplant
 *
 * Устанавливает: Voximplant Console → Applications → salesagent → Scenarios
 * Версия: 2.0 (WebSocket + Gemini Live)
 *
 * Поток аудио:
 *   Клиент ──μ-law 8kHz──> VoxEngine ──WebSocket──> SalesAgent API
 *                                                        │
 *   Клиент <──μ-law 8kHz── VoxEngine <──WebSocket── Gemini Live
 */

// ─── Конфигурация ─────────────────────────────────────────────────────────────
// ЗАМЕНИТЬ на реальный URL после запуска туннеля (scripts/start-tunnel.mjs)
var SALESAGENT_WS_URL = VoxEngine.customData() || 'wss://salesagent-ai-db4fkn.loca.lt/ws/voice';

var WELCOME_AUDIO = 'https://cdn.jsdelivr.net/gh/niklasf/stockfish.js@master/tests/silence.mp3'; // тишина пока подключается WS

// ─── Переменные состояния ─────────────────────────────────────────────────────
var call = null;
var ws   = null;
var sessionId = null;
var isWsReady = false;
var audioQueue = [];

// ─── Точка входа ──────────────────────────────────────────────────────────────
VoxEngine.addEventListener(AppEvents.CallAlerting, function(e) {
    call      = e.call;
    sessionId = call.id();

    var callerPhone = call.callerid() || 'unknown';
    var wsUrl = SALESAGENT_WS_URL + '?callId=' + sessionId + '&phone=' + encodeURIComponent(callerPhone);

    Logger.write('[SalesAgent] Incoming call from ' + callerPhone + ', session=' + sessionId);
    Logger.write('[SalesAgent] Connecting WebSocket: ' + wsUrl);

    // ── Подключаем WebSocket к нашему серверу ──────────────────────────────
    ws = Net.createWebSocket(wsUrl, [], null);

    ws.addEventListener(WebSocketEvents.OPEN, function() {
        Logger.write('[SalesAgent] WebSocket connected, answering call');
        isWsReady = true;

        // Отвечаем на звонок
        call.answer();

        // Отправляем накопленные аудиофрагменты
        for (var i = 0; i < audioQueue.length; i++) {
            ws.sendBinaryData(audioQueue[i]);
        }
        audioQueue = [];
    });

    ws.addEventListener(WebSocketEvents.MESSAGE, function(e) {
        // Текстовые управляющие сообщения от сервера
        try {
            var msg = JSON.parse(e.text);
            if (msg.type === 'transcript') {
                Logger.write('[SalesAgent] Transcript: ' + msg.text);
            } else if (msg.type === 'hangup') {
                Logger.write('[SalesAgent] Server requested hangup');
                call.hangup();
            }
        } catch(ex) {
            // не JSON — игнорируем
        }
    });

    ws.addEventListener(WebSocketEvents.BINARY_DATA, function(e) {
        // Аудио от AI (μ-law) → воспроизводим клиенту
        if (call && e.data) {
            call.sendAudioData(e.data);
        }
    });

    ws.addEventListener(WebSocketEvents.ERROR, function(e) {
        Logger.write('[SalesAgent] WebSocket error: ' + e.text);
        call.say('Извините, произошла техническая ошибка. Попробуйте позвонить позже.', Language.RU_RUSSIAN_FEMALE);
        call.addEventListener(CallEvents.PlaybackFinished, function() {
            call.hangup();
        });
    });

    ws.addEventListener(WebSocketEvents.CLOSE, function() {
        Logger.write('[SalesAgent] WebSocket closed');
        if (call) call.hangup();
    });

    // ── Обработчики звонка ────────────────────────────────────────────────
    call.addEventListener(CallEvents.Connected, function() {
        Logger.write('[SalesAgent] Call connected, starting audio stream');

        // Поток аудио от клиента → наш WebSocket
        call.addEventListener(CallEvents.ReceivedData, function(audioEvent) {
            if (ws && audioEvent.data) {
                if (isWsReady) {
                    ws.sendBinaryData(audioEvent.data);
                } else {
                    audioQueue.push(audioEvent.data);
                }
            }
        });

        // Начинаем запись аудио в буфер для стриминга
        call.setAudioOutputMode(AudioOutputMode.CUSTOM);
        call.setAudioInputMode(AudioInputMode.CUSTOM);
    });

    call.addEventListener(CallEvents.Disconnected, function(e) {
        Logger.write('[SalesAgent] Call disconnected, reason: ' + (e.reason || 'unknown'));
        if (ws) ws.close();
        VoxEngine.terminate();
    });

    call.addEventListener(CallEvents.Failed, function(e) {
        Logger.write('[SalesAgent] Call failed: ' + e.reason);
        if (ws) ws.close();
        VoxEngine.terminate();
    });
});
