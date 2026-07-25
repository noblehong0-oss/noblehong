#!/usr/bin/env node
// 노블홍 iMac Meta 리드 폴러 배포.
// .env.imac.local(로컬, git 제외)에서 허용 키만 골라 아이맥으로 보내고 LaunchAgent를 설치한다.
//
//   node deploy.mjs                 드라이런 — 전송 없이 준비상태만 점검
//   node deploy.mjs --run           파일·plist 설치까지 (폴링은 아직 시작 안 함)
//   node deploy.mjs --run --start   설치 + LaunchAgent 기동 → 이 순간부터 실제 접수 시작
//   IMAC_HOST=imac node deploy.mjs --run --start
//
// --start 를 분리한 이유: bootstrap 하는 순간 RunAtLoad 로 즉시 1회 폴링이 돌아
// 진짜 리드가 워커로 들어간다. 전환 시점을 사람이 정하도록 기본값에서 뺐다.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, ".env.imac.local");
const workerFile = resolve(here, "worker.mjs");
const plistFile = resolve(here, "com.noblehong.meta-lead-poller.plist");
const host = process.env.IMAC_HOST || "imac";
const remoteDir = "/Users/pola/noblehong-meta-lead-poller";
const launchDir = "/Users/pola/Library/LaunchAgents";
const label = "com.noblehong.meta-lead-poller";
const plistName = `${label}.plist`;
const remoteWorkerStage = `${remoteDir}/worker.new.mjs`;
const remotePlistStage = `${launchDir}/${label}.new.plist`;
const run = process.argv.includes("--run");
const start = process.argv.includes("--start");

for (const path of [workerFile, plistFile, envPath]) {
  if (!existsSync(path)) throw new Error(`필수 파일 없음: ${path}`);
}

function parseEnv(path) {
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // 값 끝 개행/공백은 시크릿 비교를 조용히 깨뜨린다 — 여기서 잡는다
    if (/\r|\n/.test(value)) throw new Error(`${match[1]} 값에 개행이 있습니다.`);
    values[match[1]] = value;
  }
  return values;
}

const sourceEnv = parseEnv(envPath);
const required = [
  "META_SYSTEM_USER_TOKEN",
  "META_LEAD_FORM_IDS",
  "META_LEAD_CUTOVER_AT",
  "LEAD_WEBHOOK_URL",
  "LEAD_WEBHOOK_SECRET",
  "HEALTH_TELEGRAM_BOT_TOKEN",
  "HEALTH_TELEGRAM_CHAT_ID",
];
for (const key of required) {
  if (!sourceEnv[key]) throw new Error(`${key} 누락: ${envPath}`);
}
if (!Number.isFinite(Date.parse(sourceEnv.META_LEAD_CUTOVER_AT))) {
  throw new Error("META_LEAD_CUTOVER_AT 은 ISO 날짜여야 합니다 (Make OFF 시각).");
}

const allowed = [
  ...required,
  "LEAD_HEARTBEAT_URL",
  "META_APP_SECRET",
  "META_GRAPH_VERSION",
  "META_LEAD_LOOKBACK_HOURS",
  "META_LEAD_OVERLAP_HOURS",
  "META_LEAD_MAX_PAGES",
  "META_LEAD_HEALTH_QUIET_HOURS",
  "META_LEAD_HEALTH_ALWAYS",
  "META_LEAD_STATE_FILE",
  "META_LEAD_DRY_RUN",
];
const remoteEnv = `${allowed
  .filter((key) => sourceEnv[key] !== undefined && sourceEnv[key] !== "")
  .map((key) => `${key}=${sourceEnv[key]}`)
  .join("\n")}\n`;

function exec(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

if (!run) {
  console.log("[dry-run] 노블홍 iMac Meta 리드 폴러 — 배포 준비 완료");
  console.log(`  host      = ${host}`);
  console.log(`  remote    = ${remoteDir}`);
  console.log(`  cutover   = ${sourceEnv.META_LEAD_CUTOVER_AT}`);
  console.log(`  forms     = ${sourceEnv.META_LEAD_FORM_IDS}`);
  console.log(
    `  envKeys   = ${allowed.filter((key) => sourceEnv[key]).join(",")}`,
  );
  console.log("  실제 배포 : node deploy.mjs --run        (설치만)");
  console.log("  전환 시작 : node deploy.mjs --run --start (폴링 개시)");
  process.exit(0);
}

exec("ssh", [host, `mkdir -p ${remoteDir}/logs`]);
exec("scp", [workerFile, `${host}:${remoteWorkerStage}`]);
exec("scp", [plistFile, `${host}:${remotePlistStage}`]);
execFileSync(
  "ssh",
  [
    host,
    `umask 077; cat > ${remoteDir}/.env.new; mv ${remoteDir}/.env.new ${remoteDir}/.env`,
  ],
  { input: remoteEnv, stdio: ["pipe", "inherit", "inherit"] },
);
// 원격에서 문법·plist 검증을 통과한 뒤에만 실제 경로로 옮긴다 (반쯤 깨진 배포 방지)
exec("ssh", [
  host,
  [
    "set -e",
    `/usr/local/bin/node --check ${remoteWorkerStage}`,
    `plutil -lint ${remotePlistStage}`,
    `mv ${remoteWorkerStage} ${remoteDir}/worker.mjs`,
    `mv ${remotePlistStage} ${launchDir}/${plistName}`,
  ].join("; "),
]);
console.log("[deploy] 파일·plist 설치 완료");

if (!start) {
  console.log("[deploy] LaunchAgent 미기동 — 폴링은 아직 시작되지 않았습니다.");
  console.log(`         전환 준비되면: node deploy.mjs --run --start`);
  process.exit(0);
}

exec("ssh", [
  host,
  [
    "set -e",
    `launchctl bootout gui/501 ${launchDir}/${plistName} 2>/dev/null || true`,
    `launchctl bootstrap gui/501 ${launchDir}/${plistName}`,
    `launchctl kickstart -k gui/501/${label}`,
  ].join("; "),
]);
console.log("[deploy] LaunchAgent 기동 완료 — 1시간 주기 폴링 시작");
