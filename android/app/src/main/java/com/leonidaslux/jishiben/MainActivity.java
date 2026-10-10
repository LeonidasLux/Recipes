package com.leonidaslux.jishiben;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        /* 应用内更新插件写在 android/ 里（没有 npm 包），必须在 super.onCreate 之前注册 ——
           Bridge 是在那里面按 bridgeBuilder 建起来的。 */
        registerPlugin(AppUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
