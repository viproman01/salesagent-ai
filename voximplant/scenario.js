/**
 * SalesAgent AI — VoxEngine full-duplex media scenario
 *
 * Audio:
 *   caller -> μ-law 8 kHz -> Voximplant media WebSocket -> SalesAgent
 *   caller <- μ-law 8 kHz <- Voximplant media WebSocket <- Fish Audio runtime
 *
 * Placeholders are replaced by scripts/voximplant-setup.mjs before upload.
 */

// The authenticated endpoint is embedded by the setup script. Never allow
// per-call custom data to override it, because that would forward the shared
// X-Voice-Token to an untrusted WebSocket host.
var SALESAGENT_WS_URL = __SALESAGENT_WS_URL_JSON__;
var VOICE_ORG_ID = __VOICE_ORG_ID_JSON__;
var VOICE_WS_AUTH_TOKEN = __VOICE_WS_AUTH_TOKEN_JSON__;

var call = null;
var ws = null;
var sessionId = null;
var callerPhone = null;
var callConnected = false;
var wsConnected = false;
var mediaStarted = false;
var terminating = false;
var fallbackInProgress = false;
var failureSpeechStarted = false;
var latestGeneration = 0;
var activeMediaGeneration = null;
var clearedMediaGeneration = null;
var activeNativeGeneration = null;

VoxEngine.addEventListener(AppEvents.CallAlerting, function(e) {
    call = e.call;
    sessionId = call.id();
    callerPhone = call.callerid() || 'unknown';

    var separator = SALESAGENT_WS_URL.indexOf('?') === -1 ? '?' : '&';
    var wsUrl =
        SALESAGENT_WS_URL +
        separator +
        'callId=' + encodeURIComponent(sessionId) +
        '&phone=' + encodeURIComponent(callerPhone) +
        '&orgId=' + encodeURIComponent(VOICE_ORG_ID) +
        '&protocol=vox-media-v1';
    var headers = [];
    if (VOICE_WS_AUTH_TOKEN) {
        headers.push({
            name: 'X-Voice-Token',
            value: VOICE_WS_AUTH_TOKEN,
        });
    }

    Logger.write(
        '[SalesAgent] Connecting full-duplex media for session=' + sessionId
    );

    ws = VoxEngine.createWebSocket(wsUrl, {
        protocols: 'media',
        headers: headers,
        privacy: true,
        statistics: true,
    });

    ws.addEventListener(WebSocketEvents.OPEN, function() {
        wsConnected = true;
        Logger.write('[SalesAgent] Media WebSocket connected');
        call.answer();
        startMediaBridge();
    });

    ws.addEventListener(WebSocketEvents.MESSAGE, function(event) {
        handleControlMessage(event.text);
    });

    ws.addEventListener(WebSocketEvents.MEDIA_STARTED, function() {
        Logger.write('[SalesAgent] Assistant audio playback started');
    });

    ws.addEventListener(WebSocketEvents.MEDIA_ENDED, function() {
        Logger.write('[SalesAgent] Assistant audio playback ended');
        if (clearedMediaGeneration !== null) {
            // clearMediaBuffer may emit MEDIA_ENDED after a newer playback has
            // already been announced. Never acknowledge that clear as real
            // completion; the backend has a duration fallback if no event is
            // emitted by this VoxEngine version.
            clearedMediaGeneration = null;
            Logger.write('[SalesAgent] Suppressed media-ended caused by clear');
            return;
        }
        var generation = activeMediaGeneration;
        activeMediaGeneration = null;
        sendPlaybackEnded(generation);
    });

    ws.addEventListener(WebSocketEvents.ERROR, function() {
        Logger.write('[SalesAgent] Media WebSocket error');
        failCall();
    });

    ws.addEventListener(WebSocketEvents.CLOSE, function() {
        wsConnected = false;
        Logger.write('[SalesAgent] Media WebSocket closed');
        if (!terminating && !fallbackInProgress && call) call.hangup();
    });

    call.addEventListener(CallEvents.Connected, function() {
        callConnected = true;
        Logger.write('[SalesAgent] Call connected');
        if (fallbackInProgress) {
            playFailureSpeech();
            return;
        }
        startMediaBridge();
    });

    call.addEventListener(CallEvents.Disconnected, function(event) {
        Logger.write(
            '[SalesAgent] Call disconnected: ' + (event.reason || 'unknown')
        );
        terminateSession();
    });

    call.addEventListener(CallEvents.Failed, function(event) {
        Logger.write('[SalesAgent] Call failed: ' + (event.reason || 'unknown'));
        terminateSession();
    });

    call.addEventListener(CallEvents.PlaybackFinished, function() {
        var generation = activeNativeGeneration;
        activeNativeGeneration = null;
        if (generation !== null) attachAssistantMediaRoute();
        sendPlaybackEnded(generation);
    });
});

