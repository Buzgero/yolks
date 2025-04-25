#!/usr/bin/env node

const fs = require("fs");
const { exec } = require("child_process");
const WebSocket = require("ws");

// --- Configuration ---
// Test thresholds: 1 minute for RCON/inactivity, frequent debug
const WAIT_THRESHOLD = 60000;        // 1 minute in ms for RCON connect
const INACTIVITY_THRESHOLD = 60000;  // 1 minute in ms for console output
const WATCH_INTERVAL = 5000;         // 5 seconds interval for watchdog logs

// --- State variables ---
let lastConsoleTime = Date.now();
let waitingStart = null;
let exited = false;

// Debug: script start
console.log(`🚀 Wrapper started at ${new Date().toISOString()}`);
console.log(`⚙️ Config: WAIT_THRESHOLD=${WAIT_THRESHOLD}ms, INACTIVITY_THRESHOLD=${INACTIVITY_THRESHOLD}ms, WATCH_INTERVAL=${WATCH_INTERVAL}ms`);

// --- Initialize latest.log (overwrite) ---
fs.writeFileSync("latest.log", "");

// --- Parse startup command ---
const args = process.argv.slice(process.execArgv.length + 2);
const startupCmd = args.join(" ");
if (!startupCmd) {
    console.log("Error: Please specify a startup command.");
    process.exit(1);
}
console.log(`🔧 Startup command: ${startupCmd}`);

// --- Percentage dedupe for prefab bundles ---
const seenPercentage = {};
function filter(data) {
    const str = data.toString();
    if (str.startsWith("Loading Prefab Bundle ")) {
        const pct = str.substr("Loading Prefab Bundle ".length);
        if (seenPercentage[pct]) return;
        seenPercentage[pct] = true;
    }
    lastConsoleTime = Date.now();
    console.log(str);
}

// --- Start the game process ---
console.log("🎮 Starting Rust Dedicated server...");
const gameProcess = exec(startupCmd);
gameProcess.stdout.on("data", filter);
gameProcess.stderr.on("data", filter);
gameProcess.on("exit", (code) => {
    exited = true;
    console.log(`⚠️ Game process exited with code ${code}`);
});

// --- Handle stdin until RCON connects ---
function initialListener(data) {
    const cmd = data.toString().trim();
    if (cmd === "quit") {
        gameProcess.kill('SIGTERM');
    } else {
        console.log(`Unable to run "${cmd}" until RCON connects.`);
    }
}
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", initialListener);

// --- Cleanup on wrapper exit ---
process.on("exit", () => {
    if (!exited) {
        console.log("🛑 Received stop request, terminating game process...");
        gameProcess.kill('SIGTERM');
    }
});

// --- Inactivity watchdog (with frequent debug) ---
console.log("⏱️ Starting inactivity watchdog...");
setInterval(() => {
    const idle = Date.now() - lastConsoleTime;
    console.log(`🕒 [Watchdog] Idle time: ${Math.round(idle/1000)}s`);
    if (idle >= INACTIVITY_THRESHOLD) {
        console.log(`⚠️ No console output for ${Math.round(idle/1000)}s (>= ${Math.round(INACTIVITY_THRESHOLD/1000)}s), forcing restart...`);
        process.exit(1);
    }
}, WATCH_INTERVAL);

// --- RCON polling logic ---
function poll() {
    console.log(`🔎 [RCON] Polling for connection at ${new Date().toISOString()}`);
    const host = process.env.RCON_IP || "localhost";
    const port = process.env.RCON_PORT;
    const pass = process.env.RCON_PASS;
    const ws = new WebSocket(`ws://${host}:${port}/${pass}`);

    ws.on("open", () => {
        console.log("✅ Connected to RCON. Awaiting server status 'Running'.");
        waitingStart = null;
        lastConsoleTime = Date.now();
        ws.send(JSON.stringify({ Identifier: -1, Message: "status", Name: "WebRcon" }));

        // Switch stdin to RCON
        process.stdin.removeListener("data", initialListener);
        process.stdin.on("data", (text) => {
            console.log(`📤 Sending RCON command: ${text.trim()}`);
            ws.send(JSON.stringify({ Identifier: -1, Message: text, Name: "WebRcon" }));
        });
    });

    ws.on("message", (data) => {
        lastConsoleTime = Date.now();
        const msgStr = data.toString();
        try {
            const parsed = JSON.parse(msgStr);
            if (parsed.Message) {
                console.log(`📥 RCON Message: ${parsed.Message}`);
                fs.appendFileSync("latest.log", "\n" + parsed.Message);
            }
        } catch {
            console.log(`📥 RCON Raw: ${msgStr}`);
        }
    });

    ws.on("error", (err) => {
        console.log(`❌ [RCON] Connection error: ${err.message}`);
        const now = Date.now();
        if (!waitingStart) {
            waitingStart = now;
            console.log("🔄 Waiting for RCON to come up...");
            setTimeout(poll, 5000);
        } else {
            const elapsed = now - waitingStart;
            console.log(`🕒 [RCON Watchdog] Elapsed: ${Math.round(elapsed/1000)}s`);
            if (elapsed >= WAIT_THRESHOLD) {
                console.log(`🔥 RCON connect timeout (${Math.round(WAIT_THRESHOLD/1000)}s) exceeded, exiting...`);
                process.exit(1);
            } else {
                console.log("🔄 Retrying RCON connection...");
                setTimeout(poll, 5000);
            }
        }
    });

    ws.on("close", () => {
        console.log("⚠️ [RCON] Connection closed.");
        if (!exited) process.exit(1);
    });
}
poll();
