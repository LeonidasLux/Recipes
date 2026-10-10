package com.leonidaslux.jishiben;

import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 应用内更新：设置页「关于」里点「下载并安装」时走这里。
 *
 * 包是从 GitHub Release 上装的，手工流程是「开浏览器 → 找最新 Release → 下载 → 点安装」。
 * 这里把那几步搬到应用里：把 Release 附件下到应用自己的缓存目录，再拉起系统安装器。
 *
 * 三件事：
 *   · canInstall / openInstallSettings —— Android 8 起，装 APK 要先在系统里允许本应用
 *     「安装未知应用」（AndroidManifest 里的 REQUEST_INSTALL_PACKAGES 只是声明，开关归用户）；
 *   · downloadAndInstall —— 下载（进度用 `progress` 事件回传）+ 拉起安装器；
 *   · 安装走 FileProvider 的 content:// 地址 —— Android 7 起不允许把 file:// 交给别的应用。
 *
 * 为什么手写本地插件、不引 @capacitor/filesystem + 某个安装插件：这里只有一件事要做，
 * 少两个 npm 依赖。插件在 MainActivity 里注册即可，不需要 cap sync。
 * 包固定叫 jishiben-update.apk，每次更新覆盖同一个文件，不额外占空间。
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    /** 下载好的 APK 固定放这个文件名，下一次更新直接覆盖 */
    private static final String APK_NAME = "jishiben-update.apk";
    private static final String APK_MIME = "application/vnd.android.package-archive";
    /** 与 AndroidManifest 里 provider 的 `android:authorities="${applicationId}.fileprovider"` 对应 */
    private static final String FILE_PROVIDER_SUFFIX = ".fileprovider";
    /** 连接 / 读流超时（毫秒）：Release 附件在 GitHub 的 CDN 上，一般几秒到几十秒下完 */
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;

    /** 系统允不允许本应用装包（Android 8 以下没有这个开关，一律算允许） */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("allowed", canRequestInstalls());
        call.resolve(ret);
    }

    /** 没授权时把用户送到系统的「安装未知应用」开关页（Android 8 以下不用开，直接 resolve） */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.resolve();
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("打不开系统设置，请到「设置 → 应用 → 特殊权限」里手动允许安装");
        }
    }

    /**
     * 下载 APK 并拉起系统安装器。
     * 插件方法本身跑在 Capacitor 的插件线程（不是 UI 线程），所以同步下载不会卡住界面。
     */
    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("没有拿到安装包的下载地址");
            return;
        }
        try {
            File apk = download(url);
            launchInstaller(apk);
            JSObject ret = new JSObject();
            ret.put("path", apk.getAbsolutePath());
            ret.put("bytes", apk.length());
            call.resolve(ret);
        } catch (Exception e) {
            String msg = e.getMessage();
            call.reject(msg == null || msg.isEmpty() ? "下载安装包失败，检查网络后重试" : msg);
        }
    }

    private boolean canRequestInstalls() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return getContext().getPackageManager().canRequestPackageInstalls();
        }
        return true;
    }

    /** 下到应用缓存目录；中途失败只留下 `.part`，不会被当成一个完整的包 */
    private File download(String url) throws Exception {
        File apk = new File(getContext().getCacheDir(), APK_NAME);
        File part = new File(getContext().getCacheDir(), APK_NAME + ".part");
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestProperty("User-Agent", "jishiben-android-updater");
            conn.setRequestProperty("Accept", "application/octet-stream");
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new Exception("下载失败（GitHub 返回 " + code + "）");
            }
            long total = conn.getContentLength();
            long got = 0;
            long lastNotify = 0L;
            InputStream in = conn.getInputStream();
            try {
                FileOutputStream out = new FileOutputStream(part);
                try {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        got += n;
                        long now = System.currentTimeMillis();
                        if (now - lastNotify >= 200L || (total > 0 && got >= total)) {
                            lastNotify = now;
                            notifyProgress(got, total);
                        }
                    }
                    out.flush();
                } finally {
                    out.close();
                }
            } finally {
                in.close();
            }
            if (got <= 0 || !looksLikeZip(part)) {
                throw new Exception("下载到的不是安装包，可能被网络挡了，稍后重试");
            }
            if (apk.exists() && !apk.delete()) {
                throw new Exception("清不掉上一次的安装包，重启应用后再试");
            }
            if (!part.renameTo(apk)) {
                throw new Exception("安装包落地失败，稍后重试");
            }
            return apk;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
            /* 成功路径上 part 已经改名走了；失败路径上把半截包删掉，别占着空间 */
            if (part.exists()) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
            }
        }
    }

    /** APK 就是个 zip：开头两个字节是 'P' 'K'。用来挡住「下回来一个 HTML 错误页」 */
    private boolean looksLikeZip(File f) {
        FileInputStream in = null;
        try {
            in = new FileInputStream(f);
            int b0 = in.read();
            int b1 = in.read();
            return b0 == 0x50 && b1 == 0x4B;
        } catch (Exception e) {
            return false;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Exception ignored) {
                    /* 关不掉也不影响判断 */
                }
            }
        }
    }

    private void notifyProgress(long received, long total) {
        JSObject data = new JSObject();
        data.put("received", (double) received);
        data.put("total", (double) total);
        data.put("percent", total > 0 ? (int) Math.min(100L, received * 100L / total) : -1);
        notifyListeners("progress", data);
    }

    /** content:// 交给系统安装器（Android 7 起 file:// 会被 FileUriExposedException 拦下） */
    private void launchInstaller(File apk) {
        Context ctx = getContext();
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + FILE_PROVIDER_SUFFIX, apk);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, APK_MIME);
        /* 有些机型只认 intent data 上的授权，带上 ClipData 稳妥一点 */
        intent.setClipData(ClipData.newRawUri("jishiben-update", uri));
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(intent);
    }
}
