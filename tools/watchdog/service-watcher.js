#!/usr/bin/env node
/**
 * Continuous service watcher (EV3 ev3_service_watcher.py port).
 * Polls HTTP/TCP health checks and optionally runs restart commands.
 *
 * Usage:
 *   node tools/watchdog/service-watcher.js
 *   node tools/watchdog/service-watcher.js --config tools/watchdog/services.json
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { exec } = require('child_process');

function loadConfig(configPath) {
  const resolved = path.resolve(configPath);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function configureLogging(rootDir, relativeLogPath) {
  const logPath = path.resolve(rootDir, relativeLogPath);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  return (message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  };
}

async function checkHttp(healthCheck) {
  const expected = new Set(healthCheck.expected_status_codes || [200]);
  const response = await fetch(healthCheck.url, {
    signal: AbortSignal.timeout(Number(healthCheck.timeout_seconds || 3) * 1000),
  });
  return expected.has(response.status)
    ? { ok: true, reason: `HTTP ${response.status}` }
    : { ok: false, reason: `Unexpected HTTP ${response.status}` };
}

function checkTcp(healthCheck) {
  const timeoutMs = Number(healthCheck.timeout_seconds || 3) * 1000;
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: healthCheck.host,
      port: Number(healthCheck.port),
      timeout: timeoutMs,
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve({ ok: true, reason: 'TCP socket open' });
    });
    socket.once('error', () => resolve({ ok: false, reason: 'TCP connection failed' }));
    socket.once('timeout', () => {
      socket.destroy();
      resolve({ ok: false, reason: 'TCP timeout' });
    });
  });
}

async function runHealthCheck(service) {
  const healthCheck = service.health_check || {};
  if (healthCheck.type === 'http') return checkHttp(healthCheck);
  if (healthCheck.type === 'tcp') return checkTcp(healthCheck);
  return { ok: false, reason: `Unsupported health check type: ${healthCheck.type}` };
}

function runRestartCommand(command, log) {
  return new Promise((resolve) => {
    log(`Running restart command: ${command}`);
    exec(command, (error, stdout, stderr) => {
      if (error) {
        log(`Restart command failed: ${error.message}`);
        if (stderr) log(stderr.trim());
        resolve(false);
        return;
      }
      if (stdout) log(stdout.trim());
      resolve(true);
    });
  });
}

async function monitorServices(configPath) {
  const config = loadConfig(configPath);
  const rootDir = path.resolve(path.dirname(configPath), '../..');
  const log = configureLogging(rootDir, config.log_path || 'logs/watcher.log');
  const services = config.services || [];
  const failureCounts = Object.fromEntries(services.map((service) => [service.id, 0]));
  const pollInterval = Number(config.poll_interval_seconds || 20) * 1000;
  const restartCooldown = Number(config.restart_cooldown_seconds || 15) * 1000;

  log(`Service watcher starting with config ${configPath}`);

  while (true) {
    for (const service of services) {
      const { id, display_name: displayName = id } = service;
      const threshold = Number(service.failure_threshold || 3);

      try {
        const result = await runHealthCheck(service);
        if (result.ok) {
          if (failureCounts[id] > 0) {
            log(`${displayName} recovered: ${result.reason}`);
          }
          failureCounts[id] = 0;
        } else {
          failureCounts[id] += 1;
          log(`${displayName} health check failed (${failureCounts[id]}/${threshold}): ${result.reason}`);
        }

        if (failureCounts[id] >= threshold && service.restart_command) {
          await runRestartCommand(service.restart_command, log);
          log(`Waiting ${restartCooldown / 1000}s after restart of ${displayName}`);
          failureCounts[id] = 0;
          await new Promise((resolve) => setTimeout(resolve, restartCooldown));
        }
      } catch (err) {
        failureCounts[id] += 1;
        log(`Watcher error for ${displayName}: ${err.message}`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

const configArgIndex = process.argv.indexOf('--config');
const configPath = configArgIndex >= 0
  ? process.argv[configArgIndex + 1]
  : process.env.WATCHER_CONFIG || path.join(__dirname, 'services.json');

monitorServices(configPath).catch((err) => {
  console.error(err);
  process.exit(1);
});
