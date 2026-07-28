/**
 * SalesAgent AI — VoxEngine HTTP сценарий для Voximplant
 *
 * Устанавливает: Voximplant Console → Applications → salesagent → Scenarios
 * Версия: 3.0 (HTTP API + Voximplant ASR/TTS)
 *
 * Поток:
 *   Клиент говорит → VoxEngine ASR → текст → POST /api/voice → OpenRouter → Fish Audio MP3 → клиент слышит
 *
 * Преимущества перед WebSocket:
 *   - Работает с любым публичным HTTPS-хостингом
 *   - Не требует постоянного соединения
 *   - Проще в отладке
 */

// ─── Конфигурация ─────────────────────────────────────────────────────────────
// Custom data у правила Voximplant — JSON:
// {"apiBase":"https://your-domain","agentId":"uuid","voiceSecret":"same-as-VOICE_WEBHOOK_SECRET"}
// Секрет не храните в репозитории и не логируйте.
var customData = {};
try { customData = JSON.parse(VoxEngine.customData() || '{}'); } catch (e) { customData = {}; }
var API_BASE = customData.apiBase || '';
var AGENT_ID = customData.agentId || '';
var VOICE_SECRET = customData.voiceSecret || '';
var VOICE_API_URL = API_BASE + '/api/voice';

var LANGUAGE     = Language.RU_RUSSIAN_FEMALE;
var ASR_PROFILE  = ASRProfileList.Google.ru_RU;

// ─── Состояние сессии ──────────────────────────────────────────────────────────
var call         = null;
var sessionId    = null;
var callerPhone  = null;
var history      = [];   // [{role: 'user'|'assistant', text: '...'}]
var isProcessing = false;

// ─── Точка входа ──────────────────────────────────────────────────────────────
VoxEngine.addEventListener(AppEvents.CallAlerting, function(e) {
    call        = e.call;
    sessionId   = call.id();
    callerPhone = call.callerid() || 'unknown';

    Logger.write('[SalesAgent] Incoming call from ' + callerPhone + ', session=' + sessionId);

    call.addEventListener(CallEvents.Connected,   onCallConnected);
    call.addEventListener(CallEvents.Disconnected, onCallDisconnected);
    call.addEventListener(CallEvents.Failed,       onCallFailed);

    call.answer();
});

// ─── Звонок принят ────────────────────────────────────────────────────────────
function onCallConnected() {
    if (!API_BASE || !AGENT_ID || !VOICE_SECRET) {
        Logger.write('[SalesAgent] Missing apiBase, agentId or voiceSecret in custom data');
        call.say('Голосовой сервис пока не настроен. Попробуйте позже.', LANGUAGE);
        return;
    }
    Logger.write('[SalesAgent] Call connected, requesting greeting');
    callVoiceAPI('', true);
}

// ─── Вызов нашего AI API ───────────────────────────────────────────────────────
function callVoiceAPI(userText, isGreeting) {
    isProcessing = true;

    if (!isGreeting && userText) {
        history.push({ role: 'user', text: userText });
    }

    var payload = JSON.stringify({
        agent_id:   AGENT_ID,
        session_id: sessionId,
        phone:      callerPhone,
        text:       userText,
        isGreeting: isGreeting,
        history:    history.slice(-12),
    });

    Logger.write('[SalesAgent] Calling API: ' + (isGreeting ? '[greeting]' : userText));

    Net.httpRequestAsync(VOICE_API_URL, {
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'X-Voice-Secret': VOICE_SECRET },
        postData: payload,
        timeout:  45000,
    }, function(result) {
        var aiText = 'Извините, произошла ошибка. Попробуйте ещё раз.';
        var audioUrl = null;

        if (result.code === 200) {
            try {
                var parsed = JSON.parse(result.text);
                if (parsed.text) {
                    aiText = parsed.text;
                }
                if (parsed.audio_url) { audioUrl = parsed.audio_url; }
            } catch(ex) {
                Logger.write('[SalesAgent] JSON parse error: ' + result.text);
            }
        } else {
            Logger.write('[SalesAgent] API returned code: ' + result.code + ', body: ' + result.text);
        }

        history.push({ role: 'assistant', text: aiText });
        Logger.write('[SalesAgent] AI response: ' + aiText);

        playAndListen(audioUrl, aiText);
    });
}

// ─── Проговорить ответ и запустить ASR ────────────────────────────────────────
function speakAndListen(text) {
    call.say(text, LANGUAGE);
    call.addEventListener(CallEvents.PlaybackFinished, startListening);
}

// Fish Audio возвращает короткоживущий HTTPS MP3 URL. При сбое используем
// встроенный TTS Voximplant, поэтому звонок не обрывается из-за TTS-провайдера.
function playAndListen(audioUrl, fallbackText) {
    if (audioUrl) {
        call.addEventListener(CallEvents.PlaybackFinished, startListening);
        call.startPlayback(audioUrl, { progressivePlayback: true });
    } else {
        speakAndListen(fallbackText);
    }
}

// ─── Слушаем клиента (ASR) ────────────────────────────────────────────────────
function startListening() {
    call.removeEventListener(CallEvents.PlaybackFinished, startListening);
    isProcessing = false;

    Logger.write('[SalesAgent] Listening...');

    var asr = VoxEngine.createASR({
        profile:         ASR_PROFILE,
        singleUtterance: true,
        noSpeechTimeout: 5000,
        completeTimeout: 2000,
    });

    asr.addEventListener(ASREvents.Result, function(e) {
        Logger.write('[SalesAgent] ASR result: text=' + e.text + ' conf=' + e.confidence);

        if (e.text && e.confidence >= 0.4) {
            call.stopMediaTo(asr);
            callVoiceAPI(e.text, false);
        } else if (e.text) {
            // Низкая уверенность — переспросим
            call.stopMediaTo(asr);
            speakAndListen('Извините, не расслышала. Повторите, пожалуйста.');
        } else {
            // Тишина — ждём ещё
            call.stopMediaTo(asr);
            speakAndListen('Вы здесь? Чем могу помочь?');
        }
    });

    asr.addEventListener(ASREvents.Error, function(e) {
        Logger.write('[SalesAgent] ASR error: ' + e.text);
        startListening();
    });

    call.sendMediaTo(asr);
}

// ─── Завершение звонка ────────────────────────────────────────────────────────
function onCallDisconnected(e) {
    Logger.write('[SalesAgent] Call disconnected, reason: ' + (e.reason || 'unknown'));
    VoxEngine.terminate();
}

function onCallFailed(e) {
    Logger.write('[SalesAgent] Call failed: ' + e.reason);
    VoxEngine.terminate();
}
