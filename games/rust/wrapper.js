#!/usr/bin/env node


const fs = require("fs");
const { exec } = require("child_process");
const WebSocket = require("ws");

const MAX_IDLE = 5 * 60 * 1000;  // 5m
const WATCHDOG_INTERVAL = 60 * 1000; // 1m 


let startupCmd    = "";
let gameProcess   = null;
let rconConnected = false;


let rconStartTime = Date.now();


let lastOutputTime = Date.now();


function restartServer(reason) {
  console.error(`[Watchdog] ${reason}. Reiniciando servidor...`);
  if (gameProcess && !gameProcess.killed) {
    gameProcess.kill('SIGTERM');
  }
  process.exit(1);
}

const seenPercentage = {};
function filter(data) {
  const str = data.toString();
  lastOutputTime = Date.now();

  if (str.startsWith("Loading Prefab Bundle ")) {
    const pct = str.slice("Loading Prefab Bundle ".length);
    if (seenPercentage[pct]) return;
    seenPercentage[pct] = true;
  }

  console.log(str);
}


fs.writeFileSync("latest.log", "");

const args = process.argv.slice(process.execArgv.length + 2);
if (args.length === 0) {
  console.error("Error: Please specify a startup command.");
  process.exit(1);
}
startupCmd = args.join(" ");

console.log("Starting Rust...");


function spawnGame() {
  gameProcess = exec(startupCmd);
  rconConnected = false;

  lastOutputTime = Date.now();

  gameProcess.stdout.on('data', filter);
  gameProcess.stderr.on('data', filter);

  gameProcess.on('exit', (code, signal) => {
    console.log(`Main game process exited with code ${code}, signal ${signal}`);

  });
}
spawnGame();


function initialListener(data) {
  const cmd = data.toString().trim();
  console.log(`Unable to run "${cmd}" — RCON not connected yet.`);
}
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on('data', initialListener);


function pollRcon() {
  const packet = command => JSON.stringify({
    Identifier: -1,
    Message:   command,
    Name:      "WebRcon"
  });

  const host = process.env.RCON_IP   || "localhost";
  const port = process.env.RCON_PORT;
  const pass = process.env.RCON_PASS;
  const ws   = new WebSocket(`ws://${host}:${port}/${pass}`);

  ws.on("open", () => {
    console.log("Connected to RCON. Server status → Running.");
    rconConnected = true;
    lastOutputTime = Date.now();
    ws.send(packet('status'));


    process.stdin.removeListener('data', initialListener);
    gameProcess.stdout.removeListener('data', filter);
    gameProcess.stderr.removeListener('data', filter);
    process.stdin.on('data', text => {
      lastOutputTime = Date.now();
      ws.send(packet(text));
    });
  });

  ws.on("message", data => {
    try {
      const json = JSON.parse(data);
      if (json.Message) {
        console.log(json.Message);
        lastOutputTime = Date.now();
        fs.appendFile("latest.log", "\n" + json.Message, err => {
          if (err) console.error("AppendFile error:", err);
        });
      }
    } catch (e) {
      console.error("Invalid JSON from RCON:", e);
    }
  });

  ws.on("error", () => {
    console.log("Waiting for RCON to come up...");
    setTimeout(pollRcon, 5000);
  });

  ws.on("close", () => {
    if (rconConnected) {
      console.log("RCON connection closed unexpectedly.");
      restartServer("RCON disconnect");
    }
  });
}
pollRcon();


setInterval(() => {
  const now = Date.now();

  if (!rconConnected && now - rconStartTime > MAX_IDLE) {
    restartServer(`Timeout RCON (> ${MAX_IDLE/1000}s sin conectar)`);
  }


  if (now - lastOutputTime > MAX_IDLE) {
    restartServer(`Sin output (> ${MAX_IDLE/1000}s)`);
  }
}, WATCHDOG_INTERVAL);
