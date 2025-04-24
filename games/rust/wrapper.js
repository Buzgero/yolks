#!/usr/bin/env node

var startupCmd = "";
const fs = require("fs");
fs.writeFile("latest.log", "", (err) => {
    if (err) console.log("Callback error in appendFile:" + err);
});

var args = process.argv.splice(process.execArgv.length + 2);
for (var i = 0; i < args.length; i++) {
    if (i === args.length - 1) {
        startupCmd += args[i];
    } else {
        startupCmd += args[i] + " ";
    }
}

if (startupCmd.length < 1) {
    console.log("Error: Please specify a startup command.");
    process.exit();
}

const seenPercentage = {};

function filter(data) {
    const str = data.toString();
    if (str.startsWith("Loading Prefab Bundle ")) { // Rust seems to spam the same percentage, so filter out any duplicates.
        const percentage = str.substr("Loading Prefab Bundle ".length);
        if (seenPercentage[percentage]) return;
        seenPercentage[percentage] = true;
    }
    console.log(str);
}

const exec = require("child_process").exec;
console.log("Starting Rust...");

var exited = false;
const gameProcess = exec(startupCmd);
gameProcess.stdout.on('data', filter);
gameProcess.stderr.on('data', filter);
gameProcess.on('exit', function (code, signal) {
    exited = true;
    if (code) {
        console.log("Main game process exited with code " + code);
        // process.exit(code);
    }
});

function initialListener(data) {
    const command = data.toString().trim();
    if (command === 'quit') {
        gameProcess.kill('SIGTERM');
    } else {
        console.log('Unable to run "' + command + '" due to RCON not being connected yet.');
    }
}
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on('data', initialListener);

process.on('exit', function (code) {
    if (exited) return;
    console.log("Received request to stop the process, stopping the game...");
    gameProcess.kill('SIGTERM');
});

// --- RCON retry threshold logic ---
var waiting = true;
// Timestamp when we first started waiting for RCON
var waitingStart = null;
// Threshold for waiting before forcing exit (3 seconds for testing)
const WAIT_THRESHOLD = 3_000;
// Flag to track if we've already retried once
var hasRetried = false;

var poll = function () {
    function createPacket(command) {
        return JSON.stringify({
            Identifier: -1,
            Message: command,
            Name: "WebRcon"
        });
    }

    var serverHostname = process.env.RCON_IP ? process.env.RCON_IP : "localhost";
    var serverPort = process.env.RCON_PORT;
    var serverPassword = process.env.RCON_PASS;
    var WebSocket = require("ws");
    var ws = new WebSocket("ws://" + serverHostname + ":" + serverPort + "/" + serverPassword);

    ws.on("open", function open() {
        console.log("Connected to RCON. Generating the map now. Please wait until the server status switches to \"Running\".");
        waiting = false;

        // Hack to fix broken console output
        ws.send(createPacket('status'));

        process.stdin.removeListener('data', initialListener);
        gameProcess.stdout.removeListener('data', filter);
        gameProcess.stderr.removeListener('data', filter);
        process.stdin.on('data', function (text) {
            ws.send(createPacket(text));
        });
    });

    ws.on("message", function (data, flags) {
        try {
            var json = JSON.parse(data);
            if (json && json.Message) {
                console.log(json.Message);
                fs.appendFile("latest.log", "\n" + json.Message, (err) => {
                    if (err) console.log("Callback error in appendFile:" + err);
                });
            } else {
                console.log("Error: Invalid JSON received");
            }
        } catch (e) {
            console.log(e);
        }
    });

    ws.on("error", function (err) {
        const now = Date.now();
        if (!waitingStart) {
            // First failure: start timer
            waitingStart = now;
            console.log("Waiting to connect RCON...");
            setTimeout(poll, 5000);
        } else if (now - waitingStart >= WAIT_THRESHOLD) {
            console.log(`🔥 WAIT_THRESHOLD of ${WAIT_THRESHOLD} ms exceeded, forcing exit for restart…`);
            process.exit(1);
        } else {
            // Second failure but under threshold: retry once more
            console.log("Waiting to connect RCON... (retry)");
            hasRetried = true;
            setTimeout(poll, 5000);
        }
    });

    ws.on("close", function () {
        if (!waiting) {
            console.log("Connection to server closed.");
            exited = true;
            process.exit();
        }
    });
};

poll();
