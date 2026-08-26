{
  "targets": [
    {
      "target_name": "win_app_audio",
      "include_dirs": ["<!(node -p \"require('path').dirname(require.resolve('node-addon-api/package.json'))\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/addon.cc"],
          "defines": ["UNICODE", "_UNICODE", "NOMINMAX", "WIN32_LEAN_AND_MEAN"],
          "libraries": ["-lmmdevapi.lib", "-lole32.lib", "-loleaut32.lib", "-luser32.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }],
        ["OS!='win'", {
          "sources": ["src/stub.cc"],
          "cflags_cc": ["-std=c++17"],
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "10.15"
          }
        }]
      ]
    }
  ]
}
