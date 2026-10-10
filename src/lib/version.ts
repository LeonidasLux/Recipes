import { version } from '../../package.json';

/**
 * 应用版本号：唯一来源是根目录 `package.json` 的 `version`。
 *
 * 在这里读而不是手写一个常量，是因为发版时只改 `package.json`（`scripts/set-version.mjs`
 * 也拿它写 `android/app/build.gradle` 的 versionName）—— 手写就会跟打包用的版本号分家。
 * 设置页「关于」弹窗展示它。
 */
export const APP_VERSION = version;
