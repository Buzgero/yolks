#!/usr/bin/env node

const fs = require("fs");
const { exec } = require("child_process");
const WebSocket = require("ws");

const MAX_IDLE = 30 * 1000; // 30 segundos en ms
const WATCHDOG_INTERVAL = 5 * 1000; // cada 30s

// --------------------------------------------------
// Variables de control
// --------------------------------------------------
let startupCmd = "";
let gameProcess = null;
let rconConnected = false;
let lastRconAttempt = Date.now();
let lastOutputTime   = Date.now();

// --------------------------------------------------
// Reinicio: mata el juego y sale con código 1
// --------------------------------------------------
function restartServer(reason) {
  console.error(`[Watchdog] ${reason}. Reiniciando servidor...`);
  if (gameProcess && !gameProcess.killed) {
    gameProcess.kill('SIGTERM');
  }
  // Salimos para que Pterodactyl detecte “crash” y haga el restart
  process.exit(1);
}

// --------------------------------------------------
// Filtro de stdout/stderr del juego
// --------------------------------------------------
const seenPercentage = {};
function filter(data) {
  const str = data.toString();
  // Cada vez que hay salida, actualizamos el timestamp
  lastOutputTime = Date.now();

  if (str.startsWith("Loading Prefab Bundle ")) {
    const pct = str.slice("Loading Prefab Bundle ".length);
    if (seenPercentage[pct]) return;
    seenPercentage[pct] = true;
  }

  console.log(str);
}

// --------------------------------------------------
// Lee el comando de arranque
// --------------------------------------------------
fs.writeFileSync("latest.log", "");
const args = process.argv.slice(process.execArgv.length + 2);
if (args.length === 0) {
  console.error("Error: Please specify a startup command.");
  process.exit(1);
}
startupCmd = args.join(" ");

console.log("Starting Rust...");

// --------------------------------------------------
// Función para arrancar el proceso de juego
// --------------------------------------------------
function spawnGame() {
  gameProcess = exec(startupCmd);
  rconConnected = false;
  lastRconAttempt = Date.now();
  lastOutputTime   = Date.now();

  gameProcess.stdout.on('data', filter);
  gameProcess.stderr.on('data', filter);

  gameProcess.on('exit', (code, signal) => {
    console.log(`Main game process exited with code ${code} / signal ${signal}`);
    // Aquí no salimos: confiamos en el watchdog para reiniciar
  });
}
spawnGame();

// --------------------------------------------------
// Manejo de stdin pre-RCON
// --------------------------------------------------
function initialListener(data) {
  const cmd = data.toString().trim();
  console.log(`Unable to run "${cmd}" — RCON not connected yet.`);
}
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on('data', initialListener);

// --------------------------------------------------
// Ciclo de conexión RCON
// --------------------------------------------------
function pollRcon() {
  lastRconAttempt = Date.now();

  const packet = (command) => JSON.stringify({
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
    ws.send(packet('status'));
    // Cambiamos el listener de stdin para enviarlo a RCON
    process.stdin.removeListener('data', initialListener);
    gameProcess.stdout.removeListener('data', filter);
    gameProcess.stderr.removeListener('data', filter);
    process.stdin.on('data', text => ws.send(packet(text)));
  });

  ws.on("message", (data) => {
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

  ws.on("error", (err) => {
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

// --------------------------------------------------
// Watchdog: comprueba cada 30s si toca reiniciar
// --------------------------------------------------
setInterval(() => {
  const now = Date.now();

  // 1) Nunca llegó a conectar RCON en 5 min
  if (!rconConnected && now - lastRconAttempt > MAX_IDLE) {
    restartServer("Timeout RCON (>5m sin conectar)");
  }

  // 2) No hubo salida de juego ni RCON en 5 min
  if (now - lastOutputTime > MAX_IDLE) {
    restartServer("Sin output (>5m)");
  }
}, WATCHDOG_INTERVAL);
