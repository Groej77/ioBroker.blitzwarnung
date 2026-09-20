'use strict';

/*
 * ioBroker Adapter "blitzwarnung"
 * Gewitter-/Blitzwarnung ueber den Live-Feed von Blitzortung.org.
 * Meldet erkannte Blitze in der Naehe der Wohnung (und optional in der
 * Naehe eines aktuellen Standorts, z.B. Handy-GPS) per Telegram und -
 * nur bei der Warnstufe - zusaetzlich optional per Pushover (Emergency).
 */

const utils = require('@iobroker/adapter-core');
const WebSocket = require('ws');

// Aktuelle Server laut offizieller Doku (blitzortung.org): ws1, ws2, ws7, ws8
const WS_SERVERS = [1, 2, 7, 8].map(n => `wss://ws${n}.blitzortung.org/`);

class Blitzwarnung extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    constructor(options) {
        super({
            ...options,
            name: 'blitzwarnung',
        });

        this.ws = null;
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        this.debugTimer = null;
        this.statsClearTimer = null;
        this.serverIndex = 0;
        this.stopping = false;

        this.homeLat = 0;
        this.homeLon = 0;

        // Zwei komplett unabhaengige Cooldown-/Eskalationsstaende - einer fuer
        // die Wohnung (laeuft immer), einer fuer den aktuellen Standort
        // (laeuft nur, wenn usePhoneLocation aktiv ist und man "unterwegs" ist)
        this.trackers = {
            home: { lastLevel: 0, lastAnnounceTime: 0 },
            phone: { lastLevel: 0, lastAnnounceTime: 0 },
        };

        this.locationLabels = {
            home: 'in der Naehe Ihrer Wohnung',
            phone: 'in der Naehe Ihres Standortes',
        };

        this.debugStrikeCount = 0;
        this.debugMinDistanceKm = null;
        this.debugRawMessageCount = 0;
        this.debugParseErrorCount = 0;

        this.lastRelevantStrikeTime = 0;
        this.statsDistanceCleared = true;

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        await this.setStateAsync('info.connection', false, true);

        await this.resolveHomeLocation();

        if (this.homeLat === 0 && this.homeLon === 0) {
            this.log.warn(
                'Kein Standort gefunden - bitte in den Instanz-Einstellungen homeLat/homeLon eintragen ' +
                    'oder den ioBroker-Systemstandort (Sonnenauf-/untergang) pflegen.',
            );
            return;
        }

        this.startStatsClearTimer();
        this.connect();

