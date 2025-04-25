#!/usr/bin/env node

const fs = require("fs");
const { exec } = require("child_process");
const WebSocket = require("ws");

// --- Configuration ---
// --- Configuration (test thresholds: 1 minute) ---
const WAIT_THRESHOLD = 60000;       // 1 minute in ms for RCON connect (test)
const INACTIVITY_THRESHOLD = 60000; // 1 minute in ms for console output (test) // 5 minutes in ms for console output
const WATCH_INTERVAL = 30000;        // 30 seconds interval

let lastConsoleTime = Date.now();
let waitingStart = null;
let exited = false;

// Monkey-patch console to update lastConsoleTime on any log
const _origLog = console.log;
console.log = (...args) => { lastConsoleTime = Date.now(); _origLog(...args); };
const _origError = console.error;
console.error = (...args) => { lastConsoleTime = Date.now(); _origError(...args); };

// --- Initialize latest.log (overwrite) ---
fs.writeFileSync("latest.log", "");

// --- Parse startup command ---
const args = process.argv.slice(process.execArgv.length + 2);
const startupCmd = args.join(" ");
if (!startupCmd) {
    console.log("Error: Please specify a startup command.");
    process.exit(1);
}

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
console.log("Starting Rust...");
const gameProcess = exec(startupCmd);
gameProcess.stdout.on("data", filter);
gameProcess.stderr.on("data", filter);
gameProcess.on("exit", (code) => {
    exited = true;
    if (code) console.log("Main game process exited with code " + code);
});

// --- Handle stdin until RCON connects ---
function initialListener(data) {
    const cmd = data.toString().trim();
    if (cmd === "quit") gameProcess.kill("SIGTERM");
    else console.log(`Unable to run "${cmd}" until RCON connects.`);
}
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", initialListener);

// --- Cleanup on wrapper exit ---
process.on("exit", () => {
    if (!exited) {
        console.log("Received stop request, terminating game process...");
        gameProcess.kill("SIGTERM");
    }
});

// --- Inactivity watchdog ---
setInterval(() => {
    if (Date.now() - lastConsoleTime >= INACTIVITY_THRESHOLD) {
        console.log(`⚠️ No console output for ${Math.round((Date.now() - lastConsoleTime)/1000)}s, forcing restart...`);
        process.exit(1);
    }
}, WATCH_INTERVAL);

// --- RCON polling logic ---
function poll() {
    const host = process.env.RCON_IP || "localhost";
    const port = process.env.RCON_PORT;
    const pass = process.env.RCON_PASS;
    const ws = new WebSocket(`ws://${host}:${port}/${pass}`);

    ws.on("open", () => {
        console.log("Connected to RCON. Please wait until server status is Running.");
        waitingStart = null;
        lastConsoleTime = Date.now();
        ws.send(JSON.stringify({ Identifier: -1, Message: "status", Name: "WebRcon" }));

        // Switch stdin to RCON
        process.stdin.removeListener("data", initialListener);
        process.stdin.on("data", (text) => {
            ws.send(JSON.stringify({ Identifier: -1, Message: text, Name: "WebRcon" }));
        });
    });

    ws.on("message", (data) => {
        lastConsoleTime = Date.now();
        const msgStr = data.toString();
        try {
            const parsed = JSON.parse(msgStr);
            if (parsed.Message) {
                console.log(parsed.Message);
                fs.appendFileSync("latest.log", "\n" + parsed.Message);
            }
        } catch {
            // Raw output for non-JSON RCON messages
            console.log(msgStr);
        }
    });

    ws.on("error", () => {
        const now = Date.now();
        if (!waitingStart) {
            waitingStart = now;
            console.log("Waiting for RCON to come up...");
            setTimeout(poll, 5000);
        } else if (now - waitingStart >= WAIT_THRESHOLD) {
            console.log(`🔥 RCON connect timeout (${WAIT_THRESHOLD} ms) exceeded, exiting...`);
            process.exit(1);
        } else {
            console.log("Retrying RCON connection...");
            setTimeout(poll, 5000);
        }
    });

    ws.on("close", () => {
        console.log("RCON connection closed.");
        if (!exited) process.exit(1);
    });
}

poll();
