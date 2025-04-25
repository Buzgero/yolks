#!/usr/bin/env node

/**
 * Ultra-debuggable wrapper.js para Rust en Pterodactyl
 * Incluye trazas detalladas en cada paso para localizar por qué no reinicia.
 */

const fs = require("fs");
const { exec } = require("child_process");
const WebSocket = require("ws");
const path = require("path");

// --- CONFIGURACIÓN DE UMBRALES (ms) ---
const WAIT_THRESHOLD       = 60_000;  // 1 min para probar timeout de RCON
const INACTIVITY_THRESHOLD = 60_000;  // 1 min sin salida de consola
const WATCH_INTERVAL       = 5_000;   // Chequeos cada 5 s

// --- VARIABLES DE ESTADO ---
let waitingStart    = null;          // Timestamp de primer error RCON
let lastConsoleTime = Date.now();    // Timestamp de última salida (stdout, stderr, RCON)
let hasEverOpened   = false;         // Marca si RCON llegó a abrir
let gameProcess     = null;

// --- Función de logging timestamped ---
function logDbg(...args) {
    const ts = new Date().toISOString();
    console.log(`[${ts}]`, ...args);
}

// --- Reinicia latest.log ---
try {
    fs.writeFileSync("latest.log", "", "utf8");
    logDbg("Init", "latest.log reiniciado");
} catch (e) {
    logDbg("Init", "ERROR al resetear latest.log:", e);
}

// --- Parseo de comando de arranque ---
const rawArgs = process.argv.slice(process.execArgv.length + 2);
if (rawArgs.length === 0) {
    logDbg("Init", "ERROR: No se especificó startup command. Abortando.");
    process.exit(1);
}
const startupCmd = rawArgs.join(" ");
logDbg("Init", "Comando de arranque:", startupCmd);

// --- Mostrar variables de entorno relevantes ---
logDbg("Init", "RCON_IP =", process.env.RCON_IP);
logDbg("Init", "RCON_PORT =", process.env.RCON_PORT);
logDbg("Init", "RCON_PASS =", process.env.RCON_PASS);

// --- Función de filtrado de salida del juego ---
const seenPct = {};
function filter(data) {
    const str = data.toString().trim();
    if (str.startsWith("Loading Prefab Bundle ")) {
        const pct = str.substr(23);
        if (seenPct[pct]) {
            logDbg("Filter", `Descartado porcentaje duplicado ${pct}`);
            return;
        }
        seenPct[pct] = true;
    }
    lastConsoleTime = Date.now();
    logDbg("Gamestdout", str);
}

// --- Arrancar proceso de RustDedicated ---
logDbg("Game", "Lanzando proceso de juego...");
gameProcess = exec(startupCmd, { shell: true });
gameProcess.stdout.on("data", filter);
gameProcess.stderr.on("data", filter);
gameProcess.on("exit", (code, sig) => {
    logDbg("Game", `Proceso de juego EXIT code=${code}, signal=${sig}`);
});

// --- Listener antes de RCON ready ---
function initialListener(data) {
    const cmd = data.toString().trim();
    lastConsoleTime = Date.now();
    logDbg("Listener", `stdin recibido pre-RCON: "${cmd}"`);
    if (cmd === "quit") {
        logDbg("Listener", "kill -SIGTERM al juego");
        gameProcess.kill("SIGTERM");
    }
}
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", initialListener);

// --- Cleanup on wrapper exit ---
process.on("exit", code => {
    logDbg("Exit", `Wrapper exiting with code ${code}`);
    if (gameProcess && !gameProcess.killed) {
        logDbg("Exit", "Matando proceso de juego...");
        gameProcess.kill("SIGTERM");
    }
});