function startMediaBridge() {
    if (
        mediaStarted ||
        !callConnected ||
        !wsConnected ||
        !call ||
        !ws
    ) {
        return;
    }

    mediaStarted = true;
    call.sendMediaTo(ws, {
        encoding: WebSocketAudioEncoding.ULAW,
        tag: 'caller',
        customParameters: {
            callId: sessionId,
            phone: callerPhone,
            orgId: VOICE_ORG_ID,
        },
    });
    attachAssistantMediaRoute();
    Logger.write('[SalesAgent] Full-duplex μ-law bridge started');
}

function attachAssistantMediaRoute() {
    if (!call || !ws || !wsConnected) return;
    ws.sendMediaTo(call, {
        encoding: WebSocketAudioEncoding.ULAW,
        tag: 'assistant',
    });
}

function handleControlMessage(text) {
    var message;
    try {
        message = JSON.parse(text);
    } catch (error) {
        Logger.write('[SalesAgent] Ignoring invalid control JSON');
        return;
    }

    if (message.customEvent === 'playback_generation') {
        var announcedGeneration = Number(message.generation || 0);
        if (announcedGeneration >= latestGeneration) {
            latestGeneration = announcedGeneration;
            activeMediaGeneration = announcedGeneration;
        }
        return;
    }

    if (message.customEvent === 'clear_media_buffer') {
        var clearGeneration = Number(message.generation || 0);
        if (clearGeneration < latestGeneration) return;
        latestGeneration = clearGeneration;
        if (activeMediaGeneration !== null) {
            clearedMediaGeneration = activeMediaGeneration;
            activeMediaGeneration = null;
        }
        var nativePlaybackWasActive = activeNativeGeneration !== null;
        activeNativeGeneration = null;
        if (ws) ws.clearMediaBuffer();
        if (call) call.stopPlayback();
        if (nativePlaybackWasActive) attachAssistantMediaRoute();
        Logger.write(
            '[SalesAgent] Playback cleared for generation=' +
            String(message.generation || '')
        );
        return;
    }

    if (message.customEvent === 'fallback_speech' && message.text) {
        var fallbackGeneration = Number(message.generation || 0);
        if (fallbackGeneration < latestGeneration) return;
        latestGeneration = fallbackGeneration;
        activeNativeGeneration = fallbackGeneration;
        call.say(String(message.text), Language.RU_RUSSIAN_FEMALE);
        return;
    }

    if (message.customEvent === 'hangup') {
        call.hangup();
    }
}

function sendPlaybackEnded(generation) {
    if (
        !ws ||
        !wsConnected ||
        generation === null ||
        !Number.isInteger(generation) ||
        generation < 1
    ) {
        return;
    }
    ws.send(JSON.stringify({
        customEvent: 'playback_ended',
        generation: generation,
    }));
}

function failCall() {
    if (!call || terminating || fallbackInProgress) return;
    fallbackInProgress = true;
    activeMediaGeneration = null;
    clearedMediaGeneration = null;
    activeNativeGeneration = null;
    if (ws) ws.clearMediaBuffer();
    call.stopPlayback();
    if (!callConnected) {
        call.answer();
        return;
    }
    playFailureSpeech();
}

function playFailureSpeech() {
    if (!call || terminating || failureSpeechStarted || !callConnected) return;
    failureSpeechStarted = true;
    call.say(
        'Извините, произошла техническая ошибка. Попробуйте позвонить позже.',
        Language.RU_RUSSIAN_FEMALE
    );
    call.addEventListener(CallEvents.PlaybackFinished, function onFailureSpeechFinished() {
        call.removeEventListener(
            CallEvents.PlaybackFinished,
            onFailureSpeechFinished
        );
        call.hangup();
    });
}

function terminateSession() {
    if (terminating) return;
    terminating = true;

    if (call && ws && mediaStarted) {
        call.stopMediaTo(ws);
        ws.stopMediaTo(call);
    }
    if (ws) ws.close();
    VoxEngine.terminate();
}
