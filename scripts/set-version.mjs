/* 打包前把版本号写进 android/app/build.gradle。

   · 本机（不带 build 号）：versionName = package.json 的 version，versionCode = 100000
   · CI（带 build 号，workflow 里给 JISHIBEN_BUILD = run_number）：
     versionName = "<version>-build.<n>"，versionCode = 100000 + n

   于是每次 Release 的版本号都不一样，手机「应用信息」里一眼能看出装的是哪一版；
   versionCode 只增不减，覆盖安装不会因为降级被拦。

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
    name: seq ? `${version}-build.${seq}` : version,
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

/* 只有直接执行（npm run apk / CI）才动文件；被冒烟测试 import 时什么都不做 */
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const { code, name } = resolveVersion(pkg.version, process.argv[2] ?? process.env.JISHIBEN_BUILD ?? '');
  writeFileSync(GRADLE, applyVersion(readFileSync(GRADLE, 'utf8'), code, name));
  console.log(`[版本] ${name}（versionCode ${code}）→ android/app/build.gradle`);
}