        this.log.info(
            `Blitz-Warnadapter gestartet. Standort: ${this.homeLat}, ${this.homeLon}. ` +
                `Radien: Hinweis <= ${this.config.radiusInfoKm}km, Warnung <= ${this.config.radiusWarnKm}km. ` +
                `Telegram: ${this.config.useTelegram ? 'an' : 'aus'}, Pushover: ${this.config.usePushover ? 'an' : 'aus'}, ` +
                `Standort-Ueberwachung: ${this.config.usePhoneLocation ? 'an' : 'aus'}.`,
        );
    }

    /**
     * Standort ermitteln: Instanz-Konfiguration hat Vorrang, sonst Fallback
     * auf den ioBroker-Systemstandort (system.config).
     */
    async resolveHomeLocation() {
        const configLat = parseFloat(String(this.config.homeLat));
        const configLon = parseFloat(String(this.config.homeLon));

        if (!isNaN(configLat) && !isNaN(configLon) && (configLat !== 0 || configLon !== 0)) {
            this.homeLat = configLat;
            this.homeLon = configLon;
            this.log.debug(`Standort aus Instanz-Konfiguration: ${this.homeLat}, ${this.homeLon}`);
            return;
        }

        try {
            const systemConfig = await this.getForeignObjectAsync('system.config');
            const rawLat = systemConfig && systemConfig.common ? systemConfig.common.latitude : undefined;
            const rawLon = systemConfig && systemConfig.common ? systemConfig.common.longitude : undefined;
            const lat = parseFloat(String(rawLat));
            const lon = parseFloat(String(rawLon));

            if (!isNaN(lat) && !isNaN(lon) && (lat !== 0 || lon !== 0)) {
                this.homeLat = lat;
                this.homeLon = lon;
                this.log.info(`Standort aus system.config uebernommen: ${this.homeLat}, ${this.homeLon}`);
            }
        } catch (err) {
            this.log.warn(`system.config konnte nicht gelesen werden: ${err.message}`);
        }
    }

    // -----------------------------------------------------------------
    // Blitzortung.org komprimiert die gesendeten Daten mit einem
    // einfachen LZW-Verfahren - das wird hier wieder rueckgaengig gemacht.
    // -----------------------------------------------------------------
    lzwDecode(input) {
        const dict = {};
        const data = input.split('');
        let currChar = data[0];
        let oldPhrase = currChar;
        const out = [currChar];
        let code = 256;
        for (let i = 1; i < data.length; i++) {
            const currCode = data[i].charCodeAt(0);
            let phrase;
            if (currCode < 256) {
                phrase = data[i];
            } else {
                phrase = dict[currCode] ? dict[currCode] : oldPhrase + currChar;
            }
            out.push(phrase);
            currChar = phrase.charAt(0);
            dict[code] = oldPhrase + currChar;
            code++;
            oldPhrase = phrase;
        }
        return out.join('');
    }

    haversineKm(lat1, lon1, lat2, lon2) {
        const R = 6371; // Erdradius in km
        const toRad = deg => (deg * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    minutesSince(ts) {
        return (Date.now() - ts) / 60000;
    }

    getLevel(distanceKm) {
        if (distanceKm <= this.config.radiusWarnKm) {
            return 2;
        }
        if (distanceKm <= this.config.radiusInfoKm) {
            return 1;
        }
        return 0;
    }

    buildMessage(level, distanceKm, locationKey) {
        const distText =
            distanceKm < 1
                ? `${Math.round(distanceKm * 1000)} Metern`
                : `${distanceKm.toFixed(1).replace('.', ',')} Kilometern`;
        const locationText = this.locationLabels[locationKey];

        if (level === 2) {
            return `Achtung, Blitzeinschlag ${locationText} erkannt - nur ${distText} entfernt.`;
        }
        return `Hinweis: Blitzeinschlag ${locationText} erkannt, ${distText} entfernt.`;
    }

    // -----------------------------------------------------------------
    // Ausgabe
    // -----------------------------------------------------------------
    async speakTelegram(text) {
        if (!this.config.useTelegram || !this.config.telegramInstance) {
            return;
        }

        let telegramUser = null;
        if (this.config.telegramAdminState) {
            try {
                const adminState = await this.getForeignStateAsync(this.config.telegramAdminState);
                telegramUser = adminState ? adminState.val : null;
            } catch (err) {
                this.log.warn(`Telegram-Empfaenger-State konnte nicht gelesen werden: ${err.message}`);
            }
        }

        if (!telegramUser) {
            this.log.warn(
                `Kein Telegram-Empfaenger gefunden (State: ${this.config.telegramAdminState || '-'}) - ` +
                    'Nachricht nicht gesendet!',
            );
            return;
        }

        this.sendTo(this.config.telegramInstance, 'send', { text, user: telegramUser });
        this.log.info(`Telegram-Nachricht an ${telegramUser}: ${text}`);
    }

    speakPushoverEmergency(text) {
        if (!this.config.usePushover || !this.config.pushoverInstance) {
            return;
        }

        this.sendTo(this.config.pushoverInstance, 'send', {
            message: text,
            title: 'Blitzwarnung',
            priority: 2, // Emergency - durchdringt Stumm-/Nicht-stoeren-Modus
            retry: this.config.pushoverRetrySeconds,
            expire: this.config.pushoverExpireSeconds,
        });
        this.log.info(`Pushover-Notfallmeldung gesendet: ${text}`);
    }

    // -----------------------------------------------------------------
    // Standort (z.B. Handy-GPS)
    // -----------------------------------------------------------------
    async getPhoneLocation() {
        if (!this.config.usePhoneLocation || !this.config.phoneLatState || !this.config.phoneLonState) {
            return null;
        }

        try {
            const latState = await this.getForeignStateAsync(this.config.phoneLatState);
            const lonState = await this.getForeignStateAsync(this.config.phoneLonState);

            if (!latState || !lonState || latState.val === null || lonState.val === null) {
                return null;
            }

            const lat = parseFloat(String(latState.val));
            const lon = parseFloat(String(lonState.val));
            if (isNaN(lat) || isNaN(lon)) {
                return null;
            }

            const ts = Math.min(latState.ts || 0, lonState.ts || 0);
            if (this.minutesSince(ts) > this.config.phoneLocationMaxAgeMinutes) {
                return null; // Standort veraltet (z.B. GPS aus, Handy offline)
            }

            return { lat, lon };
        } catch (err) {
            this.log.warn(`Standort-States konnten nicht gelesen werden: ${err.message}`);
            return null;
        }
    }

    // -----------------------------------------------------------------
    // Statistik (Tageszaehler + aktuelle Entfernung, fuer VIS/Dashboards)
    // -----------------------------------------------------------------
    async updateLightningStats(distanceKm) {
        const counterState = await this.getStateAsync('home.lightningCountToday');
        const now = new Date();
        const currentCount = counterState && typeof counterState.val === 'number' ? counterState.val : 0;
        const lastChange = counterState && counterState.lc ? new Date(counterState.lc) : null;
        const isNewDay = !lastChange || lastChange.toDateString() !== now.toDateString();

        const roundedKm = Math.round(distanceKm * 10) / 10;
        await this.setStateAsync('home.lightningCountToday', isNewDay ? 1 : currentCount + 1, true);
        await this.setStateAsync('home.distanceKm', roundedKm, true);
        await this.setStateAsync('home.distanceText', `${roundedKm.toFixed(1).replace('.', ',')} km`, true);

        this.lastRelevantStrikeTime = Date.now();
        this.statsDistanceCleared = false;
    }

    startStatsClearTimer() {
        this.statsClearTimer = this.setInterval(async () => {
            if (
                !this.statsDistanceCleared &&
                this.lastRelevantStrikeTime > 0 &&
                this.minutesSince(this.lastRelevantStrikeTime) >= this.config.statsClearAfterMinutes
            ) {
                await this.setStateAsync('home.distanceKm', null, true);
                await this.setStateAsync('home.distanceText', this.config.statsNoStormText, true);
                this.statsDistanceCleared = true;
                this.log.debug(
                    `Gewitter-Entfernung zurueckgesetzt - seit ${this.config.statsClearAfterMinutes} Minuten kein relevanter Blitz mehr.`,
                );
            }
        }, 60 * 1000);
    }

    // -----------------------------------------------------------------
    // Kernlogik: eine Entfernung gegen die Warnstufen pruefen und ggf.
    // per Telegram/Pushover melden - mit eigenem Cooldown/Eskalationsstand
    // je nach "key" ('home' oder 'phone').
    // -----------------------------------------------------------------
    async evaluateAndAnnounce(key, distanceKm) {
        const level = this.getLevel(distanceKm);

        await this.setStateAsync(`${key}.level`, level, true);
        if (level === 0) {
            return;
        }

        const tracker = this.trackers[key];

        if (
            tracker.lastAnnounceTime > 0 &&
            this.minutesSince(tracker.lastAnnounceTime) >= this.config.quietResetMinutes
        ) {
            tracker.lastLevel = 0;
        }

        const escalation = level > tracker.lastLevel;
        const cooldownElapsed = this.minutesSince(tracker.lastAnnounceTime) >= this.config.cooldownMinutes;

        if (escalation || cooldownElapsed) {
            const text = this.buildMessage(level, distanceKm, key);
            await this.speakTelegram(text);
            if (level === 2) {
                this.speakPushoverEmergency(text);
            }
            tracker.lastAnnounceTime = Date.now();
            tracker.lastLevel = level;
        }
    }

    async handleStrike(strike) {
        if (typeof strike.lat !== 'number' || typeof strike.lon !== 'number') {
            return;
        }

        // Zeitstempel kommt als Nanosekunden seit Unix-Epoch
        if (strike.time) {
            const strikeMs = strike.time / 1e6;
            const ageSeconds = (Date.now() - strikeMs) / 1000;
            if (ageSeconds > this.config.staleEventSeconds) {
                return;
            } // zu alt (z.B. Backlog nach Reconnect)
        }

        const distanceHomeKm = this.haversineKm(this.homeLat, this.homeLon, strike.lat, strike.lon);

        this.debugStrikeCount++;
        if (this.debugMinDistanceKm === null || distanceHomeKm < this.debugMinDistanceKm) {
            this.debugMinDistanceKm = distanceHomeKm;
        }

        if (this.getLevel(distanceHomeKm) > 0) {
            await this.updateLightningStats(distanceHomeKm);
        }

        // 1) Wohnungs-Ueberwachung laeuft immer
        await this.evaluateAndAnnounce('home', distanceHomeKm);

        // 2) Standort-Ueberwachung nur, wenn aktiviert, Position bekannt/frisch
        //    ist UND man damit als "unterwegs" gilt
        const phoneLoc = await this.getPhoneLocation();
        if (phoneLoc) {
            const phoneDistanceFromHomeKm = this.haversineKm(this.homeLat, this.homeLon, phoneLoc.lat, phoneLoc.lon);
            const isAway = phoneDistanceFromHomeKm > this.config.awayThresholdKm;
            await this.setStateAsync('phone.away', isAway, true);

            if (isAway) {
                const distancePhoneKm = this.haversineKm(phoneLoc.lat, phoneLoc.lon, strike.lat, strike.lon);
                await this.evaluateAndAnnounce('phone', distancePhoneKm);
            }
        } else {
            await this.setStateAsync('phone.away', false, true);
        }
    }

    // -----------------------------------------------------------------
    // WebSocket-Verbindung zu Blitzortung.org
    // -----------------------------------------------------------------
    connect() {
        const url = WS_SERVERS[this.serverIndex % WS_SERVERS.length];
        this.log.info(`Verbinde mit Blitzortung-Server: ${url}`);

        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            this.log.info('Verbindung zu Blitzortung.org hergestellt.');
            this.setState('info.connection', true, true);

            // Zwei unterschiedliche "Anmelde"-Varianten sind fuer dieses
            // Protokoll dokumentiert - beide werden sicherheitshalber gesendet
            this.ws.send(JSON.stringify({ time: 0 }));
            this.ws.send(JSON.stringify({ a: 111 }));

            if (this.heartbeatTimer) {
                this.clearInterval(this.heartbeatTimer);
            }
            this.heartbeatTimer = this.setInterval(() => {
                if (this.ws && this.ws.readyState === this.ws.OPEN) {
                    this.ws.send(JSON.stringify({ time: 0 }));
                }
            }, this.config.heartbeatIntervalSeconds * 1000);

            if (this.debugTimer) {
                this.clearInterval(this.debugTimer);
            }
            if (this.config.debugSummaryIntervalSeconds > 0) {
                this.debugTimer = this.setInterval(() => {
                    if (this.debugStrikeCount === 0) {
                        this.log.debug(
                            `Debug: In den letzten ${this.config.debugSummaryIntervalSeconds}s wurden 0 Blitze empfangen.`,
                        );
                    } else {
                        this.log.debug(
                            `Debug: In den letzten ${this.config.debugSummaryIntervalSeconds}s wurden ${this.debugStrikeCount} ` +
                                `Blitze weltweit empfangen, der naechste war ${(this.debugMinDistanceKm || 0).toFixed(1)} km von der Wohnung entfernt.`,
                        );
                    }
                    this.debugStrikeCount = 0;
                    this.debugMinDistanceKm = null;
                }, this.config.debugSummaryIntervalSeconds * 1000);
            }
        });

        this.ws.on('message', data => {
            const decoded = this.lzwDecode(data.toString());

            if (this.debugRawMessageCount < 3) {
                this.debugRawMessageCount++;
                this.log.debug(`Debug dekodierte Nachricht #${this.debugRawMessageCount}: ${decoded.slice(0, 300)}`);
            }

            try {
                const strike = JSON.parse(decoded);
                this.handleStrike(strike).catch(err => this.log.error(`Fehler bei Blitz-Verarbeitung: ${err.message}`));
            } catch (e) {
                this.debugParseErrorCount++;
                if (this.debugParseErrorCount <= 3) {
                    this.log.warn(
                        `Debug: JSON.parse fehlgeschlagen (${e.message}) bei dekodierten Daten: ${decoded.slice(0, 200)}`,
                    );
                }
            }
        });

        this.ws.on('close', () => {
            if (this.heartbeatTimer) {
                this.clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = null;
            }
            if (this.debugTimer) {
                this.clearInterval(this.debugTimer);
                this.debugTimer = null;
            }
            this.setState('info.connection', false, true);

            if (this.stopping) {
                return;
            }

            this.serverIndex++; // beim naechsten Versuch anderen Server probieren
            this.log.warn(
                `Verbindung zu Blitzortung.org getrennt, versuche erneut in ${this.config.reconnectDelaySeconds}s mit naechstem Server...`,
            );
            this.scheduleReconnect();
        });

        this.ws.on('error', err => {
            let details = err && err.message ? err.message : String(err);
            if (err && Array.isArray(err.errors)) {
                details += ` | Einzelfehler: ${err.errors
                    .map(e => (e && e.code ? `${e.code} ` : '') + (e && e.message ? e.message : String(e)))
                    .join(' ; ')}`;
            }
            this.log.error(`Blitzortung-Websocket-Fehler (Server: ${url}): ${details}`);
        });
    }

    scheduleReconnect() {
        if (this.reconnectTimer) {
            this.clearTimeout(this.reconnectTimer);
        }
        this.reconnectTimer = this.setTimeout(() => this.connect(), this.config.reconnectDelaySeconds * 1000);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - Callback function
     */
    onUnload(callback) {
        try {
            this.stopping = true;
            if (this.reconnectTimer) {
                this.clearTimeout(this.reconnectTimer);
            }
            if (this.heartbeatTimer) {
                this.clearInterval(this.heartbeatTimer);
            }
            if (this.debugTimer) {
                this.clearInterval(this.debugTimer);
            }
            if (this.statsClearTimer) {
                this.clearInterval(this.statsClearTimer);
            }
            if (this.ws) {
                this.ws.removeAllListeners();
                this.ws.terminate();
            }
            callback();
        } catch (error) {
            this.log.error(`Error during unloading: ${error.message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    module.exports = options => new Blitzwarnung(options);
} else {
    new Blitzwarnung();
}
