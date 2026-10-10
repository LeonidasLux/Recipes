/* 打包前把版本号写进 android/app/build.gradle。

   · versionName 一律就是 package.json 的 version（`1.0.1` / `1.1.2` 这种），本机与 CI 一样 ——
     发版只改 package.json，手机「应用信息」与应用内「关于」看到的是同一个号，不带任何后缀。
   · versionCode 才是「只增不减」的那一个（Android 覆盖安装 / 升级看的是它，不是 versionName）：
     本机（不带 build 号）固定基准 100000，CI（workflow 里给 JISHIBEN_BUILD = run_number）是 100000 + n。
     所以同一个 version 重复出包也照样能覆盖安装，而版本号不会多出后缀。

   用法：node scripts/set-version.mjs [buildNumber]（也可以走环境变量 JISHIBEN_BUILD）。 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GRADLE = path.join(ROOT, 'android/app/build.gradle');

/** 本机不带 build 号时的 versionCode 基准 */
export const BASE_VERSION_CODE = 100000;

/** 由 package.json 的 version 和构建序号算出要写进 Gradle 的 versionCode / versionName */
export function resolveVersion(version, build) {
  const n = Number(build);
  const seq = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return {
    code: BASE_VERSION_CODE + seq,
    name: version,
  };
}

/** 改写 build.gradle 里的 versionCode / versionName 两行，返回新内容 */
export function applyVersion(gradle, code, name) {
  if (!/versionCode\s+\d+/.test(gradle) || !/versionName\s+"[^"]*"/.test(gradle)) {
    throw new Error('android/app/build.gradle 里找不到 versionCode / versionName');
  }
  return gradle
    .replace(/versionCode\s+\d+/, `versionCode ${code}`)
    .replace(/versionName\s+"[^"]*"/, `versionName "${name}"`);
}

/* 只有直接执行（npm run apk / CI）才动文件；被冒烟测试 import 时什么都不做。
   不能只看「argv[1] 是否等于 import.meta.url」—— 冒烟会把本文件打进 .tmp/smoke.mjs，
   那时两者指的是同一个 bundle 路径，照样会去改写 android/app/build.gradle。 */
const SELF = fileURLToPath(import.meta.url);
const isMain =
  Boolean(process.argv[1]) &&
  /set-version\.mjs$/.test(SELF) &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const { code, name } = resolveVersion(pkg.version, process.argv[2] ?? process.env.JISHIBEN_BUILD ?? '');
  writeFileSync(GRADLE, applyVersion(readFileSync(GRADLE, 'utf8'), code, name));
  console.log(`[版本] ${name}（versionCode ${code}）→ android/app/build.gradle`);
}
