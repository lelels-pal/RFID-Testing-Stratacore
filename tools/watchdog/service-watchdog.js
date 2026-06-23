#!/usr/bin/env node
/**
 * External service watchdog (EV3 service_watchdog.py port).
 * Run on a schedule (e.g. every 5 minutes) to verify critical dependencies.
 *
 * Usage:
 *   node tools/watchdog/service-watchdog.js
 */

const fs = require('fs');
const net = require('net');
const path = require('path');

const LOG_FILE = process.env.WATCHDOG_LOG_FILE
  || path.join(process.cwd(), 'apps', 'backend', 'logs', 'watchdog.log');

const API_URL = process.env.WATCHDOG_API_URL || 'http://127.0.0.1:4001/api/health';
const OCPP_HOST = process.env.WATCHDOG_OCPP_HOST || '127.0.0.1';
const OCPP_PORT = Number(process.env.WATCHDOG_OCPP_PORT || process.env.OCPP_WS_PORT || 9000);

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch {
    // ignore log write failures
  }
}

async function checkHttp(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  return response.ok;
}

function checkTcp(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 3000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function main() {
  log('='.repeat(50));
  log('Stratacore Service Watchdog Starting');
  log('='.repeat(50));

  let allOk = true;

  try {
    const apiOk = await checkHttp(API_URL);
    log(`Backend API (${API_URL}): ${apiOk ? 'OK' : 'FAILED'}`);
    if (!apiOk) allOk = false;
  } catch (err) {
    log(`Backend API check error: ${err.message}`);
    allOk = false;
  }

  try {
    const ocppOk = await checkTcp(OCPP_HOST, OCPP_PORT);
    log(`OCPP TCP (${OCPP_HOST}:${OCPP_PORT}): ${ocppOk ? 'OK' : 'FAILED'}`);
    if (!ocppOk) allOk = false;
  } catch (err) {
    log(`OCPP TCP check error: ${err.message}`);
    allOk = false;
  }

  log('='.repeat(50));
  log(allOk ? 'All services healthy' : 'WARNING: Some services had issues');
  log('='.repeat(50));

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  log(`Fatal watchdog error: ${err.message}`);
  process.exit(1);
});