// --- Watchdog combinado RCON + inactividad consola ---
setInterval(() => {
    const now = Date.now();
    const idleSec = Math.round((now - lastConsoleTime) / 1000);
    const rconSec = waitingStart ? Math.round((now - waitingStart) / 1000) : 0;
    logDbg("Watchdog", `Idle consola=${idleSec}s${waitingStart ? ` | RCON espera=${rconSec}s` : ""}`);

    if (now - lastConsoleTime >= INACTIVITY_THRESHOLD) {
        logDbg("Watchdog", `⚠️ SIN SALIDA DE CONSOLA ${idleSec}s (>=${INACTIVITY_THRESHOLD/1000}s). process.exit(1)`);
        process.exit(1);
    }
    if (waitingStart && now - waitingStart >= WAIT_THRESHOLD) {
        logDbg("Watchdog", `⚠️ RCON rostando ${rconSec}s (>=${WAIT_THRESHOLD/1000}s). process.exit(1)`);
        process.exit(1);
    }
}, WATCH_INTERVAL);

// --- Función poll RCON ---
function poll() {
    const host = process.env.RCON_IP || "localhost";
    const port = process.env.RCON_PORT;
    const pass = process.env.RCON_PASS;
    const url  = `ws://${host}:${port}/${pass}`;

    logDbg("RCON", `Intentando conectar WS a ${url}`);
    const ws = new WebSocket(url);

    ws.on("open", () => {
        const now = Date.now();
        const rconSec = waitingStart ? Math.round((now - waitingStart)/1000) : 0;
        logDbg("RCON", `OPEN tras ${rconSec}s. Limpio estado y habilito stdin->ws`);
        hasEverOpened = true;
        waitingStart = null;
        lastConsoleTime = Date.now();

        // envio status
        const pkt = JSON.stringify({ Identifier:-1, Message:"status", Name:"WebRcon" });
        ws.send(pkt);
        logDbg("RCON", "Enviado status packet");

        // remuevo listeners antiguos
        process.stdin.removeListener("data", initialListener);
        gameProcess.stdout.removeListener("data", filter);
        gameProcess.stderr.removeListener("data", filter);

        // vinculo stdin->ws
        process.stdin.on("data", d => {
            const cmd = d.toString().trim();
            lastConsoleTime = Date.now();
            const packet = JSON.stringify({ Identifier:-1, Message:cmd, Name:"WebRcon" });
            ws.send(packet);
            logDbg("RCON", `stdin->RCON: ${cmd}`);
        });
    });

    ws.on("message", msg => {
        const str = msg.toString().trim();
        lastConsoleTime = Date.now();
        logDbg("RCONmsg", `Raw: ${str}`);
        try {
            const obj = JSON.parse(str);
            if (obj.Message) {
                logDbg("RCONmsg", `JSON.Message: ${obj.Message}`);
                fs.appendFileSync("latest.log", "\n" + obj.Message, "utf8");
            } else {
                logDbg("RCONmsg", "JSON sin campo Message:", obj);
            }
        } catch (e) {
            logDbg("RCONmsg", "Texto plano:", str);
            fs.appendFileSync("latest.log", "\n" + str, "utf8");
        }
    });

    ws.on("error", err => {
        lastConsoleTime = Date.now();
        logDbg("RCON", "ERROR WS:", err.message);
        if (!waitingStart) {
            waitingStart = Date.now();
            logDbg("RCON", "Primer error: inicio cronómetro de WAIT_THRESHOLD");
        } else {
            const sec = Math.round((Date.now() - waitingStart)/1000);
            logDbg("RCON", `Error adicional tras ${sec}s de espera`);
        }
        logDbg("RCON", "setTimeout(poll,5000)");
        setTimeout(poll, 5000);
    });

    ws.on("close", (code, reason) => {
        logDbg("RCON", `CLOSE code=${code}, reason=${reason||"none"}`);
        if (hasEverOpened) {
            logDbg("RCON", "WS cerró tras OPEN -> process.exit(0)");
            process.exit(0);
        }
    });
}

// --- Iniciar poll por primera vez ---
logDbg("RCON", "Iniciando poll()");
poll();
